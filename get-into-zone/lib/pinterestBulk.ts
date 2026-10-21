// Pinterest bulk download: types and helpers shared by the popup, the content
// script and the background worker. A session belongs to one tab and lives in
// chrome.storage.session, so it ends when the tab closes or the browser quits.

export type BulkDestination = "browser" | "mediamake"

export interface BulkImage {
  id: string
  pageKey: string
  pageUrl: string
  alt: string
}

export interface BulkSession {
  tabId: number
  active: boolean
  destination: BulkDestination
  // Subfolder of the browser's Downloads folder.
  folder: string
  // Mediamake tags.
  tags: string[]
  // Max images taken from one page; 0 means no limit.
  perPageLimit: number
  startedAt: number
  // Every page visited this session -> images taken from it. A page in here is
  // never collected again, even when the user navigates back to it.
  pages: Record<string, number>
  currentPage: string | null
  currentPageRevisited: boolean
  // Image ids already taken this session, across all pages.
  seen: string[]
  pending: BulkImage[]
  saved: number
  failed: number
  lastError?: string
}

export interface BulkPrefs {
  destination: BulkDestination
  folder: string
  tags: string
  perPageLimit: number
}

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
