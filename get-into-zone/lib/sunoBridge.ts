// Suno for the MCP server and for the buttons on suno.com. Reads go through
// suno.com's own API in any suno.com tab of this profile; making songs and
// downloading them happen one at a time in a background "worker" tab that
// Browse Hack opens and reuses, so the user's own Suno tabs are never
// navigated. A library track to cover gets a tab of its own while it uploads.
// Songs downloaded here are renamed into MediaMake's library inbox
// (_INBOX/suno/<channel>/<set>/) as Chrome saves them, and every take is
// recorded in MediaMake cloud under the channel's project (Part B's
// /api/generations; skipped while that route doesn't exist).

import { downloadFinished, inFolder, saveSourceSidecar, type SourceFields } from "./libraryFiles"
import { authorizedFetch, mediamakeEndpoint } from "./mediamakeAuth"
import { generationRecord, songFileBase, SUNO, type SunoClip } from "./suno/clip"
import type { SunoFormJob } from "./suno/form"
import {
  findChannel,
  loadSunoPrefs,
  mergeChannels,
  saveSunoPrefs,
  songSet,
  type SunoChannel,
  type SunoPrefs
} from "./sunoPrefs"
import { openTab, waitForTabLoad } from "./tabs"

const WORKER_KEY = "sunoWorkerTab"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type PageState = {
  ok?: boolean
  ready?: boolean
  page?: string
  url?: string
  signedIn?: boolean
  form?: { ready: boolean; model?: string; credits?: number; workspace?: string; createEnabled: boolean; captcha: boolean }
}

// --- Tabs -----------------------------------------------------------------------

async function ping(tabId: number): Promise<PageState | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: "giz-suno-ping" })
  } catch {
    return null
  }
}

async function waitReady(tabId: number, test: (s: PageState) => boolean = (s) => !!s.ready, timeoutMs = 45_000) {
  const start = Date.now()
  let last: PageState | null = null
  while (Date.now() - start < timeoutMs) {
    last = await ping(tabId)
    if (last?.ok && last.signedIn === false) {
      throw new Error("Suno isn't signed in in this Chrome profile. Sign in at https://suno.com, then try again.")
    }
    if (last?.ok && test(last)) return last
    await sleep(500)
  }
  throw new Error(`suno.com didn't finish loading in tab ${tabId}${last?.url ? ` (${last.url})` : ""}.`)
}

async function liveSunoTab(id: unknown) {
  if (typeof id !== "number") return undefined
  const tab = await chrome.tabs.get(id).catch(() => undefined)
  return tab?.url?.startsWith(SUNO) ? tab : undefined
}

/** Browse Hack's own suno.com tab, opened in the background the first time. */
async function workerTab() {
  const stored = (await chrome.storage.session.get(WORKER_KEY))[WORKER_KEY]
  const tab = await liveSunoTab(stored)
  if (tab?.id) return tab.id
  const created = await openTab(`${SUNO}/create`, false, true)
  if (!created.id) throw new Error("Chrome didn't open a suno.com tab.")
  await chrome.storage.session.set({ [WORKER_KEY]: created.id })
  await waitReady(created.id)
  return created.id
}

/** Any suno.com tab to read through: the worker's, else one of the user's, else a new worker. */
async function readTab() {
  const stored = await liveSunoTab((await chrome.storage.session.get(WORKER_KEY))[WORKER_KEY])
  if (stored?.id && (await ping(stored.id))?.ok) return stored.id
  for (const tab of await chrome.tabs.query({ url: `${SUNO}/*` })) {
    if (tab.id && (await ping(tab.id))?.ok) return tab.id
  }
  return workerTab()
}

async function send<T = any>(tabId: number, msg: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  const reply: any = await Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    sleep(timeoutMs).then(() => ({ ok: false, error: `The Suno tab took too long (${msg.action}).` }))
  ])
  if (!reply?.ok) throw new Error(reply?.error || "The Suno tab didn't answer. Reload it and try again.")
  return reply.result as T
}

const read = async <T = any>(op: string, params: Record<string, unknown> = {}) =>
  send<T>(await readTab(), { action: "giz-suno-read", op, params }, 90_000)

