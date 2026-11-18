// MCP entry for YouTube Studio. Lists and switches the profile's channels, and
// fills the upload dialog: the Node server reads the folder and streams the
// video and thumbnail here in small pieces; this opens one Studio tab, switches
// to the channel info.json names, opens the upload dialog and hands the files
// to the content script. Nothing is saved or published.

import { closeStudioTab, inFront } from "./studioFront"
import { openTab, waitForTabLoad } from "./tabs"
import { emptyDays, isoDay, type StudioShort } from "./youtubeShorts"
import {
  channelIdFromPage,
  channelKey,
  parseYoutubeUploadInfo,
  type YoutubeChannel,
  type YoutubeFillResult,
  type YoutubeUploadInfo
} from "./youtubeUpload"

const STUDIO = "https://studio.youtube.com/"

type PageState = {
  ok?: boolean
  ready?: boolean
  channelId?: string
  /** Studio's ?c=: set on a channel shared with you (you're its manager, editor…). */
  context?: string
  channelName?: string
  uploadReady?: boolean
}

/**
 * A Studio page of the channel. A channel shared with you through its permissions only opens with
 * Studio's ?c=<its id> (without it Studio shows "Oops"), so that is kept when Studio set it.
 */
function studioUrl(path: string, context = "", params: Record<string, string> = {}) {
  const url = new URL(path, STUDIO)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  if (context) url.searchParams.set("c", context)
  return url.toString()
}

type Session = { tabId: number; port: chrome.runtime.Port; info: YoutubeUploadInfo }

const sessions = new Map<string, Session>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function ping(tabId: number): Promise<PageState | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: "giz-ytstudio-ping" })
  } catch {
    return null
  }
}

async function waitForStudio(
  tabId: number,
  test: (state: PageState) => boolean = (state) => !!state.ready,
  timeoutMs = 30_000
): Promise<PageState> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const state = await ping(tabId)
    if (state?.ok && test(state)) return state
    await sleep(500)
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (tab?.url?.includes("accounts.google.com")) {
    throw new Error("This Chrome profile isn't signed in to YouTube. Sign in at https://studio.youtube.com and try again.")
  }
  throw new Error("YouTube Studio didn't finish loading.")
}

/** A UC… id can't be picked in Studio's list, so look up its @handle. */
async function handleForChannelId(id: string): Promise<string> {
  const response = await fetch(`https://www.youtube.com/channel/${id}`, { credentials: "omit" })
  const html = await response.text()
  const handle =
    html.match(/"vanityChannelUrl":"https?:\/\/www\.youtube\.com\/(@[^"]+)"/)?.[1] ||
    html.match(/"canonicalBaseUrl":"\/(@[^"]+)"/)?.[1]
  if (!handle) throw new Error(`Couldn't find the @handle of channel ${id}. Put the handle in info.json instead.`)
  return decodeURIComponent(handle)
}

type SwitchReply = {
  ok: boolean
  error?: string
  already?: boolean
  switched?: boolean
  channel?: YoutubeChannel
  channels?: YoutubeChannel[]
}

const handleIds = new Map<string, string>()

/** The UC… id of an @handle, from its public channel page ("" when YouTube doesn't say). */
async function channelIdForHandle(handle: string): Promise<string> {
  const known = handleIds.get(handle)
  if (known) return known
  try {
    const response = await fetch(`https://www.youtube.com/${encodeURI(handle)}`, {
      credentials: "omit",
      signal: AbortSignal.timeout(10_000)
    })
    const id = response.ok ? channelIdFromPage(await response.text()) : ""
    if (id) handleIds.set(handle, id)
    return id
  } catch {
    return ""
  }
}

/** The channel to switch to. A handle Studio is already on counts as its id, so no switch (or trip to the front) is needed. */
async function channelWanted(wanted: string, state: PageState) {
  const key = channelKey(wanted)
  if (key.kind === "handle" && state.channelId && (await channelIdForHandle(key.value)) === state.channelId) {
    return { kind: "id" as const, value: state.channelId }
  }
  return key
}

