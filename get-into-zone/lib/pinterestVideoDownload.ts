// One-click downloads from the Download button on Pinterest video pins. Bulk
// downloads go through pinterestBulkBackground instead.
import { callOffscreen, resolveVideo, withOffscreen } from "./pinterestVideoBackground"
import { sanitizeFileName } from "./youtube"

const POLL_MS = 500

export type PinVideoStatus = "finding" | "downloading" | "done" | "error" | "cancelled"

export interface PinVideoJob {
  id: string
  videoId: string
  filename: string
  status: PinVideoStatus
  received: number
  total: number
  downloadId?: number
  error?: string
}

const jobs = new Map<string, PinVideoJob & { tabId?: number; request?: unknown }>()

function update(job: PinVideoJob & { tabId?: number; request?: unknown }, patch: Partial<PinVideoJob>) {
  if (job.status === "cancelled" && patch.status !== "cancelled") return
  Object.assign(job, patch)
  if (job.tabId === undefined) return
  const { tabId, request: _request, ...payload } = job
  chrome.tabs
    .sendMessage(tabId, { action: "pinterestVideoUpdate", job: payload })
    .catch(() => {})
}

// Polls the browser download for progress; settles when it finishes.
function track(job: PinVideoJob & { tabId?: number; request?: unknown }, downloadId: number) {
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(async () => {
      const [item] = await chrome.downloads.search({ id: downloadId })
      if (!item) return
      if (item.state === "complete") {
        clearInterval(timer)
        update(job, { received: item.totalBytes || item.bytesReceived, total: item.totalBytes })
        resolve()
      } else if (item.state === "interrupted") {
        clearInterval(timer)
        if (item.error === "USER_CANCELED") update(job, { status: "cancelled" })
        reject(new Error(`Download failed: ${item.error ?? "interrupted"}`))
      } else {
        update(job, { received: item.bytesReceived, total: item.totalBytes })
      }
    }, POLL_MS)
  })
}

// A function, not an inline check: cancel() flips the status while run() awaits.
const cancelled = (job: PinVideoJob) => job.status === "cancelled"

