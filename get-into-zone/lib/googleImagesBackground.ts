// Google Images bulk download sessions, one per tab, like the Pinterest ones
// (pinterestBulkBackground.ts): kept in chrome.storage.session, so they end
// when the tab closes or the browser quits. Unlike Pinterest, a session runs
// the tab itself: it reads the results' original images from the page
// (googleImagesPage.ts), clicks Google's own "More results" when it needs
// more, and stops once `count` images are saved or Google has no more.

import { downloadFile } from "./downloads"
import {
  GI_DEFAULT_COUNT,
  GI_MAX_COUNT,
  GI_SESSION_PREFIX,
  GI_TOOL,
  RESULT_PATTERN,
  decodeResult,
  giSessionKey,
  giSkipKey,
  googleImagesQuery,
  imageFileName,
  imageKey,
  isGoogleImagesUrl,
  isImageDownload,
  retireGiSession,
  type GiDestination,
  type GiItem,
  type GiSession
} from "./googleImages"
import { collectGoogleImages, type GiPage } from "./googleImagesPage"
import { cleanFolder, downloadFinished, saveSourceSidecar } from "./libraryFiles"
import { queueSparkboardIndex } from "./mediamake"

const CONCURRENCY: Record<GiDestination, number> = { browser: 3, mediamake: 2 }
// A download that hasn't finished by then is cancelled and counted as failed.
const DOWNLOAD_TIMEOUT_MS = 90_000
// How long a stop waits for saves still running.
const STOP_WAIT_MS = 60_000
// After asking Google for more results, how long to wait before reading them.
const MORE_WAIT_MS = 2500
// Rounds in a row with nothing new before the results count as ended: fewer
// once Google's "More results" button is gone.
const IDLE_ROUNDS = 8
const IDLE_ROUNDS_NO_BUTTON = 3
// Results read from the page per round.
const READ_LIMIT = 200

const sessions = new Map<number, GiSession>()
const seenSets = new WeakMap<GiSession, Set<string>>()
const running = new WeakMap<GiSession, Set<string>>()
const saving = new WeakMap<GiSession, Set<Promise<unknown>>>()
const driving = new WeakSet<GiSession>()
const skipSets = new Map<number, Promise<Set<string>>>()
let loading: Promise<void> | null = null

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

const loadSessions = () => {
  loading ??= chrome.storage.session.get(null).then((all) => {
    Object.entries(all).forEach(([key, value]) => {
      if (key.startsWith(GI_SESSION_PREFIX) && typeof value?.tabId === "number") {
        sessions.set(value.tabId, value as GiSession)
      }
    })
  })
  return loading
}

const getSession = async (tabId?: number) => {
  if (tabId === undefined) return undefined
  await loadSessions()
  return sessions.get(tabId)
}

const isCurrent = (session: GiSession) => sessions.get(session.tabId) === session

// Storage full (10 MB for the whole extension): the counts live on in memory.
const persist = (session: GiSession) =>
  isCurrent(session)
    ? chrome.storage.session.set({ [giSessionKey(session.tabId)]: session }).catch(() => undefined)
    : Promise.resolve()

const setOf = <T>(map: WeakMap<GiSession, Set<T>>, session: GiSession) => {
  let set = map.get(session)
  if (!set) {
    set = new Set()
    map.set(session, set)
  }
  return set
}

const seenSet = (session: GiSession) => {
  let set = seenSets.get(session)
  if (!set) {
    set = new Set(session.seen)
    seenSets.set(session, set)
  }
  return set
}

// The image addresses MediaMake's media library has, from the MCP server.
const skipSet = (session: GiSession) => {
  if (!session.skipping) return Promise.resolve(undefined)
  let set = skipSets.get(session.tabId)
  if (!set) {
    const key = giSkipKey(session.tabId)
    set = chrome.storage.session
      .get(key)
      .then((stored) => new Set<string>(Array.isArray(stored[key]) ? stored[key] : []))
    skipSets.set(session.tabId, set)
  }
  return set
}

