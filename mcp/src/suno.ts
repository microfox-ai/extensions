// Suno through Browse Hack, on this server's side. The extension does what
// happens on suno.com (get-into-zone/lib/sunoBridge.ts): it fills Suno's own
// Create form and clicks Create, reads songs through the site's API and clicks
// a song's Download. Here the tools check a request, find the channel and its
// Suno workspace, hand a library track to the extension for a cover, wait for
// the songs, record them in MediaMake cloud under the channel's project, and
// download the keepers into MediaMake's library inbox
// (_INBOX/suno/<channel>/<set>/) with a <file>.source.json beside each, ready
// for `media ingest`.

import { open, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, isAbsolute, resolve } from "node:path"

import type { Bridge } from "./bridge.js"
import {
  downloadsFolder,
  findMedia,
  hasLibrary,
  inboxFolder,
  lookupItem,
  readChannels,
  readLibrary,
  writeSidecar,
  type Library,
  type SourceFields
} from "./library.js"

// --- Songs as the extension returns them (get-into-zone/lib/suno/clip.ts) ---------

export interface SunoSong {
  id: string
  title: string
  status: string
  styles: string
  excludeStyles?: string
  lyrics: string
  instrumental: boolean
  model: string
  duration?: number
  settings: Record<string, unknown>
  task?: string
  parent?: { id: string; relation: string }
  root?: { id: string; title?: string }
  workspace?: { id: string; name: string }
  audioUrl?: string
  imageUrl?: string
  pageUrl: string
  author?: string
  createdAt?: string
  /** Downloaded before: downloading it again uses none of the month's downloads. */
  downloadUnlocked?: boolean
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const SHA256 = /^[0-9a-f]{64}$/i

/** A clip id from an id or a suno.com / cdn1.suno.ai link. */
export const clipIdOf = (value: string) => value.trim().match(UUID)?.[0].toLowerCase()

/** Same as songFileBase in get-into-zone/lib/suno/clip.ts: "<Title> [<first 8 of the id>]". */
export function songFileBase(song: Pick<SunoSong, "id" | "title">) {
  const title = (song.title || "Untitled")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120)
  return `${title || "Untitled"} [${song.id.slice(0, 8)}]`
}

/** Same as songSet in get-into-zone/lib/sunoPrefs.ts: a folder for a song's takes. */
export const songSet = (title: string) =>
  title
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+-\s+/)
    .slice(0, 2)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "songs"

const isFinished = (song: Pick<SunoSong, "status">) => song.status === "complete" || song.status === "error"

/** Model names as Suno's menu, its API and a request spell them, made comparable: "V6 Wild" = v6-wild. */
const modelKey = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase().replace(/[\s_]+/g, "-")
export const sameModel = (a: string | undefined, b: string | undefined) => !!a && !!b && modelKey(a) === modelKey(b)

/** The finished songs that weren't made on `model`: Suno's Create went out on another one. */
export function wrongModel(songs: SunoSong[], model: string | undefined) {
  if (!model) return []
  return songs.filter((s) => s.status === "complete" && s.model && !sameModel(s.model, model))
}

/** One line for a log or an error: which songs came out on which model instead. */
export const wrongModelText = (songs: SunoSong[], model: string) =>
  `made on ${[...new Set(songs.map((s) => s.model))].join(", ")}, not ${model} (${songs.map((s) => s.id).join(", ")})`

// --- Requests -------------------------------------------------------------------------

export interface SongParams {
  lyrics?: string
  instrumental?: boolean
  styles?: string
  excludeStyles?: string
  title?: string
  model?: string
  vocalGender?: "male" | "female"
  weirdness?: number
  styleInfluence?: number
  audioInfluence?: number
  variety?: number
  maxMode?: boolean
  /** Suno workspace: id or name. Default: the channel's, else Suno's current one. */
  workspace?: string
  /** MediaMake channel (library channel id, e.g. animemusiczone). */
  channel?: string
  /** Folder for the downloads under _INBOX/suno/<channel>/. Default: from the title. */
  set?: string
  wait?: boolean
  timeoutMs?: number
  /** none / keepers: nothing downloads now (save keepers later); all: every finished take. */
  download?: "none" | "keepers" | "all"
  waitForUserMs?: number
}