/** Makes the tab's Studio (and the whole profile's YouTube) act as this channel. */
async function ensureChannel(tabId: number, wanted: string) {
  let state = await waitForStudio(tabId)
  const key = await channelWanted(wanted, state)
  if (key.kind === "id" && state.channelId === key.value) {
    return { channelId: key.value, context: state.context || "", name: state.channelName || "", switched: false }
  }
  const target = key.kind === "id" ? await handleForChannelId(key.value) : wanted
  // The account menu only opens in a tab Chrome paints. Studio's reload on the new channel runs behind the user's tab.
  const reply = await inFront(
    tabId,
    async () => (await chrome.tabs.sendMessage(tabId, { action: "giz-ytstudio-switch", channel: target })) as SwitchReply | undefined
  )
  if (!reply?.ok || !reply.channel) {
    const list = (reply?.channels || []).map((channel) => `${channel.name} (${channel.handle})`).join(", ")
    throw new Error(`${reply?.error || "Couldn't switch the YouTube channel."}${list ? ` Channels: ${list}.` : ""}`)
  }
  const channel = reply.channel
  if (!reply.already) {
    // Studio reloads on the new channel's dashboard.
    await sleep(1000)
    await waitForTabLoad(tabId, 30_000).catch(() => {})
    state = await waitForStudio(
      tabId,
      (next) => !!next.ready && !!next.channelId && next.channelName === channel.name,
      30_000
    ).catch(() => {
      // Studio ignores the switch while an upload dialog is open on the page.
      throw new Error(`YouTube Studio didn't switch to ${channel.name} (${channel.handle}). Try again, or switch in Studio by hand.`)
    })
  }
  return {
    channelId: state.channelId || "",
    context: state.context || "",
    name: channel.name,
    handle: channel.handle,
    switched: !reply.already
  }
}

/** A Studio tab for one quick job, closed afterwards (it comes to the front while it reads or uses the account menu). */
async function withStudioTab<T>(run: (tabId: number) => Promise<T>): Promise<T> {
  const tab = await openTab(STUDIO, false, true)
  if (!tab.id) throw new Error("Chrome did not open a YouTube Studio tab.")
  try {
    return await run(tab.id)
  } finally {
    await closeStudioTab(tab.id)
  }
}

// --- For the popup's Studio jobs (lib/studioJobs.ts) ---

/** A Studio tab acting as this channel (it switches the whole profile's YouTube to it). */
export async function openChannelTab(channel: string) {
  const tab = await openTab(STUDIO, false, true)
  if (!tab.id) throw new Error("Chrome did not open a YouTube Studio tab.")
  try {
    return { tabId: tab.id, ...(await ensureChannel(tab.id, channel)) }
  } catch (error) {
    await closeStudioTab(tab.id)
    throw error
  }
}

async function goTo(tabId: number, url: string) {
  await chrome.tabs.update(tabId, { url })
  await sleep(500)
  await waitForTabLoad(tabId, 30_000).catch(() => {})
  await waitForStudio(tabId)
}

/** Reads Studio's page; its lists and dialogs only show in a tab Chrome paints, so the tab comes forward meanwhile. */
async function ask<T>(tabId: number, action: string, key: string): Promise<T> {
  const reply = await inFront(tabId, () => chrome.tabs.sendMessage(tabId, { action }))
  if (!reply?.ok) throw new Error(reply?.error || "YouTube Studio didn't answer.")
  return reply[key] as T
}

/** The channel's Shorts tab, every page of it. */
export async function readShortsList(tabId: number, channelId: string, context = ""): Promise<StudioShort[]> {
  await goTo(tabId, studioUrl(`channel/${channelId}/videos/short`, context))
  return ask<StudioShort[]>(tabId, "giz-ytstudio-shorts", "shorts")
}

const CHUNK = 1024 * 1024

/** A file as the base64 pieces the Studio tab's port takes (port messages are JSON). */
export async function* fileChunks(file: Blob) {
  const total = Math.max(1, Math.ceil(file.size / CHUNK))
  for (let index = 0; index < total; index++) {
    const bytes = new Uint8Array(await file.slice(index * CHUNK, (index + 1) * CHUNK).arrayBuffer())
    let binary = ""
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    yield { index, total, base64: btoa(binary) }
  }
}

/** A video's details from its Studio page, as info.json fields. */
export async function readVideoDetails(tabId: number, videoId: string, context = ""): Promise<Record<string, unknown>> {
  await goTo(tabId, studioUrl(`video/${videoId}/edit`, context))
  return ask<Record<string, unknown>>(tabId, "giz-ytstudio-details", "fields")
}

type DraftFiles = { thumbnail?: File; abThumbnails?: File[] }

/**
 * Sends the files to the Studio tab, then the fill message, and waits for the form's result. Studio's form
 * only works in a tab Chrome paints, so the tab is in front while it fills.
 */