async function run(job: PinVideoJob & { tabId?: number; request?: unknown }) {
  try {
    const source = await resolveSource(job.request, job.tabId)
    if (cancelled(job)) return

    if (source.type === "mp4") {
      const downloadId = await chrome.downloads.download({
        url: source.url,
        filename: `${job.filename}.mp4`,
        conflictAction: "uniquify",
        saveAs: false
      })
      update(job, { status: "downloading", downloadId })
      await track(job, downloadId)
    } else {
      // No single file exists; the offscreen document joins the HLS stream.
      update(job, { status: "downloading" })
      await withOffscreen(async () => {
        const file = await callOffscreen<{ blobUrl: string; ext: string }>({
          action: "hlsToBlobUrl",
          url: source.url
        })
        try {
          if (cancelled(job)) return
          const downloadId = await chrome.downloads.download({
            url: file.blobUrl,
            filename: `${job.filename}.${file.ext}`,
            conflictAction: "uniquify",
            saveAs: false
          })
          update(job, { downloadId })
          await track(job, downloadId)
        } finally {
          await callOffscreen({ action: "revokeBlobUrl", blobUrl: file.blobUrl }).catch(
            () => {}
          )
        }
      })
    }
    if (!cancelled(job)) update(job, { status: "done" })
  } catch (error) {
    if (cancelled(job)) return
    update(job, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

const HASH_RE = /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/
const PIN_ID_RE = /^\d{5,20}$/
const DIRECT_RE = /^https:\/\/(?:[\w-]+\.)?pinimg\.com\/videos\/.+\.(?:mp4|m3u8)(?:[?#].*)?$/i

const hashOf = (value: unknown) =>
  typeof value === "string" && HASH_RE.test(value) ? value : ""

// Runs in the Pinterest page, where the session cookie is sent. Returns the
// best MP4 for that pin, or its HLS stream when no single file is published.
async function videoUrlFromPin(pinId: string, signature: string): Promise<string> {
  const bare = signature.split("/").pop() || ""
  if (bare) {
    const loaded = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) => bare && name.includes(bare) && /pinimg\.com\/videos\/.+\.mp4/i.test(name))
    if (loaded) return loaded.split("#")[0]
  }

  const token = decodeURIComponent(
    document.cookie
      .split("; ")
      .find((row) => row.startsWith("csrftoken="))
      ?.slice("csrftoken=".length) || ""
  )
  const data = encodeURIComponent(
    JSON.stringify({ options: { id: pinId, field_set_key: "detailed" }, context: {} })
  )
  const source = encodeURIComponent(`/pin/${pinId}/`)
  const resp = await fetch(`/resource/PinResource/get/?source_url=${source}&data=${data}`, {
    credentials: "include",
    headers: {
      Accept: "application/json",
      "X-Requested-With": "XMLHttpRequest",
      "X-Pinterest-AppState": "active",
      // Without this Pinterest answers 403 "Invalid Resource Request".
      "X-Pinterest-PWS-Handler": "www/pin/[id].js",
      ...(token ? { "X-CSRFToken": token } : {})
    }
  })
  if (!resp.ok) throw new Error(`Pinterest returned ${resp.status}`)
  const json = (await resp.json()) as { resource_response?: { data?: unknown } }
  const found: { url: string; width: number; mp4: boolean }[] = []
  const walk = (value: unknown) => {
    if (!value || typeof value !== "object") return
    const record = value as { url?: unknown; width?: unknown }
    // Only playable files: the same subtree also holds /videos/thumbnails/ JPEGs.
    if (typeof record.url === "string" && /pinimg\.com\/videos\/.+\.(?:mp4|m3u8)(?:[?#]|$)/i.test(record.url)) {
      found.push({
        url: record.url.split("#")[0],
        width: typeof record.width === "number" ? record.width : 0,
        mp4: /\.mp4(?:[?#]|$)/i.test(record.url)
      })
    }
    for (const child of Object.values(record)) walk(child)
  }
  walk(json?.resource_response?.data ?? json)
  const mp4s = found.filter((item) => item.mp4)
  mp4s.sort((a, b) => {
    const score = (width: number) => (width >= 720 ? 10000 - (width - 720) : width)
    return score(b.width) - score(a.width)
  })
  const best = mp4s[0] || found.find((item) => !item.mp4)
  if (!best) throw new Error("That pin has no video file.")
  return best.url
}

async function resolveSource(request: any, tabId?: number) {
  const videoId = hashOf(request.videoId)
  if (videoId) return resolveVideo(videoId)

  const pinId = typeof request.pinId === "string" && PIN_ID_RE.test(request.pinId) ? request.pinId : ""
  const signature = hashOf(request.signature)
  if (pinId && tabId !== undefined) {
    try {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: videoUrlFromPin,
        args: [pinId, signature]
      })
      const url = injected?.result
      if (typeof url === "string" && DIRECT_RE.test(url)) {
        return { type: /\.m3u8(?:[?#]|$)/i.test(url) ? ("hls" as const) : ("mp4" as const), url }
      }
    } catch {
      // The pin page can refuse the lookup; the cover image's hash is the fallback.
    }
  }
  if (signature) return resolveVideo(signature)
  throw new Error("That isn't a Pinterest video.")
}

function start(request: any, tabId?: number) {
  const videoId = hashOf(request.videoId) || hashOf(request.signature)
  const pinId = typeof request.pinId === "string" && PIN_ID_RE.test(request.pinId) ? request.pinId : ""
  if (!videoId && !pinId) return { success: false, message: "That isn't a Pinterest video." }
  const title = typeof request.title === "string" ? request.title.trim() : ""
  const hash = (videoId || pinId).split("/").pop()!.slice(0, 8)
  const job: PinVideoJob & { tabId?: number; request?: unknown } = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    videoId,
    filename: `${sanitizeFileName(title.slice(0, 80) || "Pinterest video")} [${hash}]`,
    status: "finding",
    received: 0,
    total: 0,
    tabId,
    request
  }
  jobs.set(job.id, job)
  update(job, {})
  run(job).finally(() => setTimeout(() => jobs.delete(job.id), 60_000))
  return { success: true, jobId: job.id }
}

async function cancel(jobId: string) {
  const job = jobs.get(jobId)
  if (!job || job.status === "done" || job.status === "error") return
  update(job, { status: "cancelled" })
  if (job.downloadId !== undefined) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {})
  }
}

export function initPinterestVideoDownloads() {
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request?.action) {
      case "pinterestVideoDownload":
        sendResponse(start(request, sender.tab?.id))
        return
      case "pinterestVideoCancel":
        cancel(String(request.jobId)).then(() => sendResponse({ success: true }))
        return true
      case "pinterestVideoShow":
        chrome.downloads.show(Number(request.downloadId))
        sendResponse({ success: true })
        return
    }
  })
}
