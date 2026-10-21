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

const jobs = new Map<string, PinVideoJob & { tabId?: number }>()

function update(job: PinVideoJob & { tabId?: number }, patch: Partial<PinVideoJob>) {
  if (job.status === "cancelled" && patch.status !== "cancelled") return
  Object.assign(job, patch)
  if (job.tabId === undefined) return
  const { tabId, ...payload } = job
  chrome.tabs
    .sendMessage(tabId, { action: "pinterestVideoUpdate", job: payload })
    .catch(() => {})
}

// Polls the browser download for progress; settles when it finishes.
function track(job: PinVideoJob & { tabId?: number }, downloadId: number) {
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

async function run(job: PinVideoJob & { tabId?: number }) {
  try {
    const source = await resolveVideo(job.videoId)
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

function start(request: any, tabId?: number) {
  const videoId = typeof request.videoId === "string" ? request.videoId : ""
  if (!/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{32}$/.test(videoId)) {
    return { success: false, message: "That isn't a Pinterest video." }
  }
  const title = typeof request.title === "string" ? request.title.trim() : ""
  const hash = videoId.split("/").pop()!.slice(0, 8)
  const job: PinVideoJob & { tabId?: number } = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    videoId,
    filename: `${sanitizeFileName(title.slice(0, 80) || "Pinterest video")} [${hash}]`,
    status: "finding",
    received: 0,
    total: 0,
    tabId
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