export type CoverKind = "cover" | "extend" | "mashup" | "sample" | "inspo"

export interface CoverParams extends SongParams {
  /** A Suno song (id or link), a MediaMake library item id (SHA-256), or an audio file's absolute path. */
  from: string
  kind?: CoverKind
  extendFrom?: number
  /** The user owns or licenses this audio (needed for a file MediaMake has no rights for). */
  rightsConfirmed?: boolean
}

const LIMITS = { styles: 1000, excludeStyles: 1000, title: 100, lyrics: 5000 }

/** What's wrong with a request, before anything reaches Suno. */
export function checkSong(params: SongParams, needsContent: boolean) {
  const errors: string[] = []
  for (const [key, max] of Object.entries(LIMITS) as [keyof typeof LIMITS, number][]) {
    const value = params[key]
    if (typeof value === "string" && value.length > max) errors.push(`${key} is ${value.length} characters; Suno takes at most ${max}.`)
  }
  for (const key of ["weirdness", "styleInfluence", "audioInfluence"] as const) {
    const value = params[key]
    if (value !== undefined && !(Number.isFinite(value) && value >= 0 && value <= 100)) errors.push(`${key} must be 0-100.`)
  }
  if (params.instrumental && params.lyrics?.trim()) errors.push("Give lyrics or instrumental: true, not both.")
  if (needsContent && !params.lyrics?.trim() && !params.instrumental && !params.styles?.trim()) {
    errors.push("A new song needs lyrics, styles, or instrumental: true.")
  }
  return errors
}

/** The Create form fields for the extension (get-into-zone/lib/suno/form.ts SunoFormJob). */
export function formJob(params: SongParams & { extendFrom?: number }, workspaceName?: string) {
  const job: Record<string, unknown> = {
    lyrics: params.lyrics,
    instrumental: params.instrumental,
    styles: params.styles,
    excludeStyles: params.excludeStyles,
    title: params.title,
    model: params.model,
    vocalGender: params.vocalGender,
    weirdness: params.weirdness,
    styleInfluence: params.styleInfluence,
    audioInfluence: params.audioInfluence,
    variety: params.variety,
    maxMode: params.maxMode,
    extendFrom: params.extendFrom,
    workspaceName
  }
  return Object.fromEntries(Object.entries(job).filter(([, v]) => v !== undefined))
}

// --- Channels, workspaces and the library ---------------------------------------------------

interface Prefs {
  channels: { id: string; folder?: string; workspaceId?: string; workspaceName?: string; projectId?: string }[]
  inboxFolder: string
  downloadFormat: "mp3" | "wav"
}

let synced = ""

/** Passes the library's inbox and channels to the extension, so the buttons on suno.com use them too. */
async function syncLibrary(bridge: Bridge, lib: Library): Promise<Prefs> {
  const inbox = inboxFolder(lib)
  const channels = readChannels(lib.home)
  const key = JSON.stringify([inbox, channels])
  if (key !== synced && (inbox || channels.length)) {
    await bridge.call("suno.syncLibrary", { inboxFolder: inbox, channels }, 30_000).catch(() => {})
    synced = key
  }
  return (await bridge.call("suno.prefs", {}, 30_000)) as Prefs
}

interface Context {
  prefs: Prefs
  lib: Library
  channel?: string
  workspaceId?: string
  workspaceName?: string
  warnings: string[]
}

