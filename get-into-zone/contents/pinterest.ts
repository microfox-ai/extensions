import type { PlasmoCSConfig } from "plasmo"

import type { PinVideoJob } from "../lib/pinterestVideoDownload"
import { pinVideoIdFromElement } from "../lib/pinterestBulk"
import {
  SAVER_RULES_KEY,
  isPinterestHost,
  isSaverActive,
  readSaverRules,
  type SaverRule
} from "../lib/saverRules"
import { formatBytes } from "../lib/youtube"

// Match patterns can't wildcard the TLD; these are Pinterest's main domains.
export const config: PlasmoCSConfig = {
  matches: [
    "https://*.pinterest.com/*",
    "https://*.pinterest.ca/*",
    "https://*.pinterest.co.uk/*",
    "https://*.pinterest.com.au/*",
    "https://*.pinterest.de/*",
    "https://*.pinterest.fr/*",
    "https://*.pinterest.es/*",
    "https://*.pinterest.it/*",
    "https://*.pinterest.jp/*",
    "https://*.pinterest.com.mx/*",
    "https://*.pinterest.nz/*",
    "https://*.pinterest.ie/*",
    "https://*.pinterest.at/*",
    "https://*.pinterest.ch/*",
    "https://*.pinterest.pt/*",
    "https://*.pinterest.se/*",
    "https://*.pinterest.dk/*",
    "https://*.pinterest.ph/*",
    "https://*.pinterest.cl/*"
  ],
  run_at: "document_idle"
}

