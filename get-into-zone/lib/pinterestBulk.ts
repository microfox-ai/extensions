// Pinterest bulk download: types and helpers shared by the popup, the content
// script and the background worker. A session belongs to one tab and lives in
// chrome.storage.session, so it ends when the tab closes or the browser quits.

export type BulkDestination = "browser" | "mediamake"
export type BulkItemKind = "image" | "video"

export interface BulkItem {
  kind: BulkItemKind
  // An image's file ("ab/cd/ef/<hash>.jpg"); a video's file hash
  // ("ab/cd/ef/<hash>"), or "pin/<pin id>" when its card shows only a cover
  // (as logged-in grids do) and the file is looked up when it's saved.
  id: string
  // A video's cover image hash: often its file's own, so the fallback when
  // that lookup fails.
  cover?: string
  pageKey: string
  pageUrl: string
  alt: string
}

export interface BulkPageCount {
  images: number
  videos: number
  // The address and time of the first visit, for _session.json.
  url?: string
  at?: number
}

// Where a pin was saved in the browser's Downloads: the path asked for
// (Chrome may add " (1)"), its download and the file's URL.
export interface SavedPin {
  file: string
  downloadId?: number
  url: string
}

// A pin saved this session, for _session.json; id is its pinRef.
export interface BulkSave extends SavedPin {
  id: string
  pageUrl: string
  at: number
}

// A pin MediaMake's media library already has, so it wasn't downloaded.
export interface BulkSkip {
  id: string
  pageUrl: string
  at: number
}

export interface BulkSession {
  tabId: number
  active: boolean
  destination: BulkDestination
  // Subfolders of the browser's Downloads folder.
  folder: string
  includeVideos: boolean
  videoFolder: string
  // Mediamake tags.
  tags: string[]
  // Max images, and separately max videos, taken from one page; 0 means no limit.
  perPageLimit: number
  startedAt: number
  // Every page visited this session -> what was taken from it. A page in here
  // is never collected again, even when the user navigates back to it.
  pages: Record<string, BulkPageCount>
  currentPage: string | null
  currentPageRevisited: boolean
  // Keys (see bulkItemKey) of everything taken this session, across all pages.
  seen: string[]
  pending: BulkItem[]
  saved: number
  savedVideos: number
  failed: number
  lastError?: string
  // Set by the MCP server when MediaMake's media library is set up: write
  // <folder>/_session.json when the session stops (pages, saves, skipped),
  // and skip the `skipping` pins the library has (their refs are stored apart,
  // under bulkSkipKey, as there can be thousands).
  manifest?: boolean
  saves?: BulkSave[]
  skipped?: BulkSkip[]
  skipping?: number
}

export interface BulkPrefs {
  destination: BulkDestination
  folder: string
  includeVideos: boolean
  videoFolder: string
  tags: string
  perPageLimit: number
}

export const bulkItemKey = (item: { kind: BulkItemKind; id: string }) =>
  `${item.kind}:${item.id}`

export const BULK_SESSION_PREFIX = "pinterestBulk:"
export const BULK_PREFS_KEY = "pinterestBulkPrefs"

export const bulkSessionKey = (tabId: number) => `${BULK_SESSION_PREFIX}${tabId}`
export const bulkSkipKey = (tabId: number) => `pinterestBulkSkip:${tabId}`

// A pin's ref in MediaMake's media library: the hash its files are named
// after ("ab/cd/ef/<hash>.jpg" for an image, "ab/cd/ef/<hash>" for a video).
export const pinRef = (id: string) => id.split("/").pop()!.replace(/\.\w+$/, "")

// The search a Pinterest page shows (its q parameter), if any.
export function pinterestQuery(href: string) {
  try {
    return new URL(href).searchParams.get("q")?.trim() || undefined
  } catch {
    return undefined
  }
}

// A session folder's name: <date>-<search>, or <date>-<path> off search pages
// (a board's "user-board"), with -2, -3, ... when that name is taken.
export function sessionFolderName(href: string, date: string, taken: string[] = []) {
  let topic = ""
  try {
    const url = new URL(href)
    topic = url.searchParams.get("q") || url.pathname
  } catch {
    // Not a page address; the fallback name is used.
  }
  const slug =
    topic
      .toLowerCase()
      .normalize("NFKC")
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .slice(0, 60)
      .replace(/^-+|-+$/g, "") || "home"
  const used = new Set(taken)
  let name = `${date}-${slug}`
  for (let n = 2; used.has(name); n++) name = `${date}-${slug}-${n}`
  return name
}

