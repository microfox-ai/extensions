// Pinterest bulk download: types and helpers shared by the popup, the content
// script and the background worker. A session belongs to one tab and lives in
// chrome.storage.session, so it ends when the tab closes or the browser quits.

export type BulkDestination = "browser" | "mediamake"
export type BulkItemKind = "image" | "video"

export interface BulkItem {
  kind: BulkItemKind
  id: string
  pageKey: string
  pageUrl: string
  alt: string
}

export interface BulkPageCount {
  images: number
  videos: number
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
