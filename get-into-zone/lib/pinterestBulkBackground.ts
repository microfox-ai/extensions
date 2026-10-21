import { queueSparkboardIndex } from "./mediamake"
import {
  BULK_SESSION_PREFIX,
  bulkItemKey,
  bulkSessionKey,
  pinImageUrls,
  sanitizeFolder,
  type BulkDestination,
  type BulkItem,
  type BulkItemKind,
  type BulkSession
} from "./pinterestBulk"
import { saveVideo } from "./pinterestVideoBackground"
import { isPinterestHost } from "./saverRules"

const CONCURRENCY: Record<BulkDestination, number> = {
  browser: 3,
  mediamake: 2
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp"
}

// The service worker can be stopped at any time, so sessions are persisted to
// chrome.storage.session after every change and reloaded on wake.
const sessions = new Map<number, BulkSession>()
const seenSets = new WeakMap<BulkSession, Set<string>>()
const inFlight = new WeakMap<BulkSession, Set<string>>()
let loading: Promise<void> | null = null

const loadSessions = () => {
  if (!loading) {
    loading = chrome.storage.session.get(null).then((all) => {
      Object.entries(all).forEach(([key, value]) => {
        if (key.startsWith(BULK_SESSION_PREFIX) && value?.tabId !== undefined) {
          sessions.set(value.tabId, value as BulkSession)
        }
      })
    })
  }
  return loading
}

const getSession = async (tabId?: number) => {
  if (tabId === undefined) return undefined
  await loadSessions()
  return sessions.get(tabId)
}

const persist = (session: BulkSession) =>
  chrome.storage.session.set({ [bulkSessionKey(session.tabId)]: session })

const seenSet = (session: BulkSession) => {
  let set = seenSets.get(session)
  if (!set) {
    set = new Set(session.seen)
    seenSets.set(session, set)
  }
  return set
}

const notifyTab = async (tabId: number) => {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "pinterestBulkSync" })
    return true
  } catch {
    return false
  }
}

async function resolveImageUrl(id: string) {
  const [best, fallback] = pinImageUrls(id)
  try {
    const resp = await fetch(best, { method: "HEAD" })
    if (resp.ok) return best
  } catch {
    // Fall through to the resized copy.
  }
  return fallback
}

async function saveImage(session: BulkSession, image: BulkItem) {
  const url = await resolveImageUrl(image.id)
  const fileName = image.id.split("/").pop()!

  if (session.destination === "browser") {
    await chrome.downloads.download({
      url,
      filename: `${session.folder}/${fileName}`,
      conflictAction: "uniquify",
      saveAs: false
    })
    return
  }

  const ext = fileName.split(".").pop()?.toLowerCase() ?? "jpg"
  const result = await queueSparkboardIndex({
    sourceUrl: url,
    tags: session.tags,
    contentMimeType: MIME_BY_EXT[ext] ?? "image/jpeg",
    contentSubType: "general",
    contentSource: "web",
    contentSourceUrl: url,
    fileName,
    metadata: {
      platform: "web",
      platformId: "web",
      platformUrl: image.pageUrl,
      imageLink: url,
      src: url,
      alt: image.alt
    }
  })
  if (!result.success) throw new Error(result.message || "Upload failed.")
}

function pump(session: BulkSession) {
  if (!session.active || sessions.get(session.tabId) !== session) return
  let running = inFlight.get(session)
  if (!running) {
    running = new Set()
    inFlight.set(session, running)
  }

  while (running.size < CONCURRENCY[session.destination]) {
    const item = session.pending.find((p) => !running!.has(bulkItemKey(p)))
    if (!item) return
    const key = bulkItemKey(item)
    running.add(key)

    const save = item.kind === "video" ? saveVideo : saveImage
    save(session, item)
      .then(
        () => {
          if (item.kind === "video") session.savedVideos++
          else session.saved++
        },
        (error) => {
          session.failed++
          session.lastError =
            error instanceof Error ? error.message : String(error)
        }
      )
      .finally(() => {
        running!.delete(key)
        session.pending = session.pending.filter((p) => bulkItemKey(p) !== key)
        if (sessions.get(session.tabId) !== session) return
        persist(session)
        pump(session)
      })
  }
}