async function goTo(tabId: number, url: string, needForm: boolean) {
  await chrome.tabs.update(tabId, { url })
  await sleep(600)
  await waitForTabLoad(tabId, 45_000).catch(() => {})
  return waitReady(tabId, (s) => !!s.ready && (!needForm || !!s.form?.ready))
}

async function focus(tabId: number) {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined)
  if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
}

// Songs are made and downloaded one at a time.
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => {})
  return run
}

// --- Uploads: a library track for a cover ------------------------------------------

type Upload = { tabId: number; port: chrome.runtime.Port; fileId: string; workspaceId?: string }
const uploads = new Map<string, Upload>()

function takeUpload(sessionId: unknown) {
  const upload = uploads.get(String(sessionId || ""))
  if (!upload) throw new Error("That Suno upload tab is gone. Start the cover again.")
  return upload
}

function attachInTab(upload: Upload, condition: string | undefined, allowTerms: boolean, waitForUserMs: number) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => finish(() => reject(new Error("Suno didn't take the audio in time."))), waitForUserMs + 60_000)
    let settled = false
    const finish = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      upload.port.onMessage.removeListener(onMessage)
      done()
    }
    const onMessage = (msg: any) => {
      if (msg?.type === "needs-user") focus(upload.tabId)
      if (msg?.type === "result") finish(() => (msg.error ? reject(new Error(msg.error)) : resolve(msg.result)))
    }
    upload.port.onMessage.addListener(onMessage)
    upload.port.onDisconnect.addListener(() => finish(() => reject(new Error("Lost the Suno upload tab."))))
    upload.port.postMessage({ type: "attach", id: upload.fileId, condition, allowTerms, waitForUserMs })
  })
}

// --- Making songs --------------------------------------------------------------------

export interface GenerateParams {
  /** create, or a remix of songId: cover, extend… */
  mode?: string
  songId?: string
  workspaceId?: string
  job?: SunoFormJob
  /** A library track uploaded with suno.uploadOpen / suno.uploadChunk. */
  uploadSessionId?: string
  waitForUserMs?: number
}

function createUrl(p: GenerateParams) {
  const query = new URLSearchParams()
  if (p.workspaceId && p.workspaceId !== "default") query.set("wid", p.workspaceId)
  if (p.songId && p.mode && p.mode !== "create") {
    query.set("song_id", p.songId)
    query.set("remix_type", p.mode)
  }
  const q = query.toString()
  return `${SUNO}/create${q ? `?${q}` : ""}`
}

/** Songs that turned up in the workspace since `since`: a Create that answered late. */
async function songsSince(tabId: number, workspaceId: string | undefined, since: number, title?: string) {
  const page = await send<{ songs: SunoClip[] }>(tabId, {
    action: "giz-suno-read",
    op: "songs",
    params: { workspaceId, limit: 10 }
  }).catch(() => ({ songs: [] as SunoClip[] }))
  return page.songs.filter(
    (s) => Date.parse(s.createdAt ?? "") >= since - 5000 && (!title || s.title.trim() === title.trim())
  )
}

const describeOutcome = (o: any) =>
  o?.refused
    ? `Suno refused it: ${o.refused}`
    : o?.error
      ? `Suno says: ${o.error}`
      : o?.captcha
        ? "Suno is asking for a check (captcha) in the Browse Hack Suno tab. Clear it there and run this again."
        : "Suno didn't confirm the Create in time. Check the Browse Hack Suno tab."