async function fillOverPort(tabId: number, message: Record<string, unknown>, { thumbnail, abThumbnails = [] }: DraftFiles = {}) {
  const port = chrome.tabs.connect(tabId, { name: "giz-youtube-upload" })
  const send = async (id: string, file: File) => {
    for await (const chunk of fileChunks(file)) {
      if (chunk.index === 0) port.postMessage({ type: "file-start", id, name: file.name, mime: file.type, total: chunk.total })
      port.postMessage({ type: "chunk", id, ...chunk })
    }
  }
  try {
    if (thumbnail) await send("thumbnail", thumbnail)
    const abThumbnailIds = abThumbnails.map((_, index) => `ab-${index}`)
    for (const [index, file] of abThumbnails.entries()) await send(abThumbnailIds[index], file)
    return await inFront(tabId, () => new Promise<YoutubeFillResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("YouTube Studio took too long to fill the draft.")), 300_000)
      port.onMessage.addListener((msg: any) => {
        if (msg?.type !== "result" || !msg.result) return
        clearTimeout(timer)
        resolve(msg.result)
      })
      port.onDisconnect.addListener(() => {
        clearTimeout(timer)
        reject(new Error("Lost the YouTube Studio tab before the draft was filled."))
      })
      port.postMessage({
        ...message,
        thumbnailId: thumbnail ? "thumbnail" : undefined,
        abThumbnailIds: abThumbnailIds.length ? abThumbnailIds : undefined
      })
    }))
  } finally {
    port.disconnect()
  }
}

/** Opens a draft from the channel's Shorts list and fills its upload dialog. */
export async function fillDraft(
  tabId: number,
  channelId: string,
  draftId: string,
  info: YoutubeUploadInfo,
  finish: boolean,
  context = ""
): Promise<YoutubeFillResult> {
  await goTo(tabId, studioUrl(`channel/${channelId}/videos/short`, context))
  return fillOverPort(tabId, { type: "fill-draft", info, draftId, finish })
}

/** Whether this Studio page is on another channel than info.json names (a warning, never a switch: that would close the dialog). */
async function otherChannel(state: PageState, wanted: string): Promise<boolean> {
  const key = channelKey(wanted)
  if (key.kind === "name") return !!state.channelName && state.channelName.replace(/\s+/g, " ").toLowerCase() !== key.value
  const id = key.kind === "id" ? key.value : await channelIdForHandle(key.value)
  return !!id && !!state.channelId && id !== state.channelId
}

/**
 * Fills the upload dialog the user opened in this Studio tab (a draft's Edit draft) from info.json: everything
 * but the video, which is up already. The tab stays as it is: no channel switch, no other page.
 */
export async function fillOpenDraft(tabId: number, info: YoutubeUploadInfo, finish: boolean, files: DraftFiles = {}) {
  const state = await ping(tabId)
  if (!state?.ok) throw new Error("Browse Hack can't reach this YouTube Studio tab. Reload it, open the draft again, then click Fill the open draft.")
  const result = await fillOverPort(tabId, { type: "fill-open", info, finish }, files)
  if (await otherChannel(state, info.channel)) {
    result.warnings.unshift(`This draft is on ${state.channelName || state.channelId}, not ${info.channel} (info.json's channel). Check it's the right draft.`)
  }
  return result
}

function takeSession(sessionId: unknown): Session {
  const session = sessions.get(String(sessionId || ""))
  if (!session) throw new Error("That YouTube Studio tab is no longer being filled. Start that folder again.")
  return session
}