// Pin images are served as i.pinimg.com/<size>/<id>, where size is "236x",
// "736x", "originals", ... Avatars ("75x75_RS") and video thumbnails don't
// match, so they're skipped.
const PIN_IMAGE_RE =
  /^https?:\/\/i\.pinimg\.com\/(?:\d+x|originals)\/([^?#]+\.(?:jpe?g|png|gif|webp))(?:[?#]|$)/i

export const pinImageId = (url: string): string | null =>
  PIN_IMAGE_RE.exec(url.trim())?.[1] ?? null

export function pinImageIdFromElement(img: HTMLImageElement): string | null {
  const candidates = [
    img.currentSrc,
    img.src,
    ...(img.srcset || "").split(",").map((entry) => entry.trim().split(/\s+/)[0])
  ]
  for (const candidate of candidates) {
    const id = candidate ? pinImageId(candidate) : null
    if (id) return id
  }
  return null
}

// Best quality first. "originals" 404s when the original has a different
// extension than the resized copies, so 736x is the fallback.
export const pinImageUrls = (id: string) => [
  `https://i.pinimg.com/originals/${id}`,
  `https://i.pinimg.com/736x/${id}`
]

// Video pins play through MSE, so <video src> is a blob: URL. The poster
// (i.pinimg.com/videos/thumbnails/originals/<ab>/<cd>/<ef>/<hash>.0000000.jpg)
// carries the hash of the video files on v1.pinimg.com, which is the video id.
const PIN_VIDEO_POSTER_RE =
  /^https?:\/\/i\.pinimg\.com\/videos\/thumbnails\/[^/]+\/([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32})/i

export const pinVideoId = (url: string): string | null =>
  PIN_VIDEO_POSTER_RE.exec(url.trim())?.[1]?.toLowerCase() ?? null

export function pinVideoIdFromElement(
  el: HTMLVideoElement | HTMLImageElement
): string | null {
  const url =
    el instanceof HTMLVideoElement
      ? el.getAttribute("poster") || ""
      : el.currentSrc || el.src
  return url ? pinVideoId(url) : null
}

// The "ab/cd/ef/<hash>" in a pinimg.com URL, which names a pin's files.
const PIN_HASH_RE =
  /(?:^|\/)([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32})(?=[._/?#]|$)/i

export const pinHashIn = (url: string) => PIN_HASH_RE.exec(url)?.[1]?.toLowerCase() ?? ""

// The pin id of a video known only by it (see BulkItem).
export const videoPinId = (id: string) => /^pin\/(\d{5,20})$/.exec(id)?.[1]

// Where a video's files live, best first. Most videos have a progressive MP4
// at one of these paths even when Pinterest's API only lists the HLS stream;
// the rest are HLS only.
export function pinVideoSources(id: string) {
  const base = "https://v1.pinimg.com/videos"
  return {
    mp4: [
      `${base}/iht/expMp4/${id}_720w.mp4`,
      `${base}/iht/720p/${id}.mp4`,
      `${base}/mc/720p/${id}.mp4`
    ],
    hls: [
      `${base}/iht/hls/${id}.m3u8`,
      `${base}/mc/hls/${id}.m3u8`,
      `${base}/iht/hls/v2/${id}.m3u8`
    ]
  }
}

// ---------------------------------------------------------------------------
// Video pins on the page, for the Download button (contents/pinterest.ts) and
// the bulk collector (content.ts).

// Logged-in pins usually have no poster: a cover image, a duration badge and a
// /pin/<id> link. The hash only appears in a /videos/ URL, which logged-out pins have.
export const PIN_CARD_SELECTOR = [
  "[data-test-id='pinWrapper']",
  "[data-test-id='pin']",
  "[data-test-id='pin-visual-wrapper']",
  "[data-test-id='pinrep-video']",
  "[data-test-id='gated-pin-rep']",
  "[data-test-id='closeup-media-container']",
  "[data-grid-item]"
].join(", ")
export const PIN_CLOSEUP = "[data-test-id='closeup-media-container']"
// closeup-video-with-visibility stays after the video ends and Pinterest swaps it for its cover.
const VIDEO_MARKER =
  "[data-test-id='pinrep-video'], [data-test-id='gated-pin-video'], [data-test-id='pin-closeup-video'], [data-test-id='closeup-video-with-visibility']"
const DURATION_RE = /^\d{1,2}:\d{2}(?::\d{2})?$/

export interface PinCardVideo {
  // Set only when a /videos/ URL in the card carries the file hash.
  videoId: string
  pinId: string
  // Cover-image hash. Often the same file, but not always, so it's a fallback.
  signature: string
}

function urlsIn(card: Element) {
  const urls: string[] = []
  const nodes: Element[] = [card, ...card.querySelectorAll("video, img, source")]
  nodes.forEach((node) => {
    if (node instanceof HTMLVideoElement) {
      urls.push(node.getAttribute("poster") || "", node.currentSrc || "", node.src || "")
    } else if (node instanceof HTMLImageElement) {
      urls.push(node.currentSrc || "", node.src || "", node.srcset || "")
    } else {
      urls.push(node.getAttribute("src") || "")
    }
  })
  return urls
}

function hashFrom(urls: string[], videosOnly: boolean) {
  for (const url of urls) {
    if (videosOnly && !/pinimg\.com\/videos\//i.test(url)) continue
    const hash = pinHashIn(url)
    if (hash) return hash
  }
  return ""
}

// A video thumbnail as an <img> counts too: that's how the bulk collector
// found video pins before it read badges.
function isVideoCard(card: Element) {
  if (card instanceof HTMLVideoElement || card.matches(VIDEO_MARKER)) return true
  if (card.querySelector(`video, ${VIDEO_MARKER}, img[src*='/videos/thumbnails/']`)) return true
  return [...card.querySelectorAll("[data-test-id='PinTypeIdentifier']")].some((badge) =>
    DURATION_RE.test((badge.textContent || "").trim())
  )
}

function pinIdFrom(card: Element) {
  const attr =
    card.getAttribute("data-test-pin-id") ||
    card.querySelector("[data-test-pin-id]")?.getAttribute("data-test-pin-id") ||
    ""
  if (/^\d{5,20}$/.test(attr)) return attr
  const href = [...card.querySelectorAll("a[href*='/pin/']")]
    .map((link) => link.getAttribute("href") || "")
    .find((value) => /\/pin\/\d{5,}/.test(value))
  const fromHref = href?.match(/\/pin\/(\d{5,20})/)?.[1]
  if (fromHref) return fromHref
  if (card.matches(PIN_CLOSEUP)) {
    return location.pathname.match(/^\/pin\/(\d{5,20})/)?.[1] || ""
  }
  return ""
}

// The video a pin card shows, or null when it isn't a video pin.
export function pinVideoOf(card: Element): PinCardVideo | null {
  if (!isVideoCard(card)) return null
  const urls = urlsIn(card)
  const videoId = hashFrom(urls, true)
  const pinId = pinIdFrom(card)
  const signature = hashFrom(urls, false)
  if (!videoId && !pinId && !signature) return null
  return { videoId, pinId, signature }
}

// Every pin on the page once: its outermost card, or the open pin's closeup,
// which sits inside a grid item that has neither its pin id nor its title.
export const pinCards = () =>
  [...document.querySelectorAll(PIN_CARD_SELECTOR)].filter(
    (card) =>
      card.matches(PIN_CLOSEUP) ||
      (!card.parentElement?.closest(PIN_CARD_SELECTOR) && !card.querySelector(PIN_CLOSEUP))
  )

// A page is its path, plus the search query on search pages. Other query
// params (rs=typed, tracking ids, ...) and the hash are ignored.
export function pinterestPageKey(href: string): string {
  const url = new URL(href)
  const path = url.pathname.replace(/\/+$/, "") || "/"
  const query = url.searchParams.get("q")?.trim().toLowerCase()
  return query ? `${path}?q=${query}` : path
}

export function sanitizeFolder(input: string): string {
  const segments = input
    .split(/[\\/]+/)
    .map((segment) =>
      segment
        .replace(/[<>:"|?*\u0000-\u001f]/g, "")
        .trim()
        .replace(/^\.+|\.+$/g, "")
        .trim()
    )
    .filter((segment) => segment.length > 0)
  return segments.join("/") || "pinterest"
}

export const parseTags = (input: string) =>
  Array.from(
    new Set(
      input
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0)
    )
  )
