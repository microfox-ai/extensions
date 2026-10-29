import type { PlasmoCSConfig } from "plasmo"

import {
  downloadsFor,
  isInstagramHost,
  lookupInstagramMedia,
  mediaFileKey,
  mediaIdFor,
  parseInstagramUrl,
  type IgDownload,
  type IgLookup,
  type IgPost,
  type IgTarget
} from "../lib/instagram"
import {
  isSaverActive,
  watchSaverRules,
  type SaverRule
} from "../lib/saverRules"
import { sanitizeFileName } from "../lib/youtube"

export const config: PlasmoCSConfig = {
  matches: ["https://www.instagram.com/*"],
  run_at: "document_idle"
}

const PREFIX = "giz-ig"
const IG_GRADIENT = "linear-gradient(45deg, #f09433, #dc2743 50%, #bc1888)"
// Avatars and comment thumbnails stay below this.
const MIN_MEDIA_SIZE = 150
const RESCAN_MS = 500
const DONE_TOAST_MS = 6000
// Lookups are cached so hovering back and forth doesn't refetch; CDN links last hours.
const CACHE_MS = 10 * 60_000

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`

const STYLES = `
.${PREFIX}-bar { position: fixed; z-index: 2147483000; display: none; gap: 6px; }
.${PREFIX}-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px 0 10px;
  border: none; border-radius: 16px; background: ${IG_GRADIENT}; color: #fff; cursor: pointer;
  font: 600 13px/1 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 2px 8px rgba(0,0,0,0.35);
}
.${PREFIX}-btn.secondary { background: rgba(0,0,0,0.65); padding: 0 12px; }
.${PREFIX}-btn:hover { filter: brightness(1.1); }
.${PREFIX}-btn:disabled { opacity: 0.75; cursor: default; filter: none; }
.${PREFIX}-toasts {
  position: fixed; top: 16px; right: 16px; z-index: 2147483001; display: flex; flex-direction: column;
  gap: 8px; width: 320px; font: 400 13px/1.35 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.${PREFIX}-toast { padding: 12px 14px; border-radius: 14px; background: #111; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
.${PREFIX}-toast-row { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-toast-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.${PREFIX}-toast button { border: none; background: none; color: #aaa; cursor: pointer; font: 600 12px inherit; padding: 2px 4px; }
.${PREFIX}-toast button:hover { color: #fff; }
.${PREFIX}-toast-status { margin-top: 4px; font-size: 12px; color: #ccc; }
.${PREFIX}-toast-status.error { color: #ff8a80; }
.${PREFIX}-toast-status.done { color: #81c995; }
`

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string
) => {
  const node = document.createElement(tag)
  if (className)
    node.className = className
      .split(" ")
      .map((c) => `${PREFIX}-${c}`)
      .join(" ")
  if (html !== undefined) node.innerHTML = html
  return node
}

// ---------------------------------------------------------------------------
// Saver toggle: the buttons follow the "Download buttons" switch in the Saver tab.

let saverRules: SaverRule[] = []
let saverWindowId: number | undefined

const enabled = () =>
  isSaverActive(saverRules, "youtube", {
    url: location.href,
    windowId: saverWindowId
  })

// ---------------------------------------------------------------------------
// Finding post media

interface IgMedia {
  el: HTMLImageElement | HTMLVideoElement
  target: IgTarget
  // Carousel slides sit in a <ul> with one <li> per slide.
  carousel: boolean
}

let media: IgMedia[] = []

const targetFromHref = (href: string | null) => {
  if (!href) return null
  const target = parseInstagramUrl(new URL(href, location.origin).href)
  return target?.kind === "post" ? target : null
}

function targetFor(node: Element): IgTarget | null {
  // Grid thumbnails (profile, explore, "more posts") are links to their post.
  const own = targetFromHref(
    node.closest("a[href]")?.getAttribute("href") ?? null
  )
  if (own) return own
  // Feed posts link to themselves from the timestamp and the comments link.
  const article = node.closest("article")
  if (article) {
    const stamp = article.querySelector("a[href] time")?.closest("a")
    const linked =
      targetFromHref(stamp?.getAttribute("href") ?? null) ||
      [...article.querySelectorAll("a[href]")]
        .map((link) => targetFromHref(link.getAttribute("href")))
        .find(Boolean)
    if (linked) return linked
  }
  // A post page, the post dialog, a reel in /reels/ or a story: the URL names it.
  if (node.closest("main, [role='dialog'], section"))
    return parseInstagramUrl(location.href)
  return null
}

const sizeOf = (node: Element) => {
  const rect = node.getBoundingClientRect()
  return rect.width >= MIN_MEDIA_SIZE && rect.height >= MIN_MEDIA_SIZE
    ? rect
    : null
}

function isCarouselSlide(node: Element) {
  const list = node.closest("li")?.parentElement
  return list?.tagName === "UL" && list.children.length > 1
}

// Rebuilt on a timer: querying on every mouse move would be too slow on long feeds.
function rescan() {
  const found: IgMedia[] = []
  document
    .querySelectorAll<HTMLImageElement | HTMLVideoElement>("img, video")
    .forEach((node) => {
      if (!sizeOf(node)) return
      const target = targetFor(node)
      if (target)
        found.push({ el: node, target, carousel: isCarouselSlide(node) })
    })
  // The story viewer also shows previews of other people's stories; only the
  // largest one is the open story.
  if (parseInstagramUrl(location.href)?.kind === "story") {
    const area = (item: IgMedia) => {
      const rect = item.el.getBoundingClientRect()
      return rect.width * rect.height
    }
    found.sort((a, b) => area(b) - area(a))
    found.splice(1)
  }
  media = found
}

const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

// Instagram lays transparent layers over every photo, so hit-test by position.
function mediaAt(x: number, y: number) {
  let best: IgMedia | null = null
  let bestArea = Infinity
  for (const item of media) {
    if (!item.el.isConnected) continue
    const rect = sizeOf(item.el)
    if (!rect || !inside(rect, x, y)) continue
    const area = rect.width * rect.height
    if (area < bestArea) {
      best = item
      bestArea = area
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Looking up a post and choosing the files

const lookups = new Map<string, { at: number; result: Promise<IgLookup> }>()

async function lookup(target: IgTarget): Promise<IgPost> {
  const mediaId = mediaIdFor(target)
  if (!mediaId) throw new Error("Couldn't read this post's id.")
  const cached = lookups.get(mediaId)
  const entry =
    cached && Date.now() - cached.at < CACHE_MS
      ? cached
      : { at: Date.now(), result: lookupInstagramMedia(mediaId) }
  lookups.set(mediaId, entry)
  const result = await entry.result
  if (!result.post) {
    lookups.delete(mediaId)
    throw new Error(result.error)
  }
  return result.post
}

// The file names of whatever the page is showing for this slide.
function shownKeys(node: IgMedia["el"]) {
  const urls =
    node instanceof HTMLImageElement
      ? [node.currentSrc, node.src]
      : [
          node.poster,
          ...[...(node.closest("li")?.querySelectorAll("img") ?? [])].map(
            (img) => img.src
          )
        ]
  return urls.map(mediaFileKey).filter(Boolean)
}

function itemsFor(post: IgPost, item: IgMedia, all: boolean) {
  if (all || post.items.length === 1) return post.items
  const keys = shownKeys(item.el)
  const matched = post.items.find((candidate) =>
    candidate.keys.some((key) => keys.includes(key))
  )
  if (matched) return [matched]
  // Video slides play from a blob: URL, so a lone video in the post must be it.
  if (item.el instanceof HTMLVideoElement) {
    const videos = post.items.filter((candidate) => candidate.kind === "video")
    if (videos.length === 1) return videos
  }
  // A grid cover or a slide we can't place: take the whole post.
  return post.items
}

// When the lookup fails, an image can still be saved from the page itself.
function shownImageDownload(node: IgMedia["el"]): IgDownload | null {
  if (!(node instanceof HTMLImageElement)) return null
  const widest = node.srcset
    .split(",")
    .map((entry) => entry.trim().split(/\s+/))
    .map(([url, size]) => ({ url, width: parseInt(size || "0", 10) || 0 }))
    .filter((entry) => entry.url)
    .sort((a, b) => b.width - a.width)[0]
  const url = widest?.url || node.currentSrc || node.src
  if (!/^https:/.test(url)) return null
  const name = mediaFileKey(url).replace(/\.\w+$/, "") || "image"
  return { url, filename: `${sanitizeFileName(`instagram - ${name}`)}.jpg` }
}

// ---------------------------------------------------------------------------
// The Download buttons

const bar = el("div", "bar")
const button = el("button", "btn", `${DOWNLOAD_ICON}<span>Download</span>`)
button.type = "button"
button.title = "Download this photo or video"
const allButton = el("button", "btn secondary", "All")
allButton.type = "button"
allButton.title = "Download every slide in this post"
bar.append(button, allButton)
const buttonLabel = () => button.querySelector("span")!
let hovered: IgMedia | null = null
let busy = false

function place() {
  const target = enabled() ? hovered : null
  const rect = target?.el.isConnected ? sizeOf(target.el) : null
  if (!target || !rect) {
    bar.style.display = "none"
    return
  }
  allButton.style.display = target.carousel ? "inline-flex" : "none"
  // Top-right: the Save overlay takes the top-left, Instagram's own controls the bottom.
  bar.style.display = "flex"
  bar.style.top = `${rect.top + 12}px`
  bar.style.left = `${rect.right - 12 - bar.offsetWidth}px`
}

function onMouseMove(event: MouseEvent) {
  if (busy || bar.contains(event.target as Node)) return
  const found = mediaAt(event.clientX, event.clientY)
  if (found?.el !== hovered?.el) {
    hovered = found
    place()
  }
}

async function save(item: IgMedia, all: boolean) {
  let files: IgDownload[]
  try {
    const post = await lookup(item.target)
    files = downloadsFor(post, itemsFor(post, item, all))
  } catch (error) {
    const fallback = all ? null : shownImageDownload(item.el)
    if (!fallback) throw error
    files = [fallback]
  }
  const response = await chrome.runtime.sendMessage({
    action: "instagramDownload",
    files
  })
  if (!response?.success)
    throw new Error(response?.message || "Couldn't save the file.")
  const ids: number[] = response.downloadIds ?? []
  return { count: files.length, downloadId: ids[ids.length - 1] }
}

async function onClick(all: boolean) {
  if (!hovered || busy) return
  const target = hovered
  busy = true
  button.disabled = allButton.disabled = true
  buttonLabel().textContent = "Saving…"
  try {
    const { count, downloadId } = await save(target, all)
    showToast(
      count === 1 ? "Saved 1 file" : `Saved ${count} files`,
      "Saved to Downloads",
      "done",
      downloadId
    )
  } catch (error) {
    showToast(
      "Instagram download failed",
      error instanceof Error ? error.message : String(error),
      "error"
    )
  } finally {
    busy = false
    button.disabled = allButton.disabled = false
    buttonLabel().textContent = "Download"
  }
}

for (const node of [button, allButton]) {
  // Stop the press before Instagram treats it as opening or liking the post.
  for (const type of ["pointerdown", "mousedown", "dblclick"] as const) {
    node.addEventListener(
      type,
      (event) => {
        event.preventDefault()
        event.stopPropagation()
      },
      true
    )
  }
  node.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    onClick(node === allButton)
  })
}

// ---------------------------------------------------------------------------
// Toasts

const toastHost = el("div", "toasts")

function showToast(
  heading: string,
  message: string,
  kind: "done" | "error",
  downloadId?: number
) {
  const toast = el("div", "toast")
  const row = el("div", "toast-row")
  const title = el("span", "toast-title")
  title.textContent = heading
  row.append(title)
  if (downloadId !== undefined) {
    const show = el("button", undefined, "Show")
    show.onclick = () =>
      chrome.runtime.sendMessage({ action: "instagramShow", downloadId })
    row.append(show)
  }
  const close = el("button", undefined, "✕")
  close.title = "Dismiss"
  close.onclick = () => toast.remove()
  row.append(close)
  const status = el("div", `toast-status ${kind}`)
  status.textContent = message
  toast.append(row, status)
  toastHost.prepend(toast)
  if (kind === "done") setTimeout(() => toast.remove(), DONE_TOAST_MS)
}

// ---------------------------------------------------------------------------

function init() {
  if (!isInstagramHost(location.hostname)) return
  const style = document.createElement("style")
  style.textContent = STYLES
  document.head.append(style)
  document.body.append(bar, toastHost)

  rescan()
  setInterval(() => {
    rescan()
    place()
  }, RESCAN_MS)
  document.addEventListener("mousemove", onMouseMove, {
    capture: true,
    passive: true
  })
  window.addEventListener("scroll", place, { capture: true, passive: true })
  window.addEventListener("resize", place, { passive: true })

  watchSaverRules((rules) => {
    saverRules = rules
    place()
  })
  chrome.runtime.sendMessage({ action: "getSaverContext" }, (response) => {
    if (chrome.runtime.lastError) return
    if (typeof response?.windowId === "number") {
      saverWindowId = response.windowId
      place()
    }
  })
  chrome.runtime.onMessage.addListener((request) => {
    if (
      request?.action === "saverWindowChanged" &&
      typeof request.windowId === "number"
    ) {
      saverWindowId = request.windowId
      place()
    }
  })
}

init()
