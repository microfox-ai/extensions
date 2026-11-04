// Reads YouTube upload folders (info.json, the video, the thumbnail) and
// streams them to the extension, one YouTube Studio tab per folder; and Shorts
// packs (shorts-pack.json), one tab per short. The browser cannot see these
// paths itself.

import { open, readdir, readFile, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, join, resolve } from "node:path"

import type { Bridge } from "./bridge.js"
import { resolveReleaseFolders } from "./distrokid.js"

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp"
}
const IMAGE_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" }
const CHUNK = 1024 * 1024
// The whole video is held in the Studio tab before YouTube reads it.
const VIDEO_MAX = 4 * 1024 ** 3
const THUMBNAIL_MAX = 50 * 1024 ** 2

type LocalFile = { path: string; name: string; mime: string; size: number }

export type UploadOutcome = {
  folder: string
  ok: boolean
  tabId?: number
  channel?: string
  message: string
  warnings?: string[]
  filled?: string[]
  videoUrl?: string
  /** Schedule was clicked (only when asked for). */
  scheduled?: boolean
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false
}

async function localFile(dir: string, relative: string, mimes: Record<string, string>, what: string) {
  const path = isAbsolute(relative) ? relative : resolve(dir, relative)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`${what} ${relative} isn't in ${dir}.`)
  const mime = mimes[extname(path).toLowerCase()]
  if (!mime) throw new Error(`${what} ${basename(path)} isn't a type YouTube takes (${Object.keys(mimes).join(", ")}).`)
  return { path, name: basename(path), mime, size: info.size }
}