// --- The tab -----------------------------------------------------------------

async function readPage(session: GiSession, loadMore: boolean): Promise<GiPage> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: session.tabId },
    world: "MAIN",
    func: collectGoogleImages,
    args: [RESULT_PATTERN, session.cursor, session.pageToken ?? null, loadMore, READ_LIMIT]
  })
  const page = injection?.result as GiPage | undefined
  if (!page) throw new Error("Couldn't read the Google Images tab.")
  return page
}

// --- Saving ------------------------------------------------------------------

// Resolves with the saved file's path, or rejects when it fails or takes too long.
async function finished(downloadId: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      downloadFinished(downloadId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          chrome.downloads.cancel(downloadId).catch(() => undefined)
          reject(new Error("The image took too long to download."))
        }, DOWNLOAD_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

async function saveItem(session: GiSession, item: GiItem) {
  const fileName = imageFileName(item.url, item.title, item.id)

  if (session.destination === "mediamake") {
    const result = await queueSparkboardIndex({
      sourceUrl: item.url,
      tags: session.tags,
      contentMimeType: "image/jpeg",
      contentSubType: "general",
      contentSource: "web",
      contentSourceUrl: item.url,
      fileName,
      metadata: {
        platform: "web",
        platformId: "web",
        platformUrl: item.pageUrl,
        imageLink: item.url,
        src: item.url,
        alt: item.title
      }
    })
    if (!result.success) throw new Error(result.message || "Upload failed.")
    return fileName
  }

  const requested = `${session.folder}/${fileName}`
  const downloadId = await downloadFile(
    { url: item.url, filename: requested, conflictAction: "uniquify", saveAs: false },
    { extensionFromMime: true }
  )
  const path = await finished(downloadId)
  const [download] = await chrome.downloads.search({ id: downloadId })
  // A page saying "forbidden" or "not found" instead of the image.
  if (!isImageDownload(download?.mime, item.url)) {
    await chrome.downloads.removeFile(downloadId).catch(() => undefined)
    await chrome.downloads.erase({ id: downloadId }).catch(() => undefined)
    throw new Error(`${hostOf(item.url)} sent ${download?.mime || "something"} instead of the image.`)
  }
  if (session.sidecars) {
    await saveSourceSidecar(requested, path, {
      tool: GI_TOOL,
      ref: item.url,
      url: item.url,
      pageUrl: item.pageUrl,
      title: item.title,
      query: item.query,
      height: item.height
    }).catch(() => undefined)
  }
  return path.split(/[\\/]/).pop()!
}

function pump(session: GiSession) {
  if (!session.active || !isCurrent(session)) return
  const busy = setOf(running, session)
  const tracked = setOf(saving, session)
  while (busy.size < CONCURRENCY[session.destination] && session.saved + busy.size < session.count) {
    const item = session.pending.find((p) => !busy.has(p.id))
    if (!item) return
    busy.add(item.id)
    const work: Promise<void> = saveItem(session, item)
      .then((file) => {
        session.saved++
        session.lastFile = file
      })
      .catch((error) => {
        session.failed++
        session.lastError = message(error)
      })
      .finally(() => {
        busy.delete(item.id)
        tracked.delete(work)
        session.pending = session.pending.filter((p) => p.id !== item.id)
        persist(session)
        pump(session)
      })
    tracked.add(work)
  }
}

async function savesDone(session: GiSession, waitMs: number) {
  const pending = [...(saving.get(session) ?? [])]
  if (!pending.length) return
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => (timer = setTimeout(resolve, waitMs)))
  ])
  clearTimeout(timer)
}

// --- The session's run ------------------------------------------------------

