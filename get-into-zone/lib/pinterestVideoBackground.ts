import { getUploadUrl, queueSparkboardIndex } from "./mediamake"
import { pinVideoSources, type BulkItem, type BulkSession } from "./pinterestBulk"

const OFFSCREEN_URL = "tabs/offscreen.html"
const OTHER_OFFSCREEN_WAIT_MS = 120_000
let creatingOffscreen: Promise<void> | null = null
let offscreenUsers = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const openOffscreenDocument = async () =>
  (
    await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
    })
  )[0]

// An extension can have only one offscreen document, and the YouTube
// downloader keeps its own open after use. Wait until it's idle, close it (it
// reopens on its next download), and close ours as soon as we're done.
async function ensureOffscreen() {
  const ownUrl = chrome.runtime.getURL(OFFSCREEN_URL)
  for (let waited = 0; ; waited += 1000) {
    const open = await openOffscreenDocument()
    if (!open) break
    if (open.documentUrl === ownUrl) return
    const status = await chrome.runtime
      .sendMessage({ target: "youtube-offscreen", action: "status" })
      .catch(() => null)
    if (!status?.busy) {
      await chrome.offscreen.closeDocument().catch(() => {})
      break
    }
    if (waited >= OTHER_OFFSCREEN_WAIT_MS) {
      throw new Error("A YouTube download is still running; video skipped.")
    }
    await sleep(1000)
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: "Assemble Pinterest video streams into downloadable files"
      })
      .finally(() => {
        creatingOffscreen = null
      })
  }
  await creatingOffscreen
}

async function withOffscreen<T>(work: () => Promise<T>): Promise<T> {
  offscreenUsers++
  try {
    await ensureOffscreen()
    return await work()
  } finally {
    offscreenUsers--
    if (offscreenUsers === 0) {
      const open = await openOffscreenDocument()
      if (open?.documentUrl === chrome.runtime.getURL(OFFSCREEN_URL)) {
        await chrome.offscreen.closeDocument().catch(() => {})
      }
    }
  }
}

async function callOffscreen<T>(message: Record<string, unknown>): Promise<T> {
  let response: any
  // Right after creation the document may not be listening yet.
  for (let attempt = 1; attempt <= 5 && !response; attempt++) {
    response = await chrome.runtime
      .sendMessage({ target: "offscreen", ...message })
      .catch(() => undefined)
    if (!response) await sleep(200 * attempt)
  }
  if (!response?.success) {
    throw new Error(response?.message || "Video processing failed.")
  }
  return response as T
}

async function firstAvailable(urls: string[]) {
  const ok = await Promise.all(
    urls.map((url) =>
      fetch(url, { method: "HEAD" }).then(
        (resp) => resp.ok,
        () => false
      )
    )
  )
  return urls[ok.indexOf(true)]
}

async function resolveVideo(id: string) {
  const sources = pinVideoSources(id)
  const mp4 = await firstAvailable(sources.mp4)
  if (mp4) return { type: "mp4" as const, url: mp4 }
  const hls = await firstAvailable(sources.hls)
  if (hls) return { type: "hls" as const, url: hls }
  throw new Error("Couldn't find the file for a video.")
}

// Resolves once a download finishes; blob: URLs must stay alive until then.
function waitForDownload(downloadId: number) {
  return new Promise<void>((resolve, reject) => {
    const settle = (state?: string, error?: string) => {
      if (state === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged)
        resolve()
      } else if (state === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged)
        reject(new Error(`Video download failed: ${error ?? "interrupted"}`))
      }
    }
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId) settle(delta.state?.current, delta.error?.current)
    }
    chrome.downloads.onChanged.addListener(onChanged)
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      settle(item?.state, item?.error)
    })
  })
}

const videoMetadata = (item: BulkItem, url: string) => ({
  platform: "web",
  platformId: "web",
  platformUrl: item.pageUrl,
  videoLink: url,
  src: url,
  alt: item.alt
})

export async function saveVideo(session: BulkSession, item: BulkItem) {
  const source = await resolveVideo(item.id)
  const baseName = item.id.split("/").pop()!

  if (source.type === "mp4") {
    if (session.destination === "browser") {
      await chrome.downloads.download({
        url: source.url,
        filename: `${session.videoFolder}/${baseName}.mp4`,
        conflictAction: "uniquify",
        saveAs: false
      })
      return
    }
    const result = await queueSparkboardIndex({
      contentType: "video",
      sourceUrl: source.url,
      tags: session.tags,
      contentMimeType: "video/mp4",
      contentSubType: "general",
      contentSource: "web",
      contentSourceUrl: source.url,
      fileName: `${baseName}.mp4`,
      metadata: videoMetadata(item, source.url)
    })
    if (!result.success) throw new Error(result.message || "Video upload failed.")
    return
  }

  // HLS only: no single file exists, so the offscreen document downloads the
  // stream and builds one.
  await withOffscreen(() => saveHlsVideo(session, item, source.url, baseName))
}

async function saveHlsVideo(
  session: BulkSession,
  item: BulkItem,
  hlsUrl: string,
  baseName: string
) {
  const file = await callOffscreen<{
    blobUrl: string
    ext: string
    mime: string
    size: number
  }>({ action: "hlsToBlobUrl", url: hlsUrl })
  const fileName = `${baseName}.${file.ext}`
  try {
    if (session.destination === "browser") {
      const downloadId = await chrome.downloads.download({
        url: file.blobUrl,
        filename: `${session.videoFolder}/${fileName}`,
        conflictAction: "uniquify",
        saveAs: false
      })
      await waitForDownload(downloadId)
      return
    }

    const { uploadUrl, publicUrl } = await getUploadUrl(fileName, file.mime)
    await callOffscreen({
      action: "uploadBlob",
      blobUrl: file.blobUrl,
      uploadUrl,
      // Must match what the presigned URL was signed with.
      headers: { "Content-Type": file.mime, "x-amz-acl": "public-read" }
    })
    const result = await queueSparkboardIndex({
      contentType: "video",
      filePath: publicUrl,
      fileSize: file.size,
      tags: session.tags,
      contentMimeType: file.mime,
      contentSubType: "general",
      contentSource: "web",
      contentSourceUrl: hlsUrl,
      fileName,
      metadata: videoMetadata(item, hlsUrl)
    })
    if (!result.success) throw new Error(result.message || "Video upload failed.")
  } finally {
    await callOffscreen({ action: "revokeBlobUrl", blobUrl: file.blobUrl }).catch(
      () => {}
    )
  }
}
