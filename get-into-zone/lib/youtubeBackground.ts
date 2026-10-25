import {
  YT_JOBS_KEY,
  fetchPlayerInPage,
  parseVideoId,
  sanitizeFileName,
  type YtFormat,
  type YtJob
} from "./youtube"

const OFFSCREEN_URL = "tabs/youtube-offscreen.html"
const OTHER_OFFSCREEN_WAIT_MS = 120_000
const FINISHED = new Set(["done", "error", "cancelled"])

// Jobs live in chrome.storage.session so the popup can show progress and the
// list survives the service worker being stopped.
let jobs: Record<string, YtJob> = {}
let loading: Promise<void> | null = null

const loadJobs = () => {
  if (!loading) {
    loading = chrome.storage.session.get(YT_JOBS_KEY).then((result) => {
      jobs = { ...(result[YT_JOBS_KEY] ?? {}), ...jobs }
    })
  }
  return loading
}

const persist = () => chrome.storage.session.set({ [YT_JOBS_KEY]: jobs })

// The page buttons show their own progress toasts, fed from here.
const notifyTab = (job: YtJob) => {
  if (job.tabId === undefined) return
  const { blobUrl, ...update } = job
  chrome.tabs
    .sendMessage(job.tabId, { action: "youtubeJobUpdate", job: update })
    .catch(() => {})
}

const updateJob = async (id: string, patch: Partial<YtJob>) => {
  await loadJobs()
  if (!jobs[id]) return
  jobs[id] = { ...jobs[id], ...patch }
  notifyTab(jobs[id])
  await persist()
}

// Offscreen reports can arrive after the user cancelled; they must not revive the job.
const updateRunningJob = async (id: string, patch: Partial<YtJob>) => {
  await loadJobs()
  if (jobs[id] && !FINISHED.has(jobs[id].status)) await updateJob(id, patch)
}

let creatingOffscreen: Promise<void> | null = null

// An extension can have only one offscreen document. The Pinterest video
// downloader closes its own as soon as it's done, so wait for that.
async function ensureOffscreen() {
  const ownUrl = chrome.runtime.getURL(OFFSCREEN_URL)
  for (let waited = 0; ; waited += 1000) {
    const [open] = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    })
    if (!open) break
    if (open.documentUrl === ownUrl) return
    if (waited >= OTHER_OFFSCREEN_WAIT_MS) {
      throw new Error("A Pinterest video download is still running; try again shortly.")
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "Download and merge YouTube video and audio streams."
      })
      .finally(() => {
        creatingOffscreen = null
      })
  }
  await creatingOffscreen
}

async function sendToOffscreen(message: Record<string, unknown>) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await chrome.runtime.sendMessage({
        ...message,
        target: "youtube-offscreen"
      })
    } catch (error) {
      // The document may still be loading its script right after creation.
      if (attempt >= 5) throw error
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt))
    }
  }
}

async function releaseBlob(job: YtJob) {
  if (!job.blobUrl) return
  await sendToOffscreen({ action: "release", jobId: job.id }).catch(() => {})
}

// Any YouTube tab can read any video's formats; by default the tab's own video.
export async function getVideo(tabId: number, id?: string) {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined)
  const videoId = id ?? parseVideoId(tab?.url)
  if (!tab?.id || !videoId) {
    return { success: false, message: "Open a YouTube video in this tab first." }
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: fetchPlayerInPage,
    args: [videoId]
  })
  const result = injection?.result
  if (!result?.ok) {
    return {
      success: false,
      message: result?.message || "Couldn't read this video's formats."
    }
  }
  return { success: true, video: result.video }
}

export async function startDownload(request: any, tabId?: number) {
  const streams: YtFormat[] = Array.isArray(request.streams) ? request.streams : []
  if (streams.length === 0 || streams.length > 2) {
    return { success: false, message: "Pick a format to download." }
  }
  const [main] = streams
  const suffix =
    main.kind === "audio"
      ? ""
      : ` (${main.qualityLabel ?? `${main.height}p`}${
          streams.length === 1 && !main.hasAudio ? ", no sound" : ""
        })`
  const ext = typeof request.ext === "string" ? request.ext : main.container
  const title = String(request.title || request.videoId || "YouTube video")

  const job: YtJob = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    videoId: String(request.videoId ?? ""),
    title,
    label: String(request.label ?? ""),
    filename: `${sanitizeFileName(title)}${suffix}.${ext}`,
    status: "downloading",
    received: 0,
    total: streams.reduce((n, s) => n + (s.contentLength ?? 0), 0),
    tabId,
    streams: streams.map((s) => ({
      itag: s.itag,
      contentLength: s.contentLength,
      audioTrack: s.audioTrack
    })),
    createdAt: Date.now()
  }
  await loadJobs()
  jobs[job.id] = job
  notifyTab(job)
  await persist()

  try {
    await ensureOffscreen()
    await sendToOffscreen({
      action: "start",
      job: {
        id: job.id,
        streams: streams.map((s) => ({ url: s.url, contentLength: s.contentLength })),
        merge: streams.length === 2
      }
    })
  } catch (error) {
    await updateJob(job.id, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    })
    return { success: false, message: "Couldn't start the download." }
  }
  return { success: true, jobId: job.id }
}

