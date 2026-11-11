// Google Images bulk download: types and helpers shared by the popup, the
// background worker and the tests (lib/googleImages.test.mjs). No imports, so
// node can run it for the tests.
//
// A results page (google.com/search?...&udm=2, or the older tbm=isch) shows
// each result as a card (div[data-docid][data-lpage]) whose <img> is a
// thumbnail, often a base64 one. The original image's address and size are in
// Google's own data for the result: in the page's inline scripts for the first
// results, and in the answer to the request that "More results" (or scrolling)
// sends for the rest. Both hold, for each result:
//   [0,"<docid>",["<thumbnail>",<h>,<w>],["<original>",<h>,<w>], ...]
// with the quotes escaped once more in the "More results" answer
// ([0,\"<docid>\",[\"...\",...]...), where it sits inside a JSON string.

export type GiDestination = "browser" | "mediamake"

// One result to save.
export interface GiItem {
  // Google's id for the result (data-docid).
  id: string
  // The original image.
  url: string
  width: number
  height: number
  // The page the image is on (data-lpage), its title, and the search it came from.
  pageUrl: string
  title: string
  query: string
  searchUrl: string
}

export interface GiSession {
  tabId: number
  active: boolean
  destination: GiDestination
  // Subfolder of the browser's Downloads folder.
  folder: string
  // Write <file>.source.json beside each image, for MediaMake's media library.
  sidecars: boolean
  // Mediamake tags.
  tags: string[]
  // Stop once this many are saved.
  count: number
  minWidth: number
  minHeight: number
  // The search the session started on, and its address.
  query: string
  searchUrl: string
  startedAt: number
  // The results page's data as the page script keeps it: a token that changes
  // when the tab reloads, and how many of its results the session has read.
  pageToken?: string
  cursor: number
  // Result ids and image addresses taken this session.
  seen: string[]
  pending: GiItem[]
  // Results read, and what became of them.
  found: number
  saved: number
  failed: number
  tooSmall: number
  duplicates: number
  skippedInLibrary: number
  // How many image addresses MediaMake's library has (stored apart, under giSkipKey).
  skipping?: number
  lastError?: string
  lastFile?: string
  // The results page as last read: cards on it, results read (with their
  // data), cards still without it, whether Google's More results button is
  // there, and how many times the session has clicked it.
  page?: { cards: number; read: number; waiting: number; moreButton: boolean; moreClicks: number }
  // Why the session ended, once it has.
  endReason?: string
  stoppedAt?: number
}

export interface GiPrefs {
  destination: GiDestination
  count: number
  minSize: number
  tags: string
}

export const GI_TOOL = "google-images"
export const GI_SESSION_PREFIX = "googleImagesBulk:"
export const GI_SKIP_PREFIX = "googleImagesBulkSkip:"
export const GI_PREFS_KEY = "googleImagesBulkPrefs"
export const GI_DEFAULT_COUNT = 50
export const GI_MAX_COUNT = 1000

export const giSessionKey = (tabId: number) => `${GI_SESSION_PREFIX}${tabId}`
export const giSkipKey = (tabId: number) => `${GI_SKIP_PREFIX}${tabId}`

// google.com, google.co.in, ... (not docs.google.com and the like).
export const isGoogleHost = (hostname: string) =>
  /^(?:www\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/i.test(hostname)

export function isGoogleImagesUrl(href: string | undefined) {
  try {
    const url = new URL(href ?? "")
    if (!isGoogleHost(url.hostname) || url.pathname !== "/search") return false
    return url.searchParams.get("udm") === "2" || url.searchParams.get("tbm") === "isch"
  } catch {
    return false
  }
}

export function googleImagesQuery(href: string | undefined) {
  try {
    return new URL(href ?? "").searchParams.get("q")?.trim() || ""
  } catch {
    return ""
  }
}

// A Google Images search; large: Google's own Size: Large filter.
export function googleImagesSearchUrl(query: string, { large = false } = {}) {
  const params = new URLSearchParams({ q: query.trim(), udm: "2" })
  if (large) params.set("tbs", "isz:l")
  return `https://www.google.com/search?${params}`
}

// --- Google's data for a result ----------------------------------------------

// Groups: 1 the escaping before each quote ("" inline, "\" in "More results"),
// 2 the result id, 3-5 the thumbnail and its height and width, 6-8 the
// original and its height and width. The page script runs it as is
// (lib/googleImagesPage.ts), and hands back the groups for decodeResult.
export const RESULT_PATTERN = String.raw`\[0,(\\*)"([\w-]{6,40})\1",\[\1"((?:(?!\1").)+?)\1",(\d+),(\d+)\],\[\1"((?:(?!\1").)+?)\1",(\d+),(\d+)\]`

// A string as it sits in the data, `prefix` being the escaping before its
// quotes: "" once JSON-escaped (=), "\" twice (\\u003d), and so on.
function unescapeData(raw: string, prefix: string) {
  const levels = Math.round(Math.log2(prefix.length + 1)) + 1
  let text = raw
  for (let i = 0; i < levels; i++) {
    try {
      text = JSON.parse(`"${text}"`)
    } catch {
      return null
    }
  }
  return text
}

export interface GiResult {
  id: string
  url: string
  width: number
  height: number
  thumbnail?: string
}

// The match's groups after the whole match (match.slice(1)), as the page script returns them.
export function decodeResult(groups: unknown): GiResult | null {
  if (!Array.isArray(groups) || groups.length < 8) return null
  const [prefix, id, thumbRaw, , , urlRaw, height, width] = groups.map(String)
  const url = unescapeData(urlRaw, prefix)
  if (!url || !/^https?:\/\//i.test(url)) return null
  const thumbnail = unescapeData(thumbRaw, prefix) ?? undefined
  return { id, url, width: Number(width) || 0, height: Number(height) || 0, ...(thumbnail ? { thumbnail } : {}) }
}

// Every result in a page's script text or a "More results" answer, first of each id.
export function parseResults(text: string): GiResult[] {
  const re = new RegExp(RESULT_PATTERN, "g")
  const results = new Map<string, GiResult>()
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) {
    if (results.has(match[2])) continue
    const result = decodeResult(match.slice(1))
    if (result) results.set(result.id, result)
  }
  return [...results.values()]
}

// The same image found again (by another result, or with a different #hash).
export function imageKey(url: string) {
  try {
    const parsed = new URL(url)
    parsed.hash = ""
    return parsed.href
  } catch {
    return url
  }
}

// --- Files ------------------------------------------------------------------

const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/pjpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico"
}

