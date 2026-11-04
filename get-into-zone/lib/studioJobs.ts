// The popup's YouTube Studio jobs, run by the service worker: the popup closes as
// soon as a Studio tab comes to the front, so it saves the files (lib/studioFiles.ts)
// and hands the job over. Progress is kept in chrome.storage.local ("studioJob").
//
// - pack: one upload from a folder with info.json (what youtube_fill_uploads does).
// - shorts: every short of a shorts-pack.json, each on the next day with no short.
// - autofill: the drafts on a channel's Shorts tab, each filled from its most similar
//   filled-in short (title included) and scheduled on the next day with no short.

import { clearJobFiles, getJobFile } from "./studioFiles"
import { fillDraft, openChannelTab, readShortsList, readVideoDetails, youtubeStudioCommands } from "./youtubeUploadBridge"
import { emptyDays, isoDay, pickReference } from "./youtubeShorts"
import { parseYoutubeUploadInfo, type YoutubeFillResult } from "./youtubeUpload"

export type StudioJobItem = {
  label: string
  /** info.json fields (title and description text put in). */
  fields: Record<string, unknown>
  /** Keys of its files in lib/studioFiles.ts. */
  files: { video: string; thumbnail?: string; ab: string[] }
  needsDay: boolean
}

export type StudioJob = {
  kind: "pack" | "shorts" | "autofill"
  channel: string
  /** HH:MM for the days found on the channel's calendar. */
  time?: string
  /** The first day to look at (YYYY-MM-DD); tomorrow when left out. */
  from?: string | null
  /** Click Schedule once a short is filled (only scheduled ones). */
  finish: boolean
  items?: StudioJobItem[]
}

export type StudioJobResult = YoutubeFillResult & { label: string; tabId?: number }

export type StudioJobState = {
  kind: StudioJob["kind"]
  channel: string
  status: "running" | "done" | "failed"
  startedAt: string
  finishedAt?: string
  log: string[]
  results: StudioJobResult[]
}

const KEY = "studioJob"
const CHUNK = 1024 * 1024
let running = false

const save = (state: StudioJobState) => chrome.storage.local.set({ [KEY]: state })