export function generate(p: GenerateParams) {
  return exclusive(async () => {
    const waitForUserMs = Math.min(Math.max(p.waitForUserMs ?? 300_000, 0), 1_800_000)
    const upload = p.uploadSessionId ? takeUpload(p.uploadSessionId) : undefined
    let tabId: number
    if (upload) {
      tabId = upload.tabId
      const prefs = await loadSunoPrefs()
      await attachInTab(upload, p.mode && p.mode !== "create" ? p.mode : "cover", prefs.allowUploadTerms, waitForUserMs)
    } else {
      tabId = await workerTab()
      await goTo(tabId, createUrl(p), true)
    }

    const fill = await send<{ warnings: string[]; form: any }>(tabId, { action: "giz-suno-fill", job: p.job ?? {} }, 120_000)
    let outcome: any = await send(tabId, { action: "giz-suno-submit", waitMs: 45_000 }, 75_000)
    const creditsBefore = outcome.creditsBefore
    if (outcome.captcha) {
      await focus(tabId)
      outcome = await send(
        tabId,
        { action: "giz-suno-await", since: outcome.since, waitMs: waitForUserMs, reportCaptcha: false },
        waitForUserMs + 20_000
      )
    }
    if (!outcome.clipIds?.length && !outcome.refused) {
      const late = await songsSince(tabId, p.workspaceId, outcome.since, p.job?.title)
      if (late.length) outcome = { clipIds: late.map((s) => s.id), since: outcome.since }
    }
    if (!outcome.clipIds?.length) throw new Error(`${describeOutcome(outcome)} (tab ${tabId})`)
    if (upload) {
      uploads.delete(String(p.uploadSessionId))
      upload.port.disconnect()
      await chrome.tabs.remove(upload.tabId).catch(() => {})
    }
    return {
      clipIds: outcome.clipIds as string[],
      batchId: outcome.batchId as string | undefined,
      warnings: fill.warnings,
      model: fill.form?.model,
      workspace: fill.form?.workspace,
      creditsBefore
    }
  })
}

// --- Downloads into the library inbox ------------------------------------------------

type Route = { folder: string; base: string; at: number; started: (id: number) => void }
const routes: Route[] = []

function expectDownload(folder: string, base: string) {
  let route!: Route
  const started = new Promise<number>((resolve, reject) => {
    route = { folder, base, at: Date.now(), started: resolve }
    setTimeout(() => reject(new Error("Suno didn't start the download.")), 90_000)
  })
  routes.push(route)
  return {
    started,
    cancel: () => {
      const i = routes.indexOf(route)
      if (i >= 0) routes.splice(i, 1)
    }
  }
}

const fromSuno = (item: chrome.downloads.DownloadItem) =>
  [item.url, item.finalUrl, item.referrer].some((u) => /^(blob:)?https:\/\/([\w-]+\.)*suno\.(com|ai)\//.test(u ?? ""))

function extensionOf(item: chrome.downloads.DownloadItem) {
  const fromName = item.filename.match(/\.(mp3|wav|m4a|mp4|zip|flac)$/i)?.[0]
  if (fromName) return fromName.toLowerCase()
  if (/wav/.test(item.mime)) return ".wav"
  if (/mp4/.test(item.mime)) return item.mime.startsWith("video") ? ".mp4" : ".m4a"
  if (/zip/.test(item.mime)) return ".zip"
  return ".mp3"
}

/** Songs downloaded by hand on suno.com, filed into the inbox when the user turned that on. */
async function routeByHand(item: chrome.downloads.DownloadItem, suggest: (s?: chrome.downloads.DownloadFilenameSuggestion) => void) {
  try {
    const prefs = await loadSunoPrefs()
    const clipId = [item.url, item.finalUrl, item.filename].join(" ").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0]
    if (!prefs.routeDownloads || !clipId) return suggest()
    const clip = await read<SunoClip>("song", { id: clipId }).catch(() => undefined)
    if (!clip) return suggest()
    const channel = findChannel(prefs, { workspaceId: clip.workspace?.id })
    const folder = songFolder(prefs, channel, clip)
    const requested = inFolder(folder, `${songFileBase(clip)}${extensionOf(item)}`)
    suggest({ filename: requested, conflictAction: "uniquify" })
    const saved = await downloadFinished(item.id)
    await saveSourceSidecar(requested, saved, sourceFields(clip, channel?.id))
  } catch {
    suggest()
  }
}

export function initSunoDownloads() {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (!fromSuno(item)) return
    const route = routes.find((r) => Date.now() - r.at < 120_000)
    if (route) {
      routes.splice(routes.indexOf(route), 1)
      suggest({ filename: inFolder(route.folder, `${route.base}${extensionOf(item)}`), conflictAction: "uniquify" })
      route.started(item.id)
      return
    }
    routeByHand(item, suggest)
    return true
  })
}