const IMAGE_EXTENSION_RE = /\.(jpe?g|png|webp|gif|avif|heic|heif|bmp|tiff?|svg|ico)$/i

export const extensionForMime = (mime: string | undefined) =>
  MIME_EXTENSIONS[(mime ?? "").split(";")[0].trim().toLowerCase()]

// `filename` with the extension `mime` calls for, when it names an image type.
export function withMimeExtension(filename: string, mime: string | undefined) {
  const ext = extensionForMime(mime)
  if (!ext) return filename
  const slash = filename.lastIndexOf("/")
  const dir = filename.slice(0, slash + 1)
  const name = filename.slice(slash + 1)
  const base = IMAGE_EXTENSION_RE.test(name) ? name.replace(IMAGE_EXTENSION_RE, "") : name
  return `${dir}${base}.${ext}`
}

// A saved download is an image: an image type, or a generic binary type with
// an image's extension (some file hosts send application/octet-stream).
export function isImageDownload(mime: string | undefined, url: string) {
  const type = (mime ?? "").split(";")[0].trim().toLowerCase()
  if (type.startsWith("image/")) return true
  if (type && type !== "application/octet-stream" && type !== "binary/octet-stream") return false
  try {
    return IMAGE_EXTENSION_RE.test(new URL(url).pathname)
  } catch {
    return false
  }
}

const slug = (text: string, max: number) =>
  text
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "")

// Names that say nothing about the picture (YouTube's thumbnails are maxresdefault.jpg, hqdefault.jpg...).
const GENERIC_NAME_RE =
  /^(?:image|images|img|photo|picture|pic|download|file|crawler|index|default|original|full|large|media|thumb|thumbnail|(?:maxres|hq|mq|sd)default|hq720|\d{1,6}|[0-9a-f]{24,}|[\w-]{0,2})$/i

// A file name for an image: the name in its address when it says something,
// else the result's title, else Google's id; with the address's image
// extension, or .jpg until the download's type says otherwise (the
// background asks for the type's extension).
export function imageFileName(url: string, title: string, id: string) {
  let last = ""
  try {
    // An image CDN can carry the source's address in its path (…/fetch/https%3A%2F%2F…/name.jpg).
    last = decodeURIComponent(new URL(url).pathname.split("/").pop() || "").split("/").pop() || ""
  } catch {
    last = ""
  }
  const found = IMAGE_EXTENSION_RE.exec(last)?.[1]?.toLowerCase()
  const ext = found === "jpeg" ? "jpg" : found === "tif" ? "tiff" : found
  const fromUrl = slug(last.replace(IMAGE_EXTENSION_RE, ""), 80)
  const base =
    (fromUrl && !GENERIC_NAME_RE.test(fromUrl) ? fromUrl : "") || slug(title, 80) || slug(id, 40) || "image"
  return `${base}.${ext || "jpg"}`
}

// --- Sessions in chrome.storage.session -------------------------------------

// What a session keeps once it has ended: its settings and counts, not the
// results it went through (chrome.storage.session holds 10 MB for the whole
// extension; see the Pinterest sessions' retireSession).
export function retireGiSession(session: GiSession, now = Date.now()) {
  session.active = false
  session.seen = []
  session.pending = []
  delete session.skipping
  session.stoppedAt ??= now
  return session
}

// What the popup and google_images_bulk_status show.
export function giSummary(session: GiSession) {
  const { seen, pending, pageToken, cursor, ...rest } = session
  return { ...rest, queued: pending.length }
}
