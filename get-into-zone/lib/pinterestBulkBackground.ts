import { downloadFile } from "./downloads"
import {
  PINTEREST_SESSION_SCHEMA,
  jsonByLine,
  saveJsonFile
} from "./libraryFiles"
import { queueSparkboardIndex } from "./mediamake"
import {
  BULK_SESSION_PREFIX,
  bulkItemKey,
  bulkSessionKey,
  bulkSkipKey,
  pinHashIn,
  pinImageUrls,
  pinRef,
  pinterestQuery,
  sanitizeFolder,
  videoPinId,
  type BulkDestination,
  type BulkItem,
  type BulkItemKind,
  type BulkSave,
  type BulkSession,
  type SavedPin
} from "./pinterestBulk"
import { saveVideo, type PinVideoFile } from "./pinterestVideoBackground"
import { findPinVideo } from "./pinterestVideoDownload"
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
// Saves still running, so a stop can wait for them before writing _session.json.
const saving = new WeakMap<BulkSession, Set<Promise<unknown>>>()
// The refs of the pins the media library has, and which of them are videos
// when the MCP server says so (older ones send one list).
interface SkipList {
  pins: Set<string>
  videos?: Set<string>
}
// Per tab (see skipSet).
const skipSets = new Map<number, Promise<SkipList>>()
let loading: Promise<void> | null = null

// How long a stop waits for saves still running before writing _session.json.
const STOP_WAIT_MS = 60_000
const RESTART_WAIT_MS = 10_000

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

type StoredSkipList = { pins: string[]; videos?: string[] }

const skipList = (stored?: StoredSkipList): SkipList => ({
  pins: new Set(stored?.pins ?? []),
  ...(stored?.videos ? { videos: new Set(stored.videos) } : {})
})

// The refs are stored apart from the session, which is saved after every
// change and would otherwise carry thousands of them each time.
const skipSet = (session: BulkSession) => {
  if (!session.skipping) return undefined
  let set = skipSets.get(session.tabId)
  if (!set) {
    const key = bulkSkipKey(session.tabId)
    set = chrome.storage.session.get(key).then((stored) => skipList(stored[key]))
    skipSets.set(session.tabId, set)
  }
  return set
}

// A video pin's cover image can carry its video's hash, so a video counts as
// had only when the library has it as a video, if the MCP server says which.
const libraryHas = (skip: SkipList | undefined, kind: BulkItemKind, id: string) =>
  Boolean(skip && (kind === "video" ? skip.videos ?? skip.pins : skip.pins).has(pinRef(id)))

const savesRunning = (session: BulkSession) => {
  let set = saving.get(session)
  if (!set) {
    set = new Set()
    saving.set(session, set)
  }
  return set
}