const songFolder = (prefs: SunoPrefs, channel: SunoChannel | undefined, clip: SunoClip, set?: string) =>
  [prefs.inboxFolder, "suno", channel?.id, set || songSet(clip.root?.title || clip.title)].filter(Boolean).join("/")

/** What the sidecar beside a downloaded song says (mediamake.source/v1 with the song fields). */
export function sourceFields(clip: SunoClip, channel?: string, extra: { sourceItem?: string; price?: number } = {}): SourceFields {
  return {
    tool: "suno",
    ref: clip.id,
    url: clip.audioUrl,
    pageUrl: clip.pageUrl,
    title: clip.title,
    author: clip.author,
    prompt: clip.styles,
    model: clip.model,
    price: extra.price,
    lyrics: clip.instrumental ? undefined : clip.lyrics,
    excludeStyles: clip.excludeStyles,
    instrumental: clip.instrumental,
    settings: clip.settings as Record<string, unknown>,
    parentRef: clip.parent?.id,
    relation: clip.parent?.relation,
    sourceItem: extra.sourceItem,
    workspace: clip.workspace,
    channel
  }
}

/** Clicks the song's Download in the worker tab and waits for the file in the inbox. */
export function downloadSong(p: { clipId: string; folder: string; base: string; format?: "mp3" | "wav" }) {
  return exclusive(async () => {
    const tabId = await workerTab()
    await goTo(tabId, `${SUNO}/song/${p.clipId}`, false)
    const route = expectDownload(p.folder, p.base)
    try {
      await send(tabId, { action: "giz-suno-download", clipId: p.clipId, format: p.format ?? "mp3" }, 60_000)
      const downloadId = await route.started
      const path = await Promise.race([
        downloadFinished(downloadId),
        sleep(600_000).then(() => {
          throw new Error("The download took longer than 10 minutes.")
        })
      ])
      return { path, downloadId }
    } finally {
      route.cancel()
    }
  })
}

// --- MediaMake cloud: the channel's songs ---------------------------------------------

const MISSING = "MediaMake doesn't have its songs database yet (no /api/generations), so nothing was recorded."

async function cloud(path: string, init: RequestInit = {}) {
  const base = await mediamakeEndpoint()
  const resp = await authorizedFetch(`${base}${path}`, {
    ...init,
    headers: init.body ? { "Content-Type": "application/json" } : {}
  })
  if (resp.status === 404 && /^\/api\/generations/.test(path)) {
    const data = await resp.clone().json().catch(() => null)
    // A 404 from the route itself (a song it doesn't know) carries an error message.
    if (!data?.error) return { missing: true as const }
  }
  const data = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(data?.error || `MediaMake answered ${resp.status} for ${path.split("?")[0]}.`)
  return data
}

/** The cloud project a channel's songs go under: asked for, the channel's link, else the Default Project. */
async function projectFor(p: { projectId?: string; channel?: string; workspaceId?: string }) {
  if (p.projectId) return p.projectId
  const prefs = await loadSunoPrefs()
  const channel = findChannel(prefs, { channel: p.channel, workspaceId: p.workspaceId })
  if (channel?.projectId) return channel.projectId
  const { selectedProjectId } = await chrome.storage.local.get("selectedProjectId")
  return typeof selectedProjectId === "string" && selectedProjectId.trim() ? selectedProjectId.trim() : undefined
}

export async function recordSongs(p: {
  clips?: SunoClip[]
  clipIds?: string[]
  projectId?: string
  channel?: string
  kind?: string
  sourceItem?: string
  batchId?: string
}) {
  const clips = p.clips ?? (p.clipIds?.length ? await read<SunoClip[]>("clips", { ids: p.clipIds }) : [])
  if (!clips.length) return { recorded: 0 }
  const projectId = await projectFor({ projectId: p.projectId, channel: p.channel, workspaceId: clips[0]?.workspace?.id })
  if (!projectId) {
    return { recorded: 0, note: "No MediaMake project for this channel: link one in Browse Hack's Suno tab, or set a Default Project." }
  }
  const items = clips.map((clip) => generationRecord(clip, { kind: p.kind, sourceItem: p.sourceItem, batchId: p.batchId }))
  const data = await cloud("/api/generations", { method: "POST", body: JSON.stringify({ projectId, items }) })
  if ((data as any)?.missing) return { recorded: 0, projectId, note: MISSING }
  return { recorded: Number((data as any)?.saved ?? items.length), projectId }
}