async function context(bridge: Bridge, params: { channel?: string; workspace?: string }): Promise<Context> {
  const lib = readLibrary()
  const prefs = await syncLibrary(bridge, lib)
  const warnings: string[] = []
  const wanted = params.channel?.trim().toLowerCase()
  const channel = wanted
    ? prefs.channels.find((c) => c.id.toLowerCase() === wanted || c.folder?.toLowerCase() === wanted)
    : undefined
  if (wanted && !channel) {
    warnings.push(`"${params.channel}" isn't one of MediaMake's channels (${prefs.channels.map((c) => c.id).join(", ") || "none yet"}).`)
  }

  let workspaceId: string | undefined
  let workspaceName: string | undefined
  if (params.workspace?.trim()) {
    const want = params.workspace.trim()
    if (UUID.test(want) || want === "default") workspaceId = want
    else {
      const { workspaces } = (await bridge.call("suno.workspaces", {}, 90_000)) as { workspaces: { id: string; name: string }[] }
      const hit = workspaces.find((w) => w.name.toLowerCase() === want.toLowerCase())
      if (!hit) throw new Error(`No Suno workspace named "${want}". Workspaces: ${workspaces.map((w) => w.name).join(", ")}.`)
      workspaceId = hit.id
      workspaceName = hit.name
    }
  } else if (channel?.workspaceId) {
    workspaceId = channel.workspaceId
    workspaceName = channel.workspaceName
  }
  // The workspace a song lands in names its channel when none was given.
  const byWorkspace = !channel && workspaceId ? prefs.channels.find((c) => c.workspaceId === workspaceId) : undefined
  return { prefs, lib, channel: (channel ?? byWorkspace)?.id, workspaceId, workspaceName, warnings }
}

/** Where a channel's songs download: the library inbox's suno/<channel>/<set>, relative to Downloads. */
function songFolder(ctx: Pick<Context, "lib" | "prefs" | "channel">, set: string) {
  const parts = ["suno", ctx.channel, set].filter(Boolean) as string[]
  return inboxFolder(ctx.lib, ...parts) ?? downloadsFolder([ctx.prefs.inboxFolder || "_INBOX", ...parts].join("/"), ctx.lib.home)
}

// --- Waiting, recording, downloading ---------------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const POLL_MS = Number(process.env.BROWSE_HACK_SUNO_POLL_MS) || 10_000

export async function waitForSongs(bridge: Bridge, ids: string[], timeoutMs = 360_000) {
  const start = Date.now()
  for (;;) {
    const { songs } = (await bridge.call("suno.clips", { ids }, 90_000)) as { songs: SunoSong[] }
    if (songs.length >= ids.length && songs.every(isFinished)) return { songs, finished: true }
    if (Date.now() - start >= timeoutMs) return { songs, finished: false }
    await sleep(POLL_MS)
  }
}

const summary = (song: SunoSong) => ({
  id: song.id,
  title: song.title,
  status: song.status,
  model: song.model,
  duration: song.duration ? Math.round(song.duration) : undefined,
  styles: song.styles,
  parent: song.parent,
  workspace: song.workspace?.name,
  link: song.pageUrl
})

export function sourceFields(song: SunoSong, channel?: string, sourceItem?: string): SourceFields {
  return {
    tool: "suno",
    ref: song.id,
    url: song.audioUrl,
    pageUrl: song.pageUrl,
    title: song.title,
    author: song.author,
    prompt: song.styles,
    model: song.model,
    lyrics: song.instrumental ? undefined : song.lyrics,
    excludeStyles: song.excludeStyles,
    instrumental: song.instrumental,
    settings: song.settings,
    parentRef: song.parent?.id,
    relation: song.parent?.relation,
    sourceItem,
    workspace: song.workspace,
    channel
  }
}

const INGEST =
  "File them with MediaMake's media library: mm media ingest (MediaMake's command; in the mediamake repo, npm run mm -- media ingest), " +
  "or let its watcher do it."

export interface DownloadParams {
  ids: string[]
  channel?: string
  set?: string
  format?: "mp3" | "wav"
  force?: boolean
  sourceItem?: string
}