export const youtubeStudioCommands: Record<string, (params: any) => Promise<unknown>> = {
  "youtube.channels": async () =>
    withStudioTab(async (tabId) => {
      await waitForStudio(tabId)
      const reply = await inFront(tabId, () => chrome.tabs.sendMessage(tabId, { action: "giz-ytstudio-channels" }))
      if (!reply?.ok) throw new Error(reply?.error || "Couldn't read YouTube Studio's channel list.")
      return { channels: reply.channels as YoutubeChannel[] }
    }),

  "youtube.switchChannel": async ({ channel }) => {
    const wanted = String(channel || "").trim()
    if (!wanted) throw new Error("Name the channel: its @handle, name or channel id.")
    const result = await withStudioTab((tabId) => ensureChannel(tabId, wanted))
    return {
      ...result,
      note: "YouTube and YouTube Studio in this Chrome profile now act as this channel. Tabs already open keep the channel they loaded with until reloaded."
    }
  },

  /** For the MCP's youtube_bulk_upload_shorts: the first `count` days from `from` (default tomorrow) with no short on
   *  the channel's Shorts tab. It switches the profile's YouTube to the channel, as an upload would. */
  "youtube.shortsFreeDays": async ({ channel, count, from }) => {
    const wanted = String(channel || "").trim()
    if (!wanted) throw new Error("Name the channel: its @handle, name or channel id.")
    const first = String(from || "").trim()
    if (first && !/^\d{4}-\d{2}-\d{2}$/.test(first)) throw new Error('from must be "YYYY-MM-DD".')
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tab = await openChannelTab(wanted)
    try {
      const shorts = await readShortsList(tab.tabId, tab.channelId, tab.context)
      const taken = [...new Set(shorts.filter((short) => !short.draft && short.date).map((short) => short.date as string))].sort()
      return {
        channel: { name: tab.name, handle: tab.handle },
        days: emptyDays(taken, Math.max(0, Number(count) || 0), first || isoDay(tomorrow)),
        taken,
        drafts: shorts.filter((short) => short.draft).length
      }
    } finally {
      await closeStudioTab(tab.tabId)
    }
  },

  "youtube.uploadOpen": async ({ infoJson }) => {
    let raw: unknown
    try {
      raw = JSON.parse(String(infoJson ?? "").replace(/^﻿/, ""))
    } catch {
      throw new Error("info.json is not valid JSON.")
    }
    const parsed = parseYoutubeUploadInfo(raw)
    if (parsed.errors.length) throw new Error(parsed.errors.join("\n"))

    const tab = await openTab(STUDIO, false, true)
    if (!tab.id) throw new Error("Chrome did not open a YouTube Studio tab.")
    const tabId = tab.id
    try {
      const channel = await ensureChannel(tabId, parsed.info.channel)
      await chrome.tabs.update(tabId, { url: studioUrl(`channel/${channel.channelId}/videos/upload`, channel.context, { d: "ud" }) })
      await sleep(500)
      await waitForTabLoad(tabId, 30_000).catch(() => {})
      // The upload dialog only shows once the tab is painted; youtube.uploadCommit brings it forward and waits for it.
      await waitForStudio(tabId)
      const port = chrome.tabs.connect(tabId, { name: "giz-youtube-upload" })
      const sessionId = crypto.randomUUID()
      sessions.set(sessionId, { tabId, port, info: parsed.info })
      port.onDisconnect.addListener(() => {
        if (sessions.get(sessionId)?.port === port) sessions.delete(sessionId)
      })
      return { sessionId, tabId, channel, warnings: parsed.warnings }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${message} (tab ${tabId})`)
    }
  },

  "youtube.uploadChunk": async ({ sessionId, fileId, name, mime, index, total, base64 }) => {
    const session = takeSession(sessionId)
    const id = String(fileId)
    if (index === 0 || total === 0) {
      session.port.postMessage({
        type: "file-start",
        id,
        name: String(name || "file"),
        mime: String(mime || ""),
        total: Number(total) || 0
      })
    }
    if (Number(total) > 0 && base64) {
      session.port.postMessage({ type: "chunk", id, index: Number(index) || 0, base64: String(base64) })
    }
    return { ok: true }
  },

  "youtube.uploadCommit": async ({ sessionId, videoId, thumbnailId, abThumbnailIds, finish: clickSchedule }) => {
    const session = takeSession(sessionId)
    // Studio's upload dialog, its dropdowns and pickers only work in a tab Chrome paints (and timers in a
    // background tab run once a second), so the tab is in front while it fills, then the user's tab comes back.
    const result = await inFront(session.tabId, () => new Promise<any>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(
        () => finish(() => reject(new Error("YouTube Studio took too long to fill the upload form."))),
        300_000
      )
      const finish = (done: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.port.onMessage.removeListener(onMessage)
        done()
      }
      const onMessage = (msg: any) => {
        if (msg?.type === "result" && msg.result) finish(() => resolve(msg.result))
      }
      session.port.onMessage.addListener(onMessage)
      session.port.onDisconnect.addListener(() => {
        finish(() => reject(new Error("Lost the YouTube Studio tab before the form was filled.")))
      })
      session.port.postMessage({
        type: "fill",
        info: session.info,
        videoId: String(videoId || "video"),
        thumbnailId: thumbnailId ? String(thumbnailId) : undefined,
        abThumbnailIds: Array.isArray(abThumbnailIds) ? abThumbnailIds.map(String) : undefined,
        finish: clickSchedule === true
      })
    }))
    sessions.delete(sessionId)
    return { tabId: session.tabId, ...result }
  },

  "youtube.uploadAbort": async ({ sessionId }) => {
    const id = String(sessionId || "")
    const session = sessions.get(id)
    if (!session) return { aborted: false }
    sessions.delete(id)
    session.port.disconnect()
    return { aborted: true, tabId: session.tabId }
  }
}