// The player API only answers requests sent from a YouTube page, so fresh
// stream URLs are fetched through the job's tab or any other open YouTube tab.
async function refreshStreams(jobId: string) {
  await loadJobs()
  const job = jobs[jobId]
  if (!job?.streams || !job.videoId || FINISHED.has(job.status)) {
    return { success: false, message: "This download can't be resumed." }
  }
  const tabs = (await chrome.tabs.query({ url: "*://*.youtube.com/*" }))
    .filter((tab) => tab.id !== undefined && !tab.discarded)
    .sort((a, b) => Number(b.id === job.tabId) - Number(a.id === job.tabId))
  if (tabs.length === 0) {
    return {
      success: false,
      message: "Keep a YouTube tab open while downloading so the link can be renewed."
    }
  }
  let message = "Couldn't renew the download link."
  for (const tab of tabs) {
    const [injection] = await chrome.scripting
      .executeScript({ target: { tabId: tab.id! }, func: fetchPlayerInPage, args: [job.videoId] })
      .catch(() => [])
    const result = injection?.result
    if (!result?.ok) {
      message = result?.message || message
      continue
    }
    const urls = job.streams.map(
      (s) =>
        result.video.formats.find(
          (f) =>
            f.itag === s.itag &&
            f.audioTrack === s.audioTrack &&
            (!s.contentLength || f.contentLength === s.contentLength)
        )?.url
    )
    if (urls.every(Boolean)) return { success: true, urls }
    message = "YouTube no longer offers the chosen format for this video."
  }
  return { success: false, message }
}

async function saveBlob(jobId: string, blobUrl: string) {
  await loadJobs()
  const job = jobs[jobId]
  if (!job || job.status === "cancelled") {
    await sendToOffscreen({ action: "release", jobId }).catch(() => {})
    return
  }
  await updateJob(jobId, { status: "saving", blobUrl })
  try {
    const downloadId = await chrome.downloads.download({
      url: blobUrl,
      filename: job.filename,
      conflictAction: "uniquify",
      saveAs: false
    })
    await updateJob(jobId, { downloadId })
  } catch (error) {
    await updateJob(jobId, {
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    })
    await releaseBlob(jobs[jobId])
  }
}

export async function cancelJob(jobId: string) {
  await loadJobs()
  const job = jobs[jobId]
  if (!job || FINISHED.has(job.status)) return { success: true }
  await updateJob(jobId, { status: "cancelled" })
  if (job.downloadId !== undefined) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {})
  }
  await sendToOffscreen({ action: "cancel", jobId }).catch(() => {})
  await releaseBlob(job)
  return { success: true }
}

export async function listJobs() {
  await loadJobs()
  return Object.values(jobs)
}

export async function clearFinished() {
  await loadJobs()
  jobs = Object.fromEntries(
    Object.entries(jobs).filter(([, job]) => !FINISHED.has(job.status))
  )
  await persist()
  return { success: true }
}

async function onDownloadChanged(delta: chrome.downloads.DownloadDelta) {
  const state = delta.state?.current
  if (state !== "complete" && state !== "interrupted") return
  await loadJobs()
  const job = Object.values(jobs).find((j) => j.downloadId === delta.id)
  if (!job) return
  if (state === "complete") {
    await updateJob(job.id, { status: "done", received: job.total })
  } else if (job.status !== "cancelled") {
    const [item] = await chrome.downloads.search({ id: delta.id })
    await updateJob(job.id, {
      status: item?.error === "USER_CANCELED" ? "cancelled" : "error",
      error: item?.error ? `Download failed: ${item.error}` : "Download failed."
    })
  }
  await releaseBlob(job)
}

export function initYouTubeBackground() {
  chrome.downloads.onChanged.addListener((delta) => {
    onDownloadChanged(delta)
  })

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    let response: Promise<unknown>
    switch (request?.action) {
      case "youtubeGetVideo":
        response = getVideo(Number(request.tabId))
        break
      case "youtubeDownload":
        response = startDownload(request, sender.tab?.id)
        break
      case "youtubeShowDownload":
        chrome.downloads.show(Number(request.downloadId))
        response = Promise.resolve({ success: true })
        break
      case "youtubeCancel":
        response = cancelJob(String(request.jobId))
        break
      case "youtubeClearFinished":
        response = clearFinished()
        break
      case "ytOffscreenProgress":
        response = updateRunningJob(String(request.jobId), {
          ...(typeof request.received === "number" ? { received: request.received } : {}),
          ...(typeof request.total === "number" && request.total > 0
            ? { total: request.total }
            : {}),
          ...(request.status === "merging" ? { status: "merging" as const } : {})
        })
        break
      case "ytOffscreenRefresh":
        response = refreshStreams(String(request.jobId))
        break
      case "ytOffscreenDone":
        response = saveBlob(String(request.jobId), String(request.blobUrl))
        break
      case "ytOffscreenError":
        response = updateRunningJob(String(request.jobId), {
          status: "error",
          error: String(request.message || "Download failed.")
        })
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