const PREFIX = "giz-pin"
const PINTEREST_RED = "#e60023"
const MIN_VIDEO_SIZE = 120
// A video this wide on a /pin/ page is the pin itself; its button stays visible.
const MAIN_VIDEO_MIN_WIDTH = 250
const RESCAN_MS = 500
const DONE_TOAST_MS = 6000

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`

const STYLES = `
.${PREFIX}-btn {
  position: fixed; z-index: 2147483000; display: none; align-items: center; gap: 6px;
  height: 36px; padding: 0 14px 0 12px; border: none; border-radius: 18px;
  background: ${PINTEREST_RED}; color: #fff; cursor: pointer;
  font: 600 14px/1 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.${PREFIX}-btn:hover { background: #ad081b; }
.${PREFIX}-btn:disabled { opacity: 0.75; cursor: default; }
.${PREFIX}-toasts {
  position: fixed; top: 88px; right: 16px; z-index: 2147483001; display: flex; flex-direction: column;
  gap: 8px; width: 320px; font: 400 13px/1.35 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.${PREFIX}-toast { padding: 12px 14px; border-radius: 16px; background: #111; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
.${PREFIX}-toast-row { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-toast-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.${PREFIX}-toast button { border: none; background: none; color: #aaa; cursor: pointer; font: 600 12px inherit; padding: 2px 4px; }
.${PREFIX}-toast button:hover { color: #fff; }
.${PREFIX}-toast-status { margin-top: 4px; font-size: 12px; color: #ccc; }
.${PREFIX}-toast-status.error { color: #ff8a80; }
.${PREFIX}-toast-status.done { color: #81c995; }
.${PREFIX}-progress { height: 3px; margin-top: 8px; border-radius: 2px; background: #444; overflow: hidden; }
.${PREFIX}-progress div { height: 100%; background: ${PINTEREST_RED}; transition: width 0.3s; }
`

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  html?: string
) => {
  const node = document.createElement(tag)
  if (className) node.className = `${PREFIX}-${className}`
  if (html !== undefined) node.innerHTML = html
  return node
}

// ---------------------------------------------------------------------------
// Saver toggle: the button follows the "Download buttons" switch in the Saver tab.

let saverRules: SaverRule[] = []
let saverWindowId: number | undefined

const enabled = () =>
  isSaverActive(saverRules, "youtube", { url: location.href, windowId: saverWindowId })

// ---------------------------------------------------------------------------
// Finding video pins

interface PinVideo {
  el: HTMLVideoElement | HTMLImageElement
  videoId: string
}

// Rebuilt on a timer: querying on every mouse move would be too slow on long boards.
let videos: PinVideo[] = []

function rescan() {
  const found: PinVideo[] = []
  document
    .querySelectorAll<HTMLVideoElement | HTMLImageElement>("video, img[src*='/videos/thumbnails/']")
    .forEach((media) => {
      const videoId = pinVideoIdFromElement(media)
      if (videoId) found.push({ el: media, videoId })
    })
  videos = found
}

const visibleRect = (media: Element) => {
  const rect = media.getBoundingClientRect()
  return rect.width >= MIN_VIDEO_SIZE && rect.height >= MIN_VIDEO_SIZE ? rect : null
}

const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

// Pinterest's own hover layers sit above the video, so hit-test by position.
function videoAt(x: number, y: number) {
  let best: PinVideo | null = null
  let bestArea = Infinity
  for (const video of videos) {
    if (!video.el.isConnected) continue
    const rect = visibleRect(video.el)
    if (!rect || !inside(rect, x, y)) continue
    const area = rect.width * rect.height
    if (area < bestArea) {
      best = video
      bestArea = area
    }
  }
  return best
}

function mainPinVideo() {
  if (!/^\/pin\//.test(location.pathname)) return null
  let best: PinVideo | null = null
  let bestWidth = MAIN_VIDEO_MIN_WIDTH
  for (const video of videos) {
    const rect = video.el.isConnected ? visibleRect(video.el) : null
    if (rect && rect.width >= bestWidth && rect.bottom > 0 && rect.top < innerHeight) {
      best = video
      bestWidth = rect.width
    }
  }
  return best
}

function titleFor(media: Element) {
  if (/^\/pin\//.test(location.pathname)) {
    const heading = document.querySelector("h1")?.textContent?.trim()
    if (heading) return heading
  }
  const card = media.closest("[data-grid-item], [data-test-id='pinWrapper'], [role='listitem']")
  // Logged-out cards are "gated" and carry no title; the file is then named after the video hash.
  return (
    card?.querySelector("a[href*='/pin/'][aria-label]")?.getAttribute("aria-label")?.trim() ||
    card?.querySelector("[data-test-id*='title']")?.textContent?.trim() ||
    card?.querySelector("img[alt]")?.getAttribute("alt")?.trim() ||
    media.getAttribute("aria-label")?.trim() ||
    ""
  )
}

// ---------------------------------------------------------------------------
// The Download button

const button = el("button", "btn", `${DOWNLOAD_ICON}<span>Download</span>`)
button.title = "Download this video"
const buttonLabel = () => button.querySelector("span")!
let hovered: PinVideo | null = null
let shown: PinVideo | null = null

function place() {
  const target = enabled() ? hovered ?? mainPinVideo() : null
  const rect = target?.el.isConnected ? visibleRect(target.el) : null
  if (!target || !rect) {
    shown = null
    button.style.display = "none"
    return
  }
  if (target.videoId !== shown?.videoId && !button.disabled) buttonLabel().textContent = "Download"
  shown = target
  // Bottom-left: our Save / AI panel takes the top-left, Pinterest's own Save the top-right.
  button.style.left = `${rect.left + 12}px`
  button.style.top = `${rect.bottom - 12 - 36}px`
  button.style.display = "inline-flex"
}

function onMouseMove(event: MouseEvent) {
  if (event.target === button || button.contains(event.target as Node)) return
  const found = videoAt(event.clientX, event.clientY)
  if (found?.el !== hovered?.el) {
    hovered = found
    place()
  }
}

button.addEventListener("click", async (event) => {
  event.preventDefault()
  event.stopPropagation()
  if (!shown || button.disabled) return
  const target = shown
  button.disabled = true
  buttonLabel().textContent = "Starting…"
  try {
    const response = await chrome.runtime.sendMessage({
      action: "pinterestVideoDownload",
      videoId: target.videoId,
      title: titleFor(target.el)
    })
    if (!response?.success) throw new Error(response?.message || "Couldn't start the download.")
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : String(error))
  } finally {
    button.disabled = false
    buttonLabel().textContent = "Download"
  }
})

// ---------------------------------------------------------------------------
// Progress toasts

const toastHost = el("div", "toasts")
const toasts = new Map<string, HTMLElement>()

function removeToast(id: string) {
  toasts.get(id)?.remove()
  toasts.delete(id)
}

function showErrorToast(message: string) {
  const id = `err-${Date.now()}`
  const toast = el("div", "toast")
  const row = el("div", "toast-row")
  const title = el("span", "toast-title")
  title.textContent = "Pinterest video download failed"
  const close = el("button", undefined, "✕")
  close.title = "Dismiss"
  close.onclick = () => removeToast(id)
  row.append(title, close)
  const status = el("div", "toast-status error")
  status.textContent = message
  toast.append(row, status)
  toastHost.append(toast)
  toasts.set(id, toast)
}

function renderJob(job: PinVideoJob) {
  let toast = toasts.get(job.id)
  if (!toast) {
    toast = el("div", "toast")
    toasts.set(job.id, toast)
    toastHost.prepend(toast)
  }
  const running = job.status === "finding" || job.status === "downloading"
  const percent =
    job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0

  const row = el("div", "toast-row")
  const title = el("span", "toast-title")
  title.textContent = job.filename
  title.title = job.filename
  row.append(title)
  if (job.status === "done" && job.downloadId !== undefined) {
    const show = el("button", undefined, "Show")
    show.onclick = () =>
      chrome.runtime.sendMessage({ action: "pinterestVideoShow", downloadId: job.downloadId })
    row.append(show)
  }
  const close = el("button", undefined, "✕")
  close.title = running ? "Cancel download" : "Dismiss"
  close.onclick = () => {
    if (running) chrome.runtime.sendMessage({ action: "pinterestVideoCancel", jobId: job.id })
    removeToast(job.id)
  }
  row.append(close)

  const status = el(
    "div",
    `toast-status${job.status === "error" ? " error" : job.status === "done" ? " done" : ""}`
  )
  status.textContent =
    job.status === "finding"
      ? "Finding the video file…"
      : job.status === "downloading"
      ? job.total > 0
        ? `Downloading · ${formatBytes(job.received) || "0 KB"} of ${formatBytes(job.total)} (${percent}%)`
        : "Downloading…"
      : job.status === "done"
      ? "Saved to Downloads"
      : job.status === "cancelled"
      ? "Cancelled"
      : `Failed: ${job.error || "unknown error"}`

  toast.replaceChildren(row, status)
  if (job.status === "downloading" && job.total > 0) {
    const bar = el("div", "progress")
    const fill = document.createElement("div")
    fill.style.width = `${percent}%`
    bar.append(fill)
    toast.append(bar)
  }
  if (job.status === "done" || job.status === "cancelled") {
    setTimeout(() => removeToast(job.id), DONE_TOAST_MS)
  }
}

// ---------------------------------------------------------------------------

function init() {
  if (!isPinterestHost(location.hostname)) return
  const style = document.createElement("style")
  style.textContent = STYLES
  document.head.append(style)
  document.body.append(button, toastHost)

  rescan()
  setInterval(() => {
    rescan()
    place()
  }, RESCAN_MS)
  document.addEventListener("mousemove", onMouseMove, { capture: true, passive: true })
  window.addEventListener("scroll", place, { capture: true, passive: true })
  window.addEventListener("resize", place, { passive: true })

  chrome.storage.local.get(SAVER_RULES_KEY, (result) => {
    saverRules = readSaverRules(result[SAVER_RULES_KEY])
    place()
  })
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes[SAVER_RULES_KEY]) {
      saverRules = readSaverRules(changes[SAVER_RULES_KEY].newValue)
      place()
    }
  })
  chrome.runtime.sendMessage({ action: "getSaverContext" }, (response) => {
    if (chrome.runtime.lastError) return
    if (typeof response?.windowId === "number") {
      saverWindowId = response.windowId
      place()
    }
  })
  chrome.runtime.onMessage.addListener((request) => {
    if (request?.action === "pinterestVideoUpdate" && request.job) {
      renderJob(request.job as PinVideoJob)
    } else if (request?.action === "saverWindowChanged" && typeof request.windowId === "number") {
      saverWindowId = request.windowId
      place()
    }
  })
}

init()