/** Downloads songs into the library inbox through Suno's own Download (each uses one of the account's downloads). */
export async function downloadSongs(bridge: Bridge, params: DownloadParams) {
  const ids = [...new Set(params.ids.map((id) => clipIdOf(id) ?? id))]
  const ctx = await context(bridge, { channel: params.channel })
  const alreadyHave: { id: string; path: string }[] = []
  const wanted: string[] = []
  for (const id of ids) {
    const have = params.force ? undefined : await findMedia("suno", id, ctx.lib)
    if (have) alreadyHave.push({ id, path: have.path })
    else wanted.push(id)
  }
  if (!wanted.length) return { saved: [], alreadyHave, note: "The library already has these songs; nothing was downloaded." }

  const downloadsLeft = async () =>
    ((await bridge.call("suno.status", {}, 90_000)) as { account?: { downloads?: { left: number; limit: number } } }).account?.downloads
      ?.left
  const left = await downloadsLeft()
  const { songs } = (await bridge.call("suno.clips", { ids: wanted }, 90_000)) as { songs: SunoSong[] }
  // A song downloaded before is unlocked: it downloads again without using one.
  const needed = wanted.filter((id) => !songs.find((s) => s.id === id)?.downloadUnlocked).length
  if (left !== undefined && left < needed) {
    throw new Error(
      `Suno has ${left} downloads left this month and this needs ${needed}. Pick fewer songs, or buy more downloads on suno.com.`
    )
  }
  const saved: { id: string; title: string; path: string; sidecar?: string }[] = []
  const failed: { id: string; error: string }[] = []
  for (const id of wanted) {
    const song = songs.find((s) => s.id === id)
    if (!song) {
      failed.push({ id, error: "Suno doesn't have this song (or it isn't yours)." })
      continue
    }
    if (song.status !== "complete") {
      failed.push({ id, error: `It isn't finished yet (${song.status}).` })
      continue
    }
    const channel = ctx.channel ?? ctx.prefs.channels.find((c) => c.workspaceId === song.workspace?.id)?.id
    const folder = songFolder({ ...ctx, channel }, params.set || songSet(song.root?.title || song.title))
    try {
      const { path } = (await bridge.call(
        "suno.download",
        { clipId: id, folder, base: songFileBase(song), format: params.format ?? ctx.prefs.downloadFormat },
        15 * 60_000
      )) as { path: string }
      let sidecar: string | undefined
      if (hasLibrary(ctx.lib)) sidecar = writeSidecar(path, sourceFields(song, channel, params.sourceItem))
      saved.push({ id, title: song.title, path, sidecar })
      await bridge.call("suno.rate", { ref: id, rating: "keeper" }, 60_000).catch(() => {})
    } catch (error) {
      failed.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    saved,
    ...(alreadyHave.length ? { alreadyHave } : {}),
    ...(failed.length ? { failed } : {}),
    downloadsLeft: saved.length ? await downloadsLeft().catch(() => undefined) : left,
    ...(saved.length && hasLibrary(ctx.lib) ? { next: INGEST } : {})
  }
}

// --- Making songs ------------------------------------------------------------------------------

export interface Made {
  clipIds: string[]
  warnings?: string[]
  creditsBefore?: number
  /** The model the Create form showed as Create was clicked. */
  model?: string
  /** The vocal gender Suno's own Create request asked for (male, female or none), read in the page by Browse Hack 0.19.1+. */
  vocalGender?: string
}

// Suno's Create form is one shared page in Browse Hack's Suno tab: a fill
// started while another Create is still being confirmed would race it for the
// model, the lyrics and the workspace. Every Create from this server goes
// through this chain, one at a time, whoever asks (suno_create, a batch, two
// batches), on top of the extension's own queue.
let createChain: Promise<unknown> = Promise.resolve()
function oneCreateAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = createChain.then(work, work)
  createChain = run.catch(() => {})
  return run
}

/** Hands a Create (or cover) to the extension and checks the model it reports back against the one asked for. */
async function generate(bridge: Bridge, params: Record<string, unknown>, timeoutMs: number, model: string | undefined) {
  return oneCreateAtATime(async () => {
    const made = (await bridge.call("suno.generate", params, timeoutMs)) as Made
    if (model && made.model && !sameModel(made.model, model)) {
      // An older Browse Hack clicked Create regardless; the songs exist, so say so rather than lose their ids.
      made.warnings = [...(made.warnings ?? []), `Browse Hack's form showed model ${made.model}, not ${model}, as Create was clicked`]
    }
    return made
  })
}