// Takes a result if it's new, big enough and not in the library.
async function consider(session: GiSession, card: GiPage["cards"][number], page: GiPage) {
  const result = decodeResult(card.groups)
  if (!result) return
  session.found++
  const seen = seenSet(session)
  const key = imageKey(result.url)
  if (seen.has(`id:${card.id}`) || seen.has(key)) {
    session.duplicates++
    return
  }
  seen.add(`id:${card.id}`)
  seen.add(key)
  session.seen.push(`id:${card.id}`, key)
  if (result.width < session.minWidth || result.height < session.minHeight) {
    session.tooSmall++
    return
  }
  if ((await skipSet(session))?.has(result.url)) {
    session.skippedInLibrary++
    return
  }
  session.pending.push({
    id: card.id,
    url: result.url,
    width: result.width,
    height: result.height,
    pageUrl: card.pageUrl,
    title: card.title,
    query: page.query || session.query,
    searchUrl: page.url
  })
}

async function finish(session: GiSession, reason: string) {
  if (!isCurrent(session)) return
  session.active = false
  session.endReason ??= reason
  await savesDone(session, STOP_WAIT_MS)
  retireGiSession(session)
  skipSets.delete(session.tabId)
  await chrome.storage.session.remove(giSkipKey(session.tabId)).catch(() => undefined)
  await persist(session)
}

async function drive(session: GiSession) {
  if (driving.has(session)) return
  driving.add(session)
  let idle = 0
  try {
    while (session.active && isCurrent(session)) {
      const busy = setOf(running, session).size
      if (session.saved >= session.count) return await finish(session, `Saved ${session.count} images.`)
      const want = session.count - session.saved - busy
      if (session.pending.length >= want) {
        pump(session)
        await sleep(800)
        continue
      }

      const tab = await chrome.tabs.get(session.tabId).catch(() => undefined)
      if (!tab) return await finish(session, "The tab was closed.")
      if (!isGoogleImagesUrl(tab.url)) {
        return await finish(session, "The tab left Google Images.")
      }
      let page: GiPage
      try {
        page = await readPage(session, false)
      } catch (error) {
        return await finish(session, `Couldn't read the tab: ${message(error)}`)
      }
      if (page.blocked) {
        return await finish(
          session,
          "Google is showing its unusual-traffic check in this tab. Clear it there yourself, then start again."
        )
      }
      session.page = {
        cards: page.cardsOnPage,
        read: page.total,
        waiting: page.waiting,
        moreButton: page.more,
        moreClicks: session.page?.moreClicks ?? 0
      }
      if (page.token !== session.pageToken) {
        // The page was reloaded: its results are read again from the top (the
        // ones taken are known by their ids and addresses).
        session.pageToken = page.token
        session.cursor = 0
      }
      for (const card of page.cards) {
        session.cursor++
        await consider(session, card, page)
        if (session.pending.length >= want + CONCURRENCY[session.destination]) break
      }
      pump(session)
      await persist(session)
      if (session.pending.length >= want) continue

      // Every result on the page is read: ask Google for more.
      const gotNew = page.cards.length > 0
      idle = gotNew ? 0 : idle + 1
      const ended = idle >= (page.more || page.waiting ? IDLE_ROUNDS : IDLE_ROUNDS_NO_BUTTON)
      if (ended) {
        if (setOf(running, session).size === 0 && session.pending.length === 0) {
          return await finish(session, `Google has no more results for this search (saved ${session.saved}).`)
        }
        await sleep(1000)
        continue
      }
      if (!gotNew) {
        const clicked = await readPage(session, true).then((p) => p.clicked, () => false)
        if (clicked && session.page) session.page.moreClicks++
      }
      await sleep(gotNew ? 200 : MORE_WAIT_MS)
    }
  } catch (error) {
    session.lastError = message(error)
    await finish(session, `Stopped: ${message(error)}`)
  } finally {
    driving.delete(session)
  }
}

// --- Start, stop, list -----------------------------------------------------

export interface GiStartRequest {
  tabId: number
  destination?: GiDestination
  folder: string
  sidecars?: boolean
  tags?: string[]
  count?: number
  minWidth?: number
  minHeight?: number
  // Image addresses MediaMake's library has (from the MCP server).
  skipRefs?: string[]
}