function tomorrow(): string {
  const day = new Date()
  day.setDate(day.getDate() + 1)
  return isoDay(day)
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function startStudioJob(job: StudioJob): Promise<{ ok: boolean; error?: string }> {
  if (running) return { ok: false, error: "A YouTube Studio job is already running; wait for it to finish." }
  if (!job.channel?.trim()) return { ok: false, error: "Name the channel (its @handle)." }
  if (job.kind !== "autofill" && !job.items?.length) return { ok: false, error: "There's nothing to upload." }
  running = true
  const state: StudioJobState = { kind: job.kind, channel: job.channel, status: "running", startedAt: new Date().toISOString(), log: [], results: [] }
  await save(state)
  void run(job, state)
  return { ok: true }
}

async function run(job: StudioJob, state: StudioJobState) {
  // Calling an extension API every 20 s keeps the service worker alive through long uploads.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000)
  const log = async (line: string) => {
    state.log.push(line)
    await save(state)
  }
  try {
    if (job.kind === "autofill") await autofillDrafts(job, state, log)
    else await uploadAll(job, state, log)
    state.status = "done"
  } catch (error) {
    state.status = "failed"
    state.log.push(errorText(error))
  } finally {
    clearInterval(keepAlive)
    state.finishedAt = new Date().toISOString()
    running = false
    await save(state)
    await clearJobFiles()
  }
}

/** Days with no short yet on the channel, from its Shorts tab. */
async function freeDays(job: StudioJob, count: number, log: (line: string) => Promise<void>, tab?: { tabId: number; channelId: string }) {
  const own = tab ?? (await openChannelTab(job.channel))
  try {
    await log(`Reading ${job.channel}'s Shorts to find days with no short…`)
    const shorts = await readShortsList(own.tabId, own.channelId)
    const taken = shorts.filter((short) => !short.draft && short.date).map((short) => short.date as string)
    return { shorts, days: emptyDays(taken, count, job.from || tomorrow()) }
  } finally {
    if (!tab) await chrome.tabs.remove(own.tabId).catch(() => {})
  }
}

async function sendFile(sessionId: string, fileId: string, key: string) {
  const file = await getJobFile(key)
  if (!file) throw new Error("A file of this job is missing; choose the folder again.")
  const total = Math.max(1, Math.ceil(file.size / CHUNK))
  for (let index = 0; index < total; index++) {
    const bytes = new Uint8Array(await file.slice(index * CHUNK, (index + 1) * CHUNK).arrayBuffer())
    let binary = ""
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    await youtubeStudioCommands["youtube.uploadChunk"]({
      sessionId,
      fileId,
      name: file.name,
      mime: file.type,
      index,
      total,
      base64: btoa(binary)
    })
  }
}

async function uploadAll(job: StudioJob, state: StudioJobState, log: (line: string) => Promise<void>) {
  const items = job.items || []
  const needing = items.filter((item) => item.needsDay)
  const days = needing.length ? (await freeDays(job, needing.length, log)).days : []
  let next = 0
  for (const item of items) {
    const fields = { ...item.fields }
    if (item.needsDay) {
      fields.visibility = "scheduled"
      fields.scheduleAt = `${days[next++]}T${job.time || "18:30"}`
    }
    await log(`Uploading ${item.label}${item.needsDay ? ` for ${fields.scheduleAt}` : ""}…`)
    let opened: { sessionId: string; tabId: number } | null = null
    try {
      opened = (await youtubeStudioCommands["youtube.uploadOpen"]({ infoJson: JSON.stringify(fields) })) as { sessionId: string; tabId: number }
      await sendFile(opened.sessionId, "video", item.files.video)
      if (item.files.thumbnail) await sendFile(opened.sessionId, "thumbnail", item.files.thumbnail)
      const abThumbnailIds = item.files.ab.map((_, index) => `ab-${index}`)
      for (const [index, key] of item.files.ab.entries()) await sendFile(opened.sessionId, abThumbnailIds[index], key)
      const result = (await youtubeStudioCommands["youtube.uploadCommit"]({
        sessionId: opened.sessionId,
        videoId: "video",
        thumbnailId: item.files.thumbnail ? "thumbnail" : undefined,
        abThumbnailIds: abThumbnailIds.length ? abThumbnailIds : undefined,
        finish: job.finish
      })) as StudioJobResult
      state.results.push({ ...result, label: item.label })
    } catch (error) {
      if (opened) await youtubeStudioCommands["youtube.uploadAbort"]({ sessionId: opened.sessionId }).catch(() => {})
      state.results.push({ ok: false, label: item.label, message: errorText(error), warnings: [], filled: [], tabId: opened?.tabId })
    }
    await save(state)
  }
}

/** Keeps the fields Studio's form takes: a value the parser refuses (a dropdown read in another language) is dropped. */
function fillable(fields: Record<string, unknown>) {
  const kept = { ...fields }
  let parsed = parseYoutubeUploadInfo(kept)
  for (const error of parsed.errors) {
    const key = Object.keys(kept).find((name) => error.startsWith(`${name} `))
    if (key && key !== "title" && key !== "channel" && key !== "scheduleAt") delete kept[key]
  }
  parsed = parseYoutubeUploadInfo(kept)
  if (parsed.errors.length) throw new Error(parsed.errors.join(" "))
  return { info: parsed.info, dropped: Object.keys(fields).filter((key) => !(key in kept)) }
}

async function autofillDrafts(job: StudioJob, state: StudioJobState, log: (line: string) => Promise<void>) {
  const tab = await openChannelTab(job.channel)
  const { shorts } = await freeDays(job, 0, log, tab)
  const drafts = shorts.filter((short) => short.draft)
  const filled = shorts.filter((short) => !short.draft)
  if (!drafts.length) {
    await log(`${tab.name || job.channel} has no Shorts drafts.`)
    await chrome.tabs.remove(tab.tabId).catch(() => {})
    return
  }
  if (!filled.length) throw new Error(`${tab.name || job.channel} has no filled-in short to copy the details from.`)
  const taken = filled.filter((short) => short.date).map((short) => short.date as string)
  const days = emptyDays(taken, drafts.length, job.from || tomorrow())
  await log(`${drafts.length} draft${drafts.length === 1 ? "" : "s"}: on ${days.join(", ")} at ${job.time || "18:30"}.`)

  const details = new Map<string, Record<string, unknown>>()
  let tabId = tab.tabId
  for (const [index, draft] of drafts.entries()) {
    const pick = pickReference(draft.title, filled)!
    const label = `${draft.title} → ${days[index]}`
    try {
      if (!details.has(pick.short.videoId)) {
        await log(`Reading "${pick.short.title}" to copy its details…`)
        details.set(pick.short.videoId, await readVideoDetails(tabId, pick.short.videoId))
      }
      const { info, dropped } = fillable({
        ...details.get(pick.short.videoId),
        channel: job.channel,
        title: pick.short.title,
        visibility: "scheduled",
        scheduleAt: `${days[index]}T${job.time || "18:30"}`
      })
      await log(`Filling ${draft.title} like "${pick.short.title}"${pick.similar ? "" : " (the latest short; no title like it)"}…`)
      const result = await fillDraft(tabId, tab.channelId, draft.videoId, info, job.finish)
      if (dropped.length) result.warnings.push(`Not copied (Studio showed them in a form Browse Hack doesn't read): ${dropped.join(", ")}.`)
      state.results.push({ ...result, label, tabId })
      // A draft left open for its Schedule click keeps this tab; the next one gets its own.
      if (!result.scheduled && index < drafts.length - 1) tabId = (await chrome.tabs.create({ url: "https://studio.youtube.com/", active: false })).id!
    } catch (error) {
      state.results.push({ ok: false, label, message: errorText(error), warnings: [], filled: [], tabId })
    }
    await save(state)
  }
}