async function finish(bridge: Bridge, made: Made, params: SongParams, ctx: Context, extra: { kind: string; sourceItem?: string }) {
  const warnings = [...ctx.warnings, ...(made.warnings ?? [])]
  if (params.wait === false) {
    return {
      clipIds: made.clipIds,
      formModel: made.model,
      ...(made.vocalGender ? { vocalGender: made.vocalGender } : {}),
      warnings: warnings.length ? warnings : undefined,
      note: "Suno is making them. Check with suno_get_songs; record and download them when they're done."
    }
  }
  const { songs, finished } = await waitForSongs(bridge, made.clipIds, params.timeoutMs ?? 360_000)
  const wrong = wrongModel(songs, params.model)
  if (wrong.length) warnings.push(`Suno ${wrongModelText(wrong, params.model!)}; the Create spent credits on the wrong model`)
  const recorded = (await bridge
    .call("suno.record", { clips: songs, channel: ctx.channel, kind: extra.kind, sourceItem: extra.sourceItem }, 60_000)
    .catch((error) => ({ recorded: 0, note: error instanceof Error ? error.message : String(error) }))) as {
    recorded: number
    note?: string
  }
  const done = songs.filter((s) => s.status === "complete").map((s) => s.id)
  const downloads =
    params.download === "all" && done.length
      ? await downloadSongs(bridge, { ids: done, channel: ctx.channel, set: params.set, sourceItem: extra.sourceItem }).catch((error) => ({
          error: error instanceof Error ? error.message : String(error)
        }))
      : undefined
  return {
    songs: songs.map(summary),
    finished,
    creditsBefore: made.creditsBefore,
    ...(made.vocalGender ? { vocalGender: made.vocalGender } : {}),
    channel: ctx.channel,
    recorded: recorded.recorded,
    ...(wrong.length ? { modelMismatch: { asked: params.model, songs: wrong.map((s) => ({ id: s.id, model: s.model })) } } : {}),
    ...(recorded.note ? { recordNote: recorded.note } : {}),
    ...(downloads ? { downloads } : {}),
    warnings: warnings.length ? warnings : undefined,
    note: finished
      ? downloads
        ? undefined
        : "Listen on Suno, then suno_download (or Save on suno.com) the keepers: each download uses one of the account's monthly downloads."
      : "Some songs are still being made; check them with suno_get_songs."
  }
}

export async function createSongs(bridge: Bridge, params: SongParams) {
  const errors = checkSong(params, true)
  if (errors.length) throw new Error(errors.join("\n"))
  const ctx = await context(bridge, params)
  const made = await generate(
    bridge,
    { mode: "create", workspaceId: ctx.workspaceId, job: formJob(params, ctx.workspaceName), waitForUserMs: params.waitForUserMs },
    (params.waitForUserMs ?? 300_000) + 5 * 60_000,
    params.model
  )
  return finish(bridge, made, params, ctx, { kind: "create" })
}

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".m4a": "audio/x-m4a",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".webm": "audio/webm"
}
const UPLOAD_MAX = 200 * 1024 * 1024
const CHUNK = 512 * 1024
const RIGHTS_OK = /^(own|owned|mine|licen[cs]ed|original)/i

interface CoverSource {
  songId?: string
  file?: { path: string; name: string; mime: string; size: number }
  sourceItem?: string
  title?: string
}

/** What `from` points at: a Suno song, a library item (a Suno song, else its file) or an audio file. */
export async function coverSource(from: string, rightsConfirmed: boolean, lib = readLibrary()): Promise<CoverSource> {
  const value = from.trim()
  if (SHA256.test(value)) {
    const item = await lookupItem(value.toLowerCase(), lib)
    if (!item) throw new Error(`MediaMake's library has no online item ${value}.`)
    // The library's own Suno songs are covered from Suno itself: no upload.
    const fromSuno = item.sunoRef
    if (fromSuno) return { songId: fromSuno, sourceItem: item.id, title: item.title ?? undefined }
    if (!rightsConfirmed && !RIGHTS_OK.test(item.rights ?? "")) {
      throw new Error(
        `MediaMake doesn't record that you own or license "${item.title ?? basename(item.path)}". ` +
          "Ask the user; if they do, call again with rightsConfirmed: true. Suno also rejects uploads that match copyrighted music."
      )
    }
    return { file: await audioFile(item.path), sourceItem: item.id, title: item.title ?? undefined }
  }
  const id = clipIdOf(value)
  if (id && !value.startsWith("/") && !value.startsWith("~")) return { songId: id }
  const path = value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value
  if (!isAbsolute(path)) throw new Error(`"${from}" isn't a Suno song, a library item id or an absolute file path.`)
  if (!rightsConfirmed) {
    throw new Error(
      `Covering ${basename(path)} uploads it to Suno. Ask the user whether they own or license it; if so, call again with rightsConfirmed: true.`
    )
  }
  return { file: await audioFile(path) }
}