async function storeSkipList(tabId: number, pins: string[], videos?: string[]) {
  if (pins.length) {
    const stored: StoredSkipList = { pins, ...(videos ? { videos } : {}) }
    skipSets.set(tabId, Promise.resolve(skipList(stored)))
    await chrome.storage.session.set({ [bulkSkipKey(tabId)]: stored })
  } else {
    skipSets.delete(tabId)
    await chrome.storage.session.remove(bulkSkipKey(tabId))
  }
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

// Resolves with where the image went in Downloads (nothing for Mediamake).
async function saveImage(
  session: BulkSession,
  image: BulkItem
): Promise<SavedPin | undefined> {
  const url = await resolveImageUrl(image.id)
  const fileName = image.id.split("/").pop()!

  if (session.destination === "browser") {
    const file = `${session.folder}/${fileName}`
    const downloadId = await downloadFile({
      url,
      filename: file,
      conflictAction: "uniquify",
      saveAs: false
    })
    return { file, downloadId, url }
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

// A video known only by its pin id (see BulkItem) is looked up in its tab when
// its turn comes and saved under its file's hash, unless this session or the
// media library has that video already. Resolves with what to save, if anything.
async function lookUp(
  session: BulkSession,
  item: BulkItem
): Promise<{ pin: BulkItem; file?: PinVideoFile } | undefined> {
  const pinId = videoPinId(item.id)
  if (!pinId) return { pin: item }
  const file = await findPinVideo({ pinId, signature: item.cover }, session.tabId)
  const pin = { ...item, alt: item.alt || file.title || "" }
  const id = pinHashIn(file.url)
  if (!id) return { pin, file }

  const key = bulkItemKey({ kind: "video", id })
  const seen = seenSet(session)
  if (seen.has(key)) return undefined
  seen.add(key)
  session.seen.push(key)
  if (libraryHas(await skipSet(session), "video", id)) {
    ;(session.skipped ??= []).push({ id: pinRef(id), pageUrl: item.pageUrl, at: Date.now() })
    // Nor is it counted in the page's limit.
    const counts = session.pages[item.pageKey]
    if (counts) counts.videos--
    return undefined
  }
  return { pin: { ...pin, id }, file }
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

    const tracked = savesRunning(session)
    const work: Promise<void> = lookUp(session, item)
      .then(async (found) => {
        if (!found) return
        const { pin, file } = found
        const saved =
          pin.kind === "video"
            ? await saveVideo(session, pin, file)
            : await saveImage(session, pin)
        if (pin.kind === "video") session.savedVideos++
        else session.saved++
        if (saved && session.manifest) {
          ;(session.saves ??= []).push({
            ...saved,
            id: pinRef(pin.id),
            pageUrl: pin.pageUrl,
            at: Date.now()
          })
        }
      })
      .catch((error) => {
        session.failed++
        session.lastError = error instanceof Error ? error.message : String(error)
      })
      .finally(() => {
        running!.delete(key)
        tracked.delete(work)
        session.pending = session.pending.filter((p) => bulkItemKey(p) !== key)
        if (sessions.get(session.tabId) !== session) return
        persist(session)
        pump(session)
      })
    tracked.add(work)
  }
}

// `path` (relative to Downloads) as seen from `folder`, e.g. "videos/x.mp4".
function relativeTo(folder: string, path: string) {
  const from = folder.split("/").filter(Boolean)
  const to = path.split("/").filter(Boolean)
  let common = 0
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) {
    common++
  }
  return [...from.slice(common).map(() => ".."), ...to.slice(common)].join("/")
}

// The saved file, relative to the session folder: under the name Chrome gave
// it, which may not be the one asked for. Nothing if the download failed.
async function savedFile(save: BulkSave, folder: string) {
  const [item] =
    save.downloadId === undefined
      ? []
      : await chrome.downloads.search({ id: save.downloadId }).catch(() => [])
  if (item?.state === "interrupted") return undefined
  const dir = save.file.slice(0, save.file.lastIndexOf("/"))
  const name = item?.filename?.split(/[\\/]/).pop() || save.file.split("/").pop()!
  return relativeTo(folder, `${dir}/${name}`)
}

// Writes <folder>/_session.json for MediaMake's media library: every page the
// session visited, with its search, and every pin saved or skipped (the
// library has it), with the page and search it came from. A file of that name
// already in the folder (from an earlier session) is kept: Chrome adds " (1)".
async function writeManifest(session: BulkSession, waitMs: number) {
  const running = [...(saving.get(session) ?? [])]
  if (running.length) {
    await Promise.race([
      Promise.allSettled(running),
      new Promise((resolve) => setTimeout(resolve, waitMs))
    ])
  }
  const iso = (at?: number) => new Date(at ?? Date.now()).toISOString()
  const pages = Object.values(session.pages)
    .filter((page) => page.url)
    .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
    .map((page) => ({ url: page.url, query: pinterestQuery(page.url!), at: iso(page.at) }))
  const pins = []
  for (const save of session.saves ?? []) {
    const file = await savedFile(save, session.folder)
    if (!file) continue
    pins.push({
      id: save.id,
      file,
      url: save.url,
      pageUrl: save.pageUrl,
      query: pinterestQuery(save.pageUrl),
      at: iso(save.at)
    })
  }
  const skipped = (session.skipped ?? []).map((pin) => ({
    id: pin.id,
    pageUrl: pin.pageUrl,
    query: pinterestQuery(pin.pageUrl),
    at: iso(pin.at)
  }))
  try {
    const text = jsonByLine({ schema: PINTEREST_SESSION_SCHEMA, pages, pins, skipped })
    return { manifest: await saveJsonFile(`${session.folder}/_session.json`, text, "uniquify") }
  } catch (error) {
    return { manifestError: error instanceof Error ? error.message : String(error) }
  }
}

export async function startBulkSession(request: any) {
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
  // From the MCP server, when MediaMake's media library is set up: the refs of
  // the pins it has, and (from newer servers) which of them are videos.
  const refs = (list: unknown): string[] | undefined =>
    Array.isArray(list) ? list.filter((ref): ref is string => typeof ref === "string") : undefined
  const skipPins = refs(request.skipPins) ?? []
  const skipVideos = refs(request.skipVideos)
  if (request.manifest === true) Object.assign(session, { manifest: true, saves: [] })
  if (skipPins.length) Object.assign(session, { skipping: skipPins.length, skipped: [] })

  await loadSessions()
  // A session still running in this tab is stopped by this one.
  const previous = sessions.get(tabId)
  if (previous?.active && previous.manifest) {
    previous.active = false
    await writeManifest(previous, RESTART_WAIT_MS)
  }
  await storeSkipList(tabId, skipPins, skipVideos)
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

export async function stopBulkSession(tabId: number): Promise<{
  success: boolean
  manifest?: string
  manifestError?: string
}> {
  const session = await getSession(tabId)
  if (!session) return { success: true }
  const wasActive = session.active
  session.active = false
  session.pending = []
  await persist(session)
  await notifyTab(tabId)
  if (!wasActive || !session.manifest) return { success: true }
  return { success: true, ...(await writeManifest(session, STOP_WAIT_MS)) }
}

export async function listBulkSessions() {
  await loadSessions()
  return [...sessions.values()]
}

async function enterPage(
  tabId: number | undefined,
  pageKey: string,
  pageUrl?: string
) {
  const session = await getSession(tabId)
  if (!session?.active || typeof pageKey !== "string") return { collect: false }
  const visited = pageKey in session.pages
  session.currentPage = pageKey
  session.currentPageRevisited = visited
  if (!visited) {
    session.pages[pageKey] = {
      images: 0,
      videos: 0,
      ...(pageUrl ? { url: pageUrl, at: Date.now() } : {})
    }
  }
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
  const skip = await skipSet(session)
  const limit = session.perPageLimit
  const counts = (session.pages[pageKey] ??= { images: 0, videos: 0 })
  const full = (kind: BulkItemKind) =>
    limit > 0 && (kind === "video" ? counts.videos : counts.images) >= limit
  const pageUrl = typeof request.pageUrl === "string" ? request.pageUrl : ""
  let accepted = 0
  let skipped = 0
  const items: { kind?: unknown; id?: unknown; alt?: unknown; cover?: unknown }[] =
    Array.isArray(request.items) ? request.items : []

  for (const raw of items) {
    const kind: BulkItemKind = raw.kind === "video" ? "video" : "image"
    if (kind === "video" && !session.includeVideos) continue
    if (typeof raw.id !== "string") continue
    const key = bulkItemKey({ kind, id: raw.id })
    if (seen.has(key)) continue
    // Pins the media library has aren't downloaded, nor counted in the page's limit.
    if (libraryHas(skip, kind, raw.id)) {
      seen.add(key)
      session.seen.push(key)
      ;(session.skipped ??= []).push({ id: pinRef(raw.id), pageUrl, at: Date.now() })
      skipped++
      continue
    }
    if (full(kind)) continue
    seen.add(key)
    session.seen.push(key)
    const cover = kind === "video" && typeof raw.cover === "string" ? pinHashIn(raw.cover) : ""
    session.pending.push({
      kind,
      id: raw.id,
      ...(cover ? { cover } : {}),
      pageKey,
      pageUrl,
      alt: typeof raw.alt === "string" ? raw.alt : ""
    })
    if (kind === "video") counts.videos++
    else counts.images++
    accepted++
  }

  if (accepted > 0 || skipped > 0) {
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
    const forget = () => {
      sessions.delete(tabId)
      skipSets.delete(tabId)
      chrome.storage.session.remove([bulkSessionKey(tabId), bulkSkipKey(tabId)])
    }
    // Closing the tab stops its session, so _session.json is written first.
    getSession(tabId).then((session) => {
      if (!session?.active || !session.manifest) return forget()
      session.active = false
      writeManifest(session, STOP_WAIT_MS).finally(forget)
    }, forget)
  })

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    let response: Promise<unknown>
    switch (request?.action) {
      case "pinterestBulkStart":
        response = startBulkSession(request)
        break
      case "pinterestBulkStop":
        response = stopBulkSession(Number(request.tabId))
        break
      case "pinterestBulkStatus":
        response = getSession(sender.tab?.id).then((s) => ({
          active: Boolean(s?.active)
        }))
        break
      case "pinterestBulkEnterPage":
        response = enterPage(
          sender.tab?.id,
          request.pageKey,
          typeof request.pageUrl === "string" ? request.pageUrl : sender.tab?.url
        )
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