async function listSongs(p: Record<string, any>) {
  const projectId = await projectFor(p)
  if (!projectId) throw new Error("Name the channel or project: no MediaMake project is linked.")
  const query = new URLSearchParams({ projectId, tool: "suno" })
  for (const key of ["q", "rating", "model", "kind", "parentRef", "cursor", "limit"]) {
    if (p[key] !== undefined && p[key] !== "") query.set(key, String(p[key]))
  }
  const data = await cloud(`/api/generations?${query}`)
  if ((data as any)?.missing) return { items: [], note: MISSING.replace("was recorded", "is recorded yet") }
  return { projectId, ...(data as object) }
}

/** Rates a take by its Suno song id; one made outside Browse Hack is recorded first. */
async function rateSong(p: { ref: string; rating?: string; note?: string; usedIn?: string; libraryItem?: string; channel?: string }) {
  const body = Object.fromEntries(Object.entries({ rating: p.rating, note: p.note, usedIn: p.usedIn, libraryItem: p.libraryItem }).filter(([, v]) => v !== undefined))
  const patch = () =>
    cloud(`/api/generations/${encodeURIComponent(p.ref)}?tool=suno`, { method: "PATCH", body: JSON.stringify(body) })
  let data: any
  try {
    data = await patch()
  } catch (error) {
    if (!/not found/i.test(message(error))) throw error
    const recorded = await recordSongs({ clipIds: [p.ref], channel: p.channel })
    if (!recorded.recorded) return { rated: false, note: recorded.note ?? "The song isn't in MediaMake cloud." }
    data = await patch()
  }
  return data?.missing ? { rated: false, note: MISSING.replace("was recorded", "was rated") } : { rated: true, item: data }
}

async function presets(p: { projectId?: string; channel?: string }) {
  const projectId = await projectFor(p)
  if (!projectId) return []
  const data = await cloud(`/api/generations/presets?projectId=${encodeURIComponent(projectId)}`)
  return (data as any)?.missing ? [] : ((data as any)?.presets ?? [])
}

async function savePreset(p: { projectId?: string; channel?: string; preset: Record<string, unknown> }) {
  const projectId = await projectFor(p)
  if (!projectId) throw new Error("Link this channel to a MediaMake project first (Browse Hack's Suno tab).")
  // MediaMake keeps a preset's model with its settings.
  const { model, settings, ...preset } = p.preset
  const data = await cloud(`/api/generations/presets?projectId=${encodeURIComponent(projectId)}`, {
    method: "POST",
    body: JSON.stringify({
      ...preset,
      projectId,
      tool: "suno",
      settings: { ...(settings && typeof settings === "object" ? settings : {}), ...(model ? { model } : {}) }
    })
  })
  if ((data as any)?.missing) throw new Error("MediaMake doesn't have saved styles yet (no /api/generations/presets).")
  return data
}

// --- Saving a song and making variations (buttons on suno.com) ---------------------

export async function saveSongToLibrary(p: { clipId: string; channel?: string; set?: string; format?: "mp3" | "wav"; sourceItem?: string }) {
  const prefs = await loadSunoPrefs()
  const clip = await read<SunoClip>("song", { id: p.clipId })
  const channel = findChannel(prefs, { channel: p.channel, workspaceId: clip.workspace?.id })
  const folder = songFolder(prefs, channel, clip, p.set)
  const base = songFileBase(clip)
  const { path } = await downloadSong({ clipId: clip.id, folder, base, format: p.format ?? prefs.downloadFormat })
  const ext = path.match(/\.[a-z0-9]+$/i)?.[0] ?? ".mp3"
  await saveSourceSidecar(inFolder(folder, `${base}${ext}`), path, sourceFields(clip, channel?.id, { sourceItem: p.sourceItem })).catch(() => {})
  await rateSong({ ref: clip.id, rating: "keeper", channel: channel?.id }).catch(() => {})
  return { path, clip, channel: channel?.id }
}