async function startSession(request: any) {
  const tabId = Number(request.tabId)
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  let hostname = ""
  try {
    hostname = new URL(tab?.url ?? "").hostname
  } catch {
    // Not a web page.
  }
  if (!tab || !isPinterestHost(hostname)) {
    return { success: false, message: "Open a Pinterest page in this tab first." }
  }

  const destination: BulkDestination =
    request.destination === "mediamake" ? "mediamake" : "browser"
  if (destination === "mediamake") {
    const { apiEndpoint } = await chrome.storage.local.get("apiEndpoint")
    if (typeof apiEndpoint !== "string" || !apiEndpoint) {
      return { success: false, message: "Set the API Endpoint in Settings first." }
    }
  }

  const limit = Number(request.perPageLimit)
  const folder = sanitizeFolder(String(request.folder ?? ""))
  const session: BulkSession = {
    tabId,
    active: true,
    destination,
    folder,
    includeVideos: request.includeVideos !== false,
    videoFolder: sanitizeFolder(String(request.videoFolder || `${folder}/videos`)),
    tags: Array.isArray(request.tags) ? request.tags : [],
    perPageLimit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0,
    startedAt: Date.now(),
    pages: {},
    currentPage: null,
    currentPageRevisited: false,
    seen: [],
    pending: [],
    saved: 0,
    savedVideos: 0,
    failed: 0
  }
  await loadSessions()
  sessions.set(tabId, session)
  await persist(session)

  if (await notifyTab(tabId)) return { success: true }
  // The content script isn't running in tabs opened before the extension was
  // installed or reloaded; a reload injects it, and it picks up the session.
  await chrome.tabs.reload(tabId)
  return {
    success: true,
    message: "Reloaded the tab so the extension can see its images."
  }
}

async function stopSession(tabId: number) {
  const session = await getSession(tabId)
  if (!session) return { success: true }
  session.active = false
  session.pending = []
  await persist(session)
  await notifyTab(tabId)
  return { success: true }
}

async function enterPage(tabId: number | undefined, pageKey: string) {
  const session = await getSession(tabId)
  if (!session?.active || typeof pageKey !== "string") return { collect: false }
  const visited = pageKey in session.pages
  session.currentPage = pageKey
  session.currentPageRevisited = visited
  if (!visited) session.pages[pageKey] = { images: 0, videos: 0 }
  await persist(session)
  return { collect: !visited, videos: session.includeVideos }
}

async function addItems(tabId: number | undefined, request: any) {
  const session = await getSession(tabId)
  const { pageKey } = request
  if (
    !session?.active ||
    session.currentPage !== pageKey ||
    session.currentPageRevisited
  ) {
    return { done: true }
  }

  const seen = seenSet(session)
  const limit = session.perPageLimit
  const counts = (session.pages[pageKey] ??= { images: 0, videos: 0 })
  const full = (kind: BulkItemKind) =>
    limit > 0 && (kind === "video" ? counts.videos : counts.images) >= limit
  let accepted = 0
  const items: { kind?: unknown; id?: unknown; alt?: unknown }[] =
    Array.isArray(request.items) ? request.items : []

  for (const raw of items) {
    const kind: BulkItemKind = raw.kind === "video" ? "video" : "image"
    if (kind === "video" && !session.includeVideos) continue
    if (typeof raw.id !== "string" || full(kind)) continue
    const key = bulkItemKey({ kind, id: raw.id })
    if (seen.has(key)) continue
    seen.add(key)
    session.seen.push(key)
    session.pending.push({
      kind,
      id: raw.id,
      pageKey,
      pageUrl: typeof request.pageUrl === "string" ? request.pageUrl : "",
      alt: typeof raw.alt === "string" ? raw.alt : ""
    })
    if (kind === "video") counts.videos++
    else counts.images++
    accepted++
  }

  if (accepted > 0) {
    await persist(session)
    pump(session)
  }
  return {
    accepted,
    done: full("image") && (!session.includeVideos || full("video"))
  }
}

export function initPinterestBulkBackground() {
  loadSessions().then(() => sessions.forEach(pump))

  chrome.tabs.onRemoved.addListener((tabId) => {
    sessions.delete(tabId)
    chrome.storage.session.remove(bulkSessionKey(tabId))
  })

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    let response: Promise<unknown>
    switch (request?.action) {
      case "pinterestBulkStart":
        response = startSession(request)
        break
      case "pinterestBulkStop":
        response = stopSession(Number(request.tabId))
        break
      case "pinterestBulkStatus":
        response = getSession(sender.tab?.id).then((s) => ({
          active: Boolean(s?.active)
        }))
        break
      case "pinterestBulkEnterPage":
        response = enterPage(sender.tab?.id, request.pageKey)
        break
      case "pinterestBulkAddItems":
        response = addItems(sender.tab?.id, request)
        break
      default:
        return
    }
    response.then(sendResponse, (error) =>
      sendResponse({
        success: false,
        message: error instanceof Error ? error.message : String(error)
      })
    )
    return true
  })
}