async function filesIn(dir: string, mimes: Record<string, string>): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && extname(entry.name).toLowerCase() in mimes)
    .map((entry) => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

type ResolvedUpload = {
  /** info.json's fields, with the title and description text put in. */
  fields: Record<string, unknown>
  video: LocalFile
  thumbnail?: LocalFile
  abThumbnails: LocalFile[]
  notes: string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One upload's fields and files, paths relative to `dir`. A pack folder's info.json (`pickLoose`) also takes
 * title.txt, description.txt, the folder's only video and the only image in thumbnails/; a short in
 * shorts-pack.json names its own.
 */
async function resolveUpload(dir: string, info: Record<string, unknown>, pickLoose: boolean): Promise<ResolvedUpload> {
  const notes: string[] = []
  const text = (key: string) => (typeof info[key] === "string" ? (info[key] as string) : "")

  // Title and description can live in the pack's title.txt and description.txt.
  let title = text("title").trim()
  const titleFile = text("titleFile") || (!title && pickLoose ? "title.txt" : "")
  if (titleFile) {
    const path = resolve(dir, titleFile)
    if (await isFile(path)) title = (await readFile(path, "utf8")).split(/\r?\n/).find((line) => line.trim())?.trim() || ""
    else if (text("titleFile")) throw new Error(`titleFile ${titleFile} isn't in ${dir}.`)
  }
  let description: string | undefined = typeof info.description === "string" ? info.description : undefined
  const descriptionFile = text("descriptionFile") || (description === undefined && pickLoose ? "description.txt" : "")
  if (descriptionFile) {
    const path = resolve(dir, descriptionFile)
    if (await isFile(path)) description = await readFile(path, "utf8")
    else if (text("descriptionFile")) throw new Error(`descriptionFile ${descriptionFile} isn't in ${dir}.`)
  }

  let video: LocalFile
  if (text("video")) video = await localFile(dir, text("video"), VIDEO_MIME, "The video")
  else if (!pickLoose) throw new Error('names no "video".')
  else {
    const videos = await filesIn(dir, VIDEO_MIME)
    if (videos.length === 0) throw new Error(`${dir} has no video file. Put one in, or name it in info.json "video".`)
    if (videos.length > 1) {
      throw new Error(`${dir} has ${videos.length} videos (${videos.map((v) => basename(v)).join(", ")}). Name one in info.json "video".`)
    }
    video = await localFile(dir, videos[0], VIDEO_MIME, "The video")
  }
  if (video.size > VIDEO_MAX) {
    throw new Error(`${video.name} is ${(video.size / 1024 ** 3).toFixed(1)} GB; upload videos over 4 GB in YouTube Studio by hand.`)
  }

  // A/B testing's thumbnails, one per variant that has one, in the variants' order.
  const variants: unknown[] = Array.isArray(info.abTest) ? info.abTest : []
  const abThumbnails: LocalFile[] = []
  for (const variant of variants) {
    const path = variant && typeof variant === "object" ? (variant as Record<string, unknown>).thumbnail : undefined
    if (typeof path === "string" && path.trim()) {
      abThumbnails.push(await localFile(dir, path.trim(), IMAGE_MIME, "The A/B test thumbnail"))
    }
  }

  let thumbnail: LocalFile | undefined
  if (text("thumbnail")) thumbnail = await localFile(dir, text("thumbnail"), IMAGE_MIME, "The thumbnail")
  else if (pickLoose && !abThumbnails.length) {
    const picked = await filesIn(join(dir, "thumbnails"), IMAGE_MIME)
    const loose = (await filesIn(dir, IMAGE_MIME)).filter((file) => /^thumbnail\./i.test(basename(file)))
    const candidates = picked.length ? picked : loose
    if (candidates.length === 1) thumbnail = await localFile(dir, candidates[0], IMAGE_MIME, "The thumbnail")
    else if (candidates.length > 1) {
      notes.push(
        `${candidates.length} thumbnails and none named in info.json "thumbnail", so none was set. ` +
          'To test them, list them in info.json "abTest" (YouTube\'s A/B testing).'
      )
    }
  }
  for (const file of [thumbnail, ...abThumbnails]) {
    if (file && file.size > THUMBNAIL_MAX) throw new Error(`${file.name} is over YouTube's 50 MB thumbnail limit.`)
  }

  const fields: Record<string, unknown> = { ...info, title }
  delete fields.titleFile
  delete fields.descriptionFile
  if (description !== undefined) fields.description = description
  return { fields, video, thumbnail, abThumbnails, notes }
}

async function readUpload(dir: string): Promise<ResolvedUpload> {
  let info: unknown
  try {
    info = JSON.parse((await readFile(join(dir, "info.json"), "utf8")).replace(/^﻿/, ""))
  } catch {
    throw new Error(`${dir}/info.json is not valid JSON.`)
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error(`${dir}/info.json must be a JSON object.`)
  return resolveUpload(dir, info as Record<string, unknown>, true)
}

async function sendFile(bridge: Bridge, sessionId: string, fileId: string, file: LocalFile) {
  const total = Math.max(1, Math.ceil(file.size / CHUNK))
  const handle = await open(file.path, "r")
  try {
    const buffer = Buffer.alloc(CHUNK)
    for (let index = 0; index < total; index++) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, index * CHUNK)
      await bridge.call(
        "youtube.uploadChunk",
        {
          sessionId,
          fileId,
          name: file.name,
          mime: file.mime,
          index,
          total,
          base64: buffer.subarray(0, bytesRead).toString("base64")
        },
        30_000
      )
    }
  } finally {
    await handle.close()
  }
}

/** One Studio tab: switches to the channel, streams the files and fills the form. With `finish`, Studio's
 *  Schedule button is clicked once a scheduled upload is filled (never Save or Publish). */
async function uploadOne(bridge: Bridge, folder: string, upload: ResolvedUpload, finish = false): Promise<UploadOutcome> {
  const opened = (await bridge.call("youtube.uploadOpen", { infoJson: JSON.stringify(upload.fields) }, 150_000)) as {
    sessionId: string
    tabId: number
    channel: { name: string; handle?: string }
    warnings?: string[]
  }
  const channel = [opened.channel?.name, opened.channel?.handle].filter(Boolean).join(" ")
  try {
    await sendFile(bridge, opened.sessionId, "video", upload.video)
    if (upload.thumbnail) await sendFile(bridge, opened.sessionId, "thumbnail", upload.thumbnail)
    const abThumbnailIds = upload.abThumbnails.map((_, index) => `ab-${index}`)
    for (const [index, file] of upload.abThumbnails.entries()) await sendFile(bridge, opened.sessionId, abThumbnailIds[index], file)
    const result = (await bridge.call(
      "youtube.uploadCommit",
      {
        sessionId: opened.sessionId,
        videoId: "video",
        thumbnailId: upload.thumbnail ? "thumbnail" : undefined,
        ...(abThumbnailIds.length ? { abThumbnailIds } : {}),
        ...(finish ? { finish: true } : {})
      },
      330_000
    )) as Omit<UploadOutcome, "folder">
    return {
      folder,
      ok: result.ok !== false,
      tabId: result.tabId ?? opened.tabId,
      channel,
      message: result.message,
      warnings: [...upload.notes, ...(opened.warnings ?? []), ...(result.warnings ?? [])],
      filled: result.filled,
      videoUrl: result.videoUrl,
      ...(finish ? { scheduled: result.scheduled === true } : {})
    }
  } catch (error) {
    await bridge.call("youtube.uploadAbort", { sessionId: opened.sessionId }, 10_000).catch(() => {})
    return { folder, ok: false, tabId: opened.tabId, channel, message: errorText(error), warnings: upload.notes }
  }
}

async function fillOne(bridge: Bridge, folder: string): Promise<UploadOutcome> {
  return uploadOne(bridge, folder, await readUpload(folder))
}

export async function fillYoutubeUploads(
  bridge: Bridge,
  inputs: string[]
): Promise<{ published: false; note: string; results: UploadOutcome[] }> {
  const folders = await resolveReleaseFolders(inputs)
  // One at a time: switching channels changes the whole Chrome profile's YouTube.
  const results: UploadOutcome[] = []
  for (const folder of folders) {
    results.push(
      await fillOne(bridge, folder).catch((error) => ({
        folder,
        ok: false,
        message: errorText(error)
      }))
    )
  }
  return {
    published: false,
    note:
      "Nothing was saved or published. Each tab is left on YouTube Studio's Visibility step with the upload running: " +
      "the user reviews it and clicks Save, Publish or Schedule. The Chrome profile's YouTube now acts as the last channel used.",
    results
  }
}

// --- shorts-pack.json: several shorts for one channel (the popup's Bulk Upload Shorts) ---

export type ShortsPack = {
  channel: string
  schedule: { time: string; from: string | null } | null
  /** Each short: the pack's channel, then `defaults`, then its own fields. */
  entries: Record<string, unknown>[]
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** The extension's rules (get-into-zone/lib/youtubeShorts.ts parseShortsPack), so a pack reads the same from the popup and from here. */
export function parseShortsPack(raw: unknown): { pack: ShortsPack; errors: string[] } {
  const errors: string[] = []
  const obj = asRecord(raw) || {}
  if (!asRecord(raw)) errors.push("shorts-pack.json must be a JSON object.")
  const defaults = asRecord(obj.defaults) || {}
  const channel = String(obj.channel ?? defaults.channel ?? "").trim()
  if (!channel) errors.push('shorts-pack.json has no channel (e.g. "@atomic-rap").')

  let schedule: ShortsPack["schedule"] = null
  if (obj.schedule !== undefined) {
    const rawSchedule = asRecord(obj.schedule)
    const time = String(rawSchedule?.time ?? "").trim()
    const from = String(rawSchedule?.from ?? "").trim()
    if (!TIME.test(time)) errors.push('schedule.time must be "HH:MM" (24-hour, in the channel\'s time zone).')
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) errors.push('schedule.from must be "YYYY-MM-DD".')
    const [, h, m] = time.match(TIME) || []
    schedule = { time: h ? `${h.padStart(2, "0")}:${m}` : time, from: from || null }
  }

  const shorts = Array.isArray(obj.shorts) ? obj.shorts : []
  if (!shorts.length) errors.push("shorts-pack.json lists no shorts.")
  const entries = shorts.map((item, index): Record<string, unknown> => {
    const short = asRecord(item)
    if (!short) errors.push(`shorts[${index}] must be an object with at least "video" and "title".`)
    return { channel, ...defaults, ...(short || {}) }
  })
  return { pack: { channel, schedule, entries }, errors }
}

export type ShortOutcome = UploadOutcome & { label: string; title: string; scheduleAt?: string }

export type ShortsPackOutcome = {
  folder: string
  channel: string
  ok: boolean
  message: string
  /** The days with no short on the channel, in the order the shorts took them. */
  days?: string[]
  shorts: ShortOutcome[]
}

const OLD_EXTENSION =
  "Bulk-uploading Shorts needs Browse Hack 0.16.0 or later (it reads the channel's Shorts tab for the empty days). " +
  "Update it with update_browse_hack, then try again. Nothing was uploaded."

async function uploadShortsPack(bridge: Bridge, folder: string, finish: boolean): Promise<ShortsPackOutcome> {
  let raw: unknown
  try {
    raw = JSON.parse((await readFile(join(folder, "shorts-pack.json"), "utf8")).replace(/^﻿/, ""))
  } catch {
    throw new Error(`${folder}/shorts-pack.json is not valid JSON.`)
  }
  const { pack, errors } = parseShortsPack(raw)

  // Every short is read before anything goes up, so a mistake in the pack uploads nothing.
  const items: { label: string; upload: ResolvedUpload; needsDay: boolean }[] = []
  for (const [index, entry] of pack.entries.entries()) {
    const label = `Short ${index + 1}`
    // With a schedule, a short without its own scheduleAt gets the next day that has no short.
    const needsDay = !!pack.schedule && !entry.scheduleAt && (!entry.visibility || /^schedul/i.test(String(entry.visibility)))
    const fields = { ...entry }
    if (needsDay) delete fields.visibility
    try {
      const upload = await resolveUpload(folder, fields, false)
      if (!String(upload.fields.title ?? "").trim()) throw new Error('has no title ("title" or "titleFile").')
      items.push({ label, upload, needsDay })
    } catch (error) {
      errors.push(`${label}: ${errorText(error)}`)
    }
  }
  if (errors.length) throw new Error(`Nothing was uploaded. ${errors.join(" ")}`)

  const needing = items.filter((item) => item.needsDay).length
  let days: string[] = []
  if (needing) {
    const found = (await bridge
      .call("youtube.shortsFreeDays", { channel: pack.channel, count: needing, from: pack.schedule?.from ?? undefined }, 180_000)
      .catch((error) => {
        throw /unknown method/i.test(errorText(error)) ? new Error(OLD_EXTENSION) : error
      })) as { days?: string[] }
    days = Array.isArray(found?.days) ? found.days : []
    if (days.length < needing) throw new Error(`Found ${days.length} empty days on ${pack.channel} for ${needing} shorts. Nothing was uploaded.`)
  }

  // One at a time, like the popup: each short gets its own Studio tab.
  let next = 0
  const shorts: ShortOutcome[] = []
  for (const item of items) {
    const { fields } = item.upload
    if (item.needsDay) {
      fields.visibility = "scheduled"
      fields.scheduleAt = `${days[next++]}T${pack.schedule!.time}`
    }
    const scheduleAt = typeof fields.scheduleAt === "string" ? fields.scheduleAt : undefined
    const outcome: UploadOutcome = await uploadOne(bridge, folder, item.upload, finish).catch((error) => ({
      folder,
      ok: false,
      message: errorText(error)
    }))
    shorts.push({ ...outcome, label: item.label, title: String(fields.title), ...(scheduleAt ? { scheduleAt } : {}) })
  }
  const failed = shorts.filter((short) => !short.ok).length
  return {
    folder,
    channel: pack.channel,
    ok: failed === 0,
    message: failed ? `${failed} of ${shorts.length} shorts failed; the others were filled.` : `${shorts.length} shorts filled.`,
    ...(needing ? { days } : {}),
    shorts
  }
}

/** Every short of each folder's shorts-pack.json, one Studio tab each, on the next days that have no short. */
export async function bulkUploadShorts(
  bridge: Bridge,
  inputs: string[],
  options: { clickSchedule?: boolean } = {}
): Promise<{ scheduled: boolean; note: string; packs: ShortsPackOutcome[] }> {
  const folders = await resolveReleaseFolders(inputs, "shorts-pack.json")
  const finish = options.clickSchedule === true
  const packs: ShortsPackOutcome[] = []
  for (const folder of folders) {
    packs.push(
      await uploadShortsPack(bridge, folder, finish).catch((error) => ({
        folder,
        channel: "",
        ok: false,
        message: errorText(error),
        shorts: []
      }))
    )
  }
  return {
    scheduled: finish,
    note: finish
      ? "Schedule was clicked on each short that reached Visibility with its day (scheduled: true). A short with scheduled false " +
        "waits in its own Studio tab: the user finishes it there. Nothing was published."
      : "Nothing was scheduled or published: each short waits in its own YouTube Studio tab on the Visibility step, its day and " +
        "time filled in, with the upload running. The user reviews each tab and clicks Schedule.",
    packs
  }
}