const whole = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : fallback
}

export async function startGiSession(request: GiStartRequest) {
  const tabId = Number(request.tabId)
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  if (!tab || !isGoogleImagesUrl(tab.url)) {
    return { success: false as const, message: "Open a Google Images search in this tab first." }
  }
  const folder = cleanFolder(request.folder) || "google-images"
  const skipRefs = Array.isArray(request.skipRefs)
    ? request.skipRefs.filter((ref): ref is string => typeof ref === "string")
    : []
  const session: GiSession = {
    tabId,
    active: true,
    destination: request.destination === "mediamake" ? "mediamake" : "browser",
    folder,
    sidecars: request.destination !== "mediamake" && request.sidecars === true,
    tags: Array.isArray(request.tags) ? request.tags : [],
    count: Math.max(1, whole(request.count, GI_DEFAULT_COUNT, GI_MAX_COUNT)),
    minWidth: whole(request.minWidth, 0),
    minHeight: whole(request.minHeight, 0),
    query: googleImagesQuery(tab.url),
    searchUrl: tab.url ?? "",
    startedAt: Date.now(),
    cursor: 0,
    seen: [],
    pending: [],
    found: 0,
    saved: 0,
    failed: 0,
    tooSmall: 0,
    duplicates: 0,
    skippedInLibrary: 0,
    ...(skipRefs.length ? { skipping: skipRefs.length } : {})
  }

  await loadSessions()
  // A session still running in this tab is stopped by this one.
  const previous = sessions.get(tabId)
  if (previous?.active) {
    previous.active = false
    previous.endReason = "A new session started in this tab."
  }
  sessions.set(tabId, session)
  skipSets.delete(tabId)
  try {
    if (skipRefs.length) {
      skipSets.set(tabId, Promise.resolve(new Set(skipRefs)))
      await chrome.storage.session.set({ [giSkipKey(tabId)]: skipRefs })
    } else {
      await chrome.storage.session.remove(giSkipKey(tabId))
    }
    await chrome.storage.session.set({ [giSessionKey(tabId)]: session })
  } catch (error) {
    sessions.delete(tabId)
    return { success: false as const, message: `Couldn't keep the session in Chrome's storage: ${message(error)}` }
  }
  drive(session)
  return { success: true as const, session }
}

// Stops the tab's session once its downloads still running are done, and
// returns its counts.
export async function stopGiSession(tabId: number) {
  const session = await getSession(tabId)
  if (!session) return { success: true, stopped: false }
  if (session.active) {
    session.active = false
    session.endReason ??= "Stopped."
    session.pending = []
    await persist(session)
  }
  await finish(session, "Stopped.")
  return {
    success: true,
    stopped: true,
    saved: session.saved,
    failed: session.failed,
    found: session.found,
    tooSmall: session.tooSmall,
    skippedInLibrary: session.skippedInLibrary,
    folder: session.folder,
    endReason: session.endReason
  }
}

export async function listGiSessions() {
  await loadSessions()
  return [...sessions.values()]
}

export function initGoogleImagesBackground() {
  // A worker restarted mid-session carries on.
  loadSessions().then(() =>
    sessions.forEach((session) => {
      if (session.active) drive(session)
    })
  )

  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = sessions.get(tabId)
    if (session) session.active = false
    sessions.delete(tabId)
    skipSets.delete(tabId)
    chrome.storage.session.remove([giSessionKey(tabId), giSkipKey(tabId)]).catch(() => undefined)
  })

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    let response: Promise<unknown>
    switch (request?.action) {
      case "googleImagesBulkStart":
        response = startGiSession(request).then((result) =>
          result.success ? { success: true } : result
        )
        break
      case "googleImagesBulkStop":
        response = stopGiSession(Number(request.tabId))
        break
      default:
        return
    }
    response.then(sendResponse, (error) => sendResponse({ success: false, message: message(error) }))
    return true
  })
}
