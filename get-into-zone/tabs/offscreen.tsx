import { downloadHls } from "../lib/hls"

// Offscreen document used by the background worker to assemble HLS videos:
// service workers can't create blob: URLs, and chrome.downloads rejects data:
// URLs over 2 MB. Only chrome.runtime is available here.

const blobs = new Map<string, Blob>()

async function handle(request: any) {
  switch (request.action) {
    case "hlsToBlobUrl": {
      const file = await downloadHls(request.url)
      const blob = new Blob(file.parts, { type: file.mime })
      const blobUrl = URL.createObjectURL(blob)
      blobs.set(blobUrl, blob)
      return { success: true, blobUrl, ext: file.ext, mime: file.mime, size: blob.size }
    }
    case "uploadBlob": {
      const blob = blobs.get(request.blobUrl)
      if (!blob) throw new Error("Video data is no longer available.")
      const resp = await fetch(request.uploadUrl, {
        method: "PUT",
        headers: request.headers,
        body: blob
      })
      if (!resp.ok) throw new Error(`Video upload failed: ${resp.status}`)
      return { success: true }
    }
    case "revokeBlobUrl":
      URL.revokeObjectURL(request.blobUrl)
      blobs.delete(request.blobUrl)
      return { success: true }
    default:
      return { success: false, message: `Unknown offscreen action: ${request.action}` }
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.target !== "offscreen") return
  handle(request).then(sendResponse, (error) =>
    sendResponse({
      success: false,
      message: error instanceof Error ? error.message : String(error)
    })
  )
  return true
})

export default function Offscreen() {
  return null
}