async function audioFile(path: string) {
  const mime = AUDIO_MIME[extname(path).toLowerCase()]
  if (!mime) throw new Error(`${basename(path)}: Suno takes ${Object.keys(AUDIO_MIME).join(", ")} files.`)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`${path}: file not found.`)
  if (info.size > UPLOAD_MAX) throw new Error(`${basename(path)} is over 200 MB.`)
  return { path, name: basename(path), mime, size: info.size }
}

async function uploadFile(bridge: Bridge, file: NonNullable<CoverSource["file"]>, workspaceId?: string) {
  const opened = (await bridge.call(
    "suno.uploadOpen",
    { workspaceId, name: file.name, mime: file.mime, total: Math.ceil(file.size / CHUNK) },
    120_000
  )) as { sessionId: string }
  const handle = await open(file.path, "r")
  try {
    const buffer = Buffer.alloc(CHUNK)
    for (let index = 0, offset = 0; offset < file.size; index++, offset += CHUNK) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, offset)
      await bridge.call(
        "suno.uploadChunk",
        { sessionId: opened.sessionId, index, base64: buffer.subarray(0, bytesRead).toString("base64") },
        60_000
      )
    }
  } catch (error) {
    await bridge.call("suno.uploadAbort", { sessionId: opened.sessionId }, 30_000).catch(() => {})
    throw error
  } finally {
    await handle.close()
  }
  return opened.sessionId
}

export async function coverSong(bridge: Bridge, params: CoverParams) {
  const errors = checkSong(params, false)
  if (errors.length) throw new Error(errors.join("\n"))
  const kind = params.kind ?? "cover"
  const ctx = await context(bridge, params)
  const source = await coverSource(params.from, params.rightsConfirmed === true, ctx.lib)
  const job = formJob(params, ctx.workspaceName)
  const uploadSessionId = source.file ? await uploadFile(bridge, source.file, ctx.workspaceId) : undefined
  const made = await generate(
    bridge,
    { mode: kind, songId: source.songId, uploadSessionId, workspaceId: ctx.workspaceId, job, waitForUserMs: params.waitForUserMs },
    (params.waitForUserMs ?? 300_000) + 10 * 60_000,
    params.model
  )
  return finish(bridge, made, params, ctx, { kind: source.file ? "upload" : kind, sourceItem: source.sourceItem })
}

// --- Reading and rating -----------------------------------------------------------------------------

export async function sunoStatus(bridge: Bridge) {
  const lib = readLibrary()
  await syncLibrary(bridge, lib)
  const status = (await bridge.call("suno.status", {}, 90_000)) as Record<string, any>
  return {
    ...status,
    library: hasLibrary(lib)
      ? { inbox: lib.inbox, sunoFolder: inboxFolder(lib, "suno") ? `${lib.inbox}/suno` : undefined }
      : "MediaMake's media library isn't set up on this computer (~/.mediamake/config.json); songs download to Downloads."
  }
}

export async function listSongs(bridge: Bridge, params: { workspace?: string; channel?: string; search?: string; cursor?: string; limit?: number }) {
  const ctx = await context(bridge, params)
  return bridge.call(
    "suno.songs",
    { workspaceId: ctx.workspaceId, search: params.search, cursor: params.cursor, limit: params.limit },
    90_000
  )
}

export async function rateSongs(
  bridge: Bridge,
  params: { ids: string[]; rating?: "keeper" | "maybe" | "reject"; note?: string; usedIn?: string; download?: boolean; channel?: string; set?: string }
) {
  const ids = params.ids.map((id) => clipIdOf(id) ?? id)
  const rated = []
  for (const ref of ids) {
    rated.push({ id: ref, ...((await bridge.call("suno.rate", { ref, rating: params.rating, note: params.note, usedIn: params.usedIn }, 60_000)) as object) })
  }
  const downloads =
    params.download && params.rating === "keeper" ? await downloadSongs(bridge, { ids, channel: params.channel, set: params.set }) : undefined
  return { rated, ...(downloads ? { downloads } : {}) }
}

/** For tests: forget what was last passed to the extension. */
export const resetSync = () => (synced = "")