function variationJobs(clip: SunoClip, type: string, styles?: string): GenerateParams {
  const keepSettings = {
    model: clip.model || undefined,
    vocalGender: clip.settings.vocalGender,
    weirdness: clip.settings.weirdness,
    styleInfluence: clip.settings.styleInfluence
  }
  switch (type) {
    case "instrumental":
      return { mode: "cover", songId: clip.id, job: { instrumental: true, ...(styles ? { styles } : {}) } }
    case "extend":
      return { mode: "extend", songId: clip.id, job: styles ? { styles } : {} }
    case "reuse":
      return {
        mode: "create",
        job: { lyrics: clip.instrumental ? "" : clip.lyrics, instrumental: clip.instrumental, styles: styles ?? clip.styles, title: clip.title, model: clip.model || undefined }
      }
    case "again":
      return {
        mode: "create",
        job: { lyrics: clip.instrumental ? "" : clip.lyrics, instrumental: clip.instrumental, styles: clip.styles, excludeStyles: clip.excludeStyles, title: clip.title, ...keepSettings }
      }
    default:
      return { mode: "cover", songId: clip.id, job: styles ? { styles } : {} }
  }
}

async function runVariations(p: Record<string, any>, tell: (text: string, kind?: string) => void) {
  const clip = await read<SunoClip>("song", { id: p.clipId })
  const runs = Math.min(Math.max(Number(p.runs) || 1, 1), 10)
  const params = { ...variationJobs(clip, String(p.type), p.styles), workspaceId: p.workspaceId ?? clip.workspace?.id }
  for (let i = 1; i <= runs; i++) {
    try {
      tell(`Variation run ${i} of ${runs} for "${clip.title}"…`)
      const made = await generate(params)
      tell(`Run ${i}: Suno is making ${made.clipIds.length} songs.`, "done")
      const kind = params.mode !== "create" ? params.mode : p.type === "reuse" ? "reuse" : "create"
      recordSongs({ clipIds: made.clipIds, channel: p.channel, kind }).catch(() => {})
    } catch (error) {
      tell(`Run ${i} stopped: ${message(error)}`, "error")
      return
    }
  }
}

/** Requests from the buttons on suno.com (contents/suno.ts). */
export function handleSunoUi(request: any, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) {
  const tabId = sender.tab?.id
  const tell = (text: string, kind?: string) => {
    if (tabId) chrome.tabs.sendMessage(tabId, { action: "giz-suno-progress", text, kind }).catch(() => {})
  }
  const reply = (work: Promise<unknown>) => {
    work.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: message(error) })
    )
    return true
  }
  switch (request.op) {
    // The popup's Suno tab.
    case "status":
      return reply(sunoCommands["suno.status"]({}))
    case "workspaces":
      return reply(read("workspaces"))
    case "projects":
      return reply(
        cloud("/api/project").then((data) =>
          (Array.isArray(data) ? data : []).map((p: any) => ({ id: String(p.id), name: String(p.displayName ?? p.id) }))
        )
      )
    // The buttons on suno.com.
    case "presets":
      return reply(presets({ channel: request.channel }))
    case "savePreset":
      return reply(savePreset({ channel: request.channel, preset: request.preset ?? {} }))
    case "record":
      return reply(recordSongs({ clipIds: request.clipIds, channel: request.channel }))
    case "save":
      return reply(saveSongToLibrary({ clipId: String(request.clipId), channel: request.channel }))
    case "variations":
      runVariations(request, tell)
      sendResponse({ ok: true, result: { note: "Browse Hack is making them in its own Suno tab; progress shows here." } })
      return false
  }
  sendResponse({ ok: false, error: `Unknown request: ${request.op}` })
  return false
}

// --- The MCP server's methods -----------------------------------------------------------

