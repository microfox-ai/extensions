import type { PlasmoCSConfig } from "plasmo"

import {
  isSaverActive,
  watchSaverRules,
  type SaverRule
} from "../lib/saverRules"
import {
  buildOptions,
  fetchPlayerInPage,
  formatBytes,
  parseVideoId,
  type YtJob,
  type YtOption,
  type YtVideo
} from "../lib/youtube"

export const config: PlasmoCSConfig = {
  matches: ["https://www.youtube.com/*"],
  run_at: "document_idle"
}

const PREFIX = "giz-yt"
const FORMATS_TTL_MS = 30 * 60 * 1000
const MIN_THUMB_WIDTH = 100
const MIN_THUMB_HEIGHT = 56
const DONE_TOAST_MS = 6000

const DOWNLOAD_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`
const CARET_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`

const STYLES = `
.${PREFIX}-thumb {
  position: fixed; z-index: 2147483000; display: none; align-items: center; gap: 4px;
  height: 28px; padding: 0 10px 0 8px; border: none; border-radius: 14px;
  background: rgba(0,0,0,0.8); color: #fff; cursor: pointer;
  font: 500 12px/1 Roboto, Arial, sans-serif; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
}
.${PREFIX}-thumb:hover { background: #ff0033; }
.${PREFIX}-thumb svg { width: 15px; height: 15px; }
.${PREFIX}-bar { position: relative; display: flex; align-items: center; gap: 8px; margin: 8px 0 4px; }
.${PREFIX}-split { display: inline-flex; height: 36px; border-radius: 18px; overflow: hidden; }
.${PREFIX}-split button {
  display: inline-flex; align-items: center; gap: 6px; border: none; cursor: pointer;
  background: #ff0033; color: #fff; font: 500 14px/1 Roboto, Arial, sans-serif;
}
.${PREFIX}-split button:hover { background: #d9002b; }
.${PREFIX}-split button:disabled { opacity: 0.7; cursor: default; }
.${PREFIX}-main { padding: 0 14px 0 12px; }
.${PREFIX}-caret { padding: 0 10px; border-left: 1px solid rgba(255,255,255,0.35) !important; }
.${PREFIX}-hint { font: 400 12px/1.3 Roboto, Arial, sans-serif; color: var(--yt-spec-text-secondary, #606060); }
.${PREFIX}-menu {
  position: absolute; top: 42px; left: 0; z-index: 2300; min-width: 280px; max-height: 360px;
  overflow-y: auto; padding: 8px 0; border-radius: 12px;
  background: var(--yt-spec-menu-background, #fff); color: var(--yt-spec-text-primary, #0f0f0f);
  box-shadow: 0 4px 32px rgba(0,0,0,0.25); font: 400 14px/1.4 Roboto, Arial, sans-serif;
}
.${PREFIX}-menu-head { padding: 8px 16px 4px; font-size: 12px; font-weight: 500; color: var(--yt-spec-text-secondary, #606060); }
.${PREFIX}-menu button {
  display: flex; width: 100%; gap: 12px; justify-content: space-between; padding: 8px 16px;
  border: none; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.${PREFIX}-menu button:hover { background: var(--yt-spec-10-percent-layer, rgba(0,0,0,0.1)); }
.${PREFIX}-menu small { color: var(--yt-spec-text-secondary, #606060); font-size: 12px; white-space: nowrap; }
.${PREFIX}-toasts {
  position: fixed; top: 68px; right: 16px; z-index: 2147483001; display: flex; flex-direction: column;
  gap: 8px; width: 320px; font: 400 13px/1.35 Roboto, Arial, sans-serif;
}
.${PREFIX}-toast { padding: 10px 12px; border-radius: 10px; background: #212121; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
.${PREFIX}-toast-row { display: flex; align-items: center; gap: 8px; }
.${PREFIX}-toast-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }
.${PREFIX}-toast button { border: none; background: none; color: #aaa; cursor: pointer; font: 500 12px Roboto, Arial, sans-serif; padding: 2px 4px; }
.${PREFIX}-toast button:hover { color: #fff; }
.${PREFIX}-toast-status { margin-top: 4px; font-size: 12px; color: #ccc; }
.${PREFIX}-toast-status.error { color: #ff8a80; }
.${PREFIX}-toast-status.done { color: #81c995; }
.${PREFIX}-progress { height: 3px; margin-top: 6px; border-radius: 2px; background: #555; overflow: hidden; }
.${PREFIX}-progress div { height: 100%; background: #ff0033; transition: width 0.3s; }
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
// Saver toggle: the buttons follow the "Download buttons" switch in the Saver tab.

let saverRules: SaverRule[] = []
let saverWindowId: number | undefined

const enabled = () =>
  isSaverActive(saverRules, "youtube", {
    url: location.href,
    windowId: saverWindowId
  })

// ---------------------------------------------------------------------------
// Formats and starting downloads

const formatsCache = new Map<string, { at: number; video: Promise<YtVideo> }>()

function getVideo(videoId: string) {
  const cached = formatsCache.get(videoId)
  if (cached && Date.now() - cached.at < FORMATS_TTL_MS) return cached.video
  // Content scripts send requests with the page's origin, which the player API accepts.
  const video = fetchPlayerInPage(videoId).then((result) => {
    if (!result.ok) throw new Error(result.message)
    return result.video as YtVideo
  })
  formatsCache.set(videoId, { at: Date.now(), video })
  video.catch(() => formatsCache.delete(videoId))
  return video
}

// One-click picks the best H.264 (plays everywhere); AV1 and 4K stay in the menu.
const bestOption = (video: YtVideo) => {
  const withSound = buildOptions(video, "both")
  return (
    withSound.find((o) => o.streams[0].codec.startsWith("avc1")) ??
    withSound[0] ??
    buildOptions(video, "audio")[0]
  )
}

async function startDownload(videoId: string, option?: YtOption) {
  try {
    const video = await getVideo(videoId)
    const chosen = option ?? bestOption(video)
    if (!chosen) throw new Error("This video has no downloadable formats.")
    const response = await chrome.runtime.sendMessage({
      action: "youtubeDownload",
      videoId,
      title: video.title,
      label: chosen.label,
      ext: chosen.ext,
      streams: chosen.streams
    })
    if (!response?.success) {
      throw new Error(response?.message || "Couldn't start the download.")
    }
  } catch (error) {
    showErrorToast(error instanceof Error ? error.message : String(error))
  }
}

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
  title.textContent = "YouTube download failed"
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

const STATUS_TEXT: Record<YtJob["status"], string> = {
  downloading: "Downloading",
  merging: "Merging video and audio…",
  saving: "Saving…",
  done: "Saved to Downloads",
  error: "Failed",
  cancelled: "Cancelled"
}

function renderJob(job: YtJob) {
  let toast = toasts.get(job.id)
  if (!toast) {
    toast = el("div", "toast")
    toasts.set(job.id, toast)
    toastHost.prepend(toast)
  }
  const percent =
    job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0
  const running = ["downloading", "merging", "saving"].includes(job.status)

  const row = el("div", "toast-row")
  const title = el("span", "toast-title")
  title.textContent = job.filename
  title.title = job.filename
  row.append(title)
  if (job.status === "done" && job.downloadId !== undefined) {
    const show = el("button", undefined, "Show")
    show.onclick = () =>
      chrome.runtime.sendMessage({ action: "youtubeShowDownload", downloadId: job.downloadId })
    row.append(show)
  }
  const close = el("button", undefined, "✕")
  close.title = running ? "Cancel download" : "Dismiss"
  close.onclick = () => {
    if (running) chrome.runtime.sendMessage({ action: "youtubeCancel", jobId: job.id })
    removeToast(job.id)
  }
  row.append(close)

  const status = el(
    "div",
    `toast-status${job.status === "error" ? " error" : job.status === "done" ? " done" : ""}`
  )
  status.textContent =
    job.status === "downloading" && job.total > 0
      ? `Downloading · ${formatBytes(job.received) || "0 KB"} of ${formatBytes(job.total)} (${percent}%)`
      : job.status === "error" && job.error
      ? `Failed: ${job.error}`
      : STATUS_TEXT[job.status]

  toast.replaceChildren(row, status)
  if (job.status === "downloading") {
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
// Hover button on thumbnails

const thumbButton = el("button", "thumb", `${DOWNLOAD_ICON}<span>Download</span>`)
thumbButton.title = "Download this video"
let tracked: { anchor: HTMLAnchorElement; videoId: string } | null = null

function thumbnailAt(target: EventTarget | null) {
  if (!(target instanceof Element)) return null
  const anchor = target.closest("a[href]") as HTMLAnchorElement | null
  if (!anchor || !anchor.querySelector("img, video")) return null
  const videoId = parseVideoId(anchor.href)
  if (!videoId) return null
  const rect = anchor.getBoundingClientRect()
  if (rect.width < MIN_THUMB_WIDTH || rect.height < MIN_THUMB_HEIGHT) return null
  return { anchor, videoId }
}

function placeThumbButton() {
  if (!tracked || !tracked.anchor.isConnected) return hideThumbButton()
  const rect = tracked.anchor.getBoundingClientRect()
  thumbButton.style.left = `${rect.left + 8}px`
  // Bottom-left: the generic Save button takes the top-left, the duration badge the bottom-right.
  thumbButton.style.top = `${rect.bottom - 8 - 28}px`
  thumbButton.style.display = "inline-flex"
}

function hideThumbButton() {
  tracked = null
  thumbButton.style.display = "none"
}

const inside = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

function onPointerOver(event: PointerEvent) {
  if (!enabled()) return hideThumbButton()
  if (event.target === thumbButton || thumbButton.contains(event.target as Node)) return
  const found = thumbnailAt(event.target)
  if (found) {
    if (found.anchor !== tracked?.anchor) {
      tracked = found
      thumbButton.querySelector("span")!.textContent = "Download"
    }
    placeThumbButton()
    return
  }
  // YouTube's inline preview player covers the thumbnail without being inside its link.
  if (tracked && inside(tracked.anchor.getBoundingClientRect(), event.clientX, event.clientY)) {
    return
  }
  hideThumbButton()
}

thumbButton.addEventListener("click", (event) => {
  event.preventDefault()
  event.stopPropagation()
  if (!tracked) return
  const { videoId } = tracked
  thumbButton.querySelector("span")!.textContent = "Starting…"
  startDownload(videoId).finally(() => {
    if (tracked?.videoId === videoId) {
      thumbButton.querySelector("span")!.textContent = "Download"
    }
  })
})

// ---------------------------------------------------------------------------
// Download bar under the title on watch pages

let bar: HTMLElement | null = null
let barVideoId: string | null = null

function closeMenu() {
  bar?.querySelector(`.${PREFIX}-menu`)?.remove()
}

function menuSection(menu: HTMLElement, heading: string, options: YtOption[], videoId: string) {
  if (options.length === 0) return
  menu.append(Object.assign(el("div", "menu-head"), { textContent: heading }))
  for (const option of options) {
    const item = document.createElement("button")
    const label = document.createElement("span")
    label.textContent = option.label
    const size = document.createElement("small")
    size.textContent = [option.detail, formatBytes(option.size)].filter(Boolean).join(" · ")
    item.append(label, size)
    item.onclick = () => {
      closeMenu()
      startDownload(videoId, option)
    }
    menu.append(item)
  }
}

async function toggleMenu(videoId: string) {
  if (!bar) return
  if (bar.querySelector(`.${PREFIX}-menu`)) return closeMenu()
  const menu = el("div", "menu")
  menu.append(Object.assign(el("div", "menu-head"), { textContent: "Loading formats…" }))
  bar.append(menu)
  try {
    const video = await getVideo(videoId)
    menu.replaceChildren()
    menuSection(menu, "Video with sound (MP4)", buildOptions(video, "both"), videoId)
    menuSection(menu, "Audio only", buildOptions(video, "audio"), videoId)
    menuSection(menu, "Video only, no sound", buildOptions(video, "video"), videoId)
  } catch (error) {
    menu.replaceChildren(
      Object.assign(el("div", "menu-head"), {
        textContent: error instanceof Error ? error.message : String(error)
      })
    )
  }
}

function buildBar(videoId: string) {
  const root = el("div", "bar")
  const split = el("div", "split")
  const main = el("button", "main", `${DOWNLOAD_ICON}<span>Download</span>`)
  main.title = "Download this video in the best quality with sound"
  const caret = el("button", "caret", CARET_ICON)
  caret.title = "Choose quality"
  const hint = el("span", "hint")
  split.append(main, caret)
  root.append(split, hint)

  const label = main.querySelector("span")!
  main.onclick = async () => {
    main.disabled = true
    label.textContent = "Starting…"
    await startDownload(videoId)
    main.disabled = false
    label.textContent = "Download"
  }
  caret.onclick = (event) => {
    event.stopPropagation()
    toggleMenu(videoId)
  }

  getVideo(videoId).then(
    (video) => {
      const best = bestOption(video)
      if (best) hint.textContent = [best.label, formatBytes(best.size)].filter(Boolean).join(" · ")
    },
    () => {
      hint.textContent = "Formats unavailable"
    }
  )
  return root
}

function syncWatchBar() {
  const videoId = location.pathname === "/watch" ? parseVideoId(location.href) : null
  const title = document.querySelector("ytd-watch-metadata #title")
  if (!enabled() || !videoId || !title) {
    bar?.remove()
    bar = null
    barVideoId = null
    return
  }
  if (bar && barVideoId === videoId && bar.parentElement === title.parentElement) return
  bar?.remove()
  bar = buildBar(videoId)
  barVideoId = videoId
  title.insertAdjacentElement("afterend", bar)
}

// ---------------------------------------------------------------------------

function refresh() {
  if (!enabled()) hideThumbButton()
  syncWatchBar()
}

function init() {
  const style = document.createElement("style")
  style.textContent = STYLES
  document.head.append(style)
  document.body.append(thumbButton, toastHost)

  document.addEventListener("pointerover", onPointerOver, true)
  window.addEventListener("scroll", () => tracked && placeThumbButton(), {
    capture: true,
    passive: true
  })
  document.addEventListener("click", (event) => {
    if (bar && !bar.contains(event.target as Node)) closeMenu()
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu()
  })

  // YouTube is a single-page app that re-renders the title area on its own schedule.
  document.addEventListener("yt-navigate-finish", refresh)
  setInterval(syncWatchBar, 1000)

  watchSaverRules((rules) => {
    saverRules = rules
    refresh()
  })
  chrome.runtime.sendMessage({ action: "getSaverContext" }, (response) => {
    if (chrome.runtime.lastError) return
    if (typeof response?.windowId === "number") {
      saverWindowId = response.windowId
      refresh()
    }
  })
  chrome.runtime.onMessage.addListener((request) => {
    if (request?.action === "youtubeJobUpdate" && request.job) {
      renderJob(request.job as YtJob)
    } else if (request?.action === "saverWindowChanged" && typeof request.windowId === "number") {
      saverWindowId = request.windowId
      refresh()
    }
  })
}

init()