function formHealth(form: PageState["form"]) {
  if (!form) return undefined
  const missing = [
    !form.ready && "the Create form or its lyrics box",
    !form.model && "the model menu",
    form.workspace === undefined && "the workspace button"
  ].filter(Boolean)
  return missing.length ? { missing } : { ok: true }
}

export const sunoCommands: Record<string, (params: any) => Promise<unknown>> = {
  "suno.status": async () => {
    const tabId = await readTab()
    const page = await ping(tabId)
    const account = await read("account")
    const prefs = await loadSunoPrefs()
    return {
      signedIn: page?.signedIn ?? true,
      account,
      tab: { id: tabId, url: page?.url },
      createForm: formHealth(page?.form),
      channels: prefs.channels,
      inboxFolder: prefs.inboxFolder,
      downloadFormat: prefs.downloadFormat,
      uploadTermsAllowed: prefs.allowUploadTerms
    }
  },
  "suno.workspaces": async () => ({ workspaces: await read("workspaces") }),
  "suno.songs": async (params) => read("songs", params),
  "suno.song": async ({ id }) => read("song", { id }),
  "suno.clips": async ({ ids }) => ({ songs: await read("clips", { ids }) }),

  "suno.prefs": async () => loadSunoPrefs(),
  /** The MCP server passes on the library's inbox and channels (~/.mediamake/config.json). */
  "suno.syncLibrary": async ({ inboxFolder, channels }) => {
    const prefs = await loadSunoPrefs()
    const next = await saveSunoPrefs({
      inboxFolder: typeof inboxFolder === "string" && inboxFolder ? inboxFolder : prefs.inboxFolder,
      channels: Array.isArray(channels) ? mergeChannels(prefs.channels, channels) : prefs.channels
    })
    return { channels: next.channels, inboxFolder: next.inboxFolder }
  },

  "suno.generate": async (params) => generate(params as GenerateParams),

  "suno.uploadOpen": async ({ workspaceId, name, mime, total }) => {
    const query = workspaceId && workspaceId !== "default" ? `?wid=${encodeURIComponent(workspaceId)}` : ""
    const tab = await openTab(`${SUNO}/create${query}`, false, true)
    if (!tab.id) throw new Error("Chrome didn't open a suno.com tab.")
    await waitReady(tab.id, (s) => !!s.ready && !!s.form?.ready)
    const port = chrome.tabs.connect(tab.id, { name: "giz-suno-upload" })
    const sessionId = crypto.randomUUID()
    uploads.set(sessionId, { tabId: tab.id, port, fileId: "audio", workspaceId })
    port.onDisconnect.addListener(() => {
      if (uploads.get(sessionId)?.port === port) uploads.delete(sessionId)
    })
    port.postMessage({ type: "file-start", id: "audio", name: String(name || "audio"), mime: String(mime || ""), total: Number(total) || 0 })
    return { sessionId, tabId: tab.id }
  },
  "suno.uploadChunk": async ({ sessionId, index, base64 }) => {
    const upload = takeUpload(sessionId)
    if (base64) upload.port.postMessage({ type: "chunk", id: upload.fileId, index: Number(index) || 0, base64: String(base64) })
    return { ok: true }
  },
  "suno.uploadAbort": async ({ sessionId }) => {
    const upload = uploads.get(String(sessionId || ""))
    if (!upload) return { aborted: false }
    uploads.delete(String(sessionId))
    upload.port.disconnect()
    await chrome.tabs.remove(upload.tabId).catch(() => {})
    return { aborted: true }
  },

  "suno.download": async ({ clipId, folder, base, format }) => {
    if (!clipId || !folder || !base) throw new Error("clipId, folder and base are required.")
    return downloadSong({ clipId: String(clipId), folder: String(folder), base: String(base), format: format === "wav" ? "wav" : "mp3" })
  },

  "suno.record": async (params) => recordSongs(params),
  "suno.listGenerations": async (params) => listSongs(params),
  "suno.rate": async (params) => rateSong(params),
  "suno.presets": async (params) => ({ presets: await presets(params) }),
  "suno.savePreset": async (params) => savePreset(params)
}
