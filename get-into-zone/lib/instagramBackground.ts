// Looks up Instagram posts for the popup and the MCP bridge, and saves files
// for them and the on-page Download buttons.
import {
  isInstagramHost,
  lookupInstagramMedia,
  mediaIdFor,
  parseInstagramUrl,
  type IgDownload,
  type IgPost
} from "./instagram"
import { openTab } from "./tabs"

const CDN_RE = /^https:\/\/[\w.-]+\.(?:cdninstagram\.com|fbcdn\.net)\//i

const isInstagramTab = (tab?: chrome.tabs.Tab) => {
  try {
    return !!tab?.url && isInstagramHost(new URL(tab.url).hostname)
  } catch {
    return false
  }
}

// The lookup needs the session cookie, so it runs in an instagram.com tab: the
// requested one when it is on Instagram, otherwise any open Instagram tab, or
// (for the MCP bridge) a new one opened in the background.
async function pageTabFor(tabId?: number, openIfMissing = false) {
  const requested =
    tabId !== undefined
      ? await chrome.tabs.get(tabId).catch(() => undefined)
      : undefined
  if (isInstagramTab(requested)) return requested!
  const [other] = await chrome.tabs.query({
    url: ["https://www.instagram.com/*", "https://instagram.com/*"]
  })
  if (other) return other
  if (openIfMissing) return openTab("https://www.instagram.com/", false)
  throw new Error("Open instagram.com in a tab (logged in) first.")
}

export async function getInstagramPost(
  request: { url?: string; tabId?: number },
  openIfMissing = false
): Promise<IgPost> {
  const requested =
    request.tabId !== undefined ? Number(request.tabId) : undefined
  let url = typeof request.url === "string" ? request.url.trim() : ""
  if (!url && requested !== undefined)
    url = (await chrome.tabs.get(requested)).url || ""
  const target = parseInstagramUrl(url)
  if (!target)
    throw new Error("That isn't an Instagram post, reel or story link.")
  const mediaId = mediaIdFor(target)
  if (!mediaId) throw new Error("Couldn't read the post id from that link.")

  const tab = await pageTabFor(requested, openIfMissing)
  const [injected] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    func: lookupInstagramMedia,
    args: [mediaId]
  })
  const result = injected?.result
  if (!result?.post)
    throw new Error(result?.error || "Instagram didn't return that post.")
  return result.post
}

function waitForDownload(downloadId: number) {
  return new Promise<void>((resolve, reject) => {
    const settle = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state) return
      if (delta.state.current === "complete") {
        chrome.downloads.onChanged.removeListener(settle)
        resolve()
      } else if (delta.state.current === "interrupted") {
        chrome.downloads.onChanged.removeListener(settle)
        reject(
          new Error(`Download failed: ${delta.error?.current ?? "interrupted"}`)
        )
      }
    }
    chrome.downloads.onChanged.addListener(settle)
    // It may have finished before the listener was added.
    chrome.downloads.search({ id: downloadId }).then(([item]) => {
      if (item?.state === "complete")
        settle({ id: downloadId, state: { current: "complete" } })
      if (item?.state === "interrupted") {
        settle({
          id: downloadId,
          state: { current: "interrupted" },
          error: { current: item.error }
        })
      }
    })
  })
}

// Download ids come back in the order of `files`; callers rely on that.
export async function downloadInstagramFiles(files: IgDownload[]) {
  if (!files.length) throw new Error("Nothing to download.")
  const valid = (file: IgDownload) =>
    typeof file?.url === "string" &&
    CDN_RE.test(file.url) &&
    typeof file.filename === "string"
  if (!files.every(valid)) throw new Error("Only Instagram files can be saved.")
  const downloadIds = await Promise.all(
    files.map((file) =>
      chrome.downloads.download({
        url: file.url,
        filename: file.filename,
        conflictAction: "uniquify",
        saveAs: false
      })
    )
  )
  await Promise.all(downloadIds.map(waitForDownload))
  return downloadIds
}

export function initInstagramBackground() {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    const reply = (work: Promise<object>) => {
      work.then(
        (result) => sendResponse({ success: true, ...result }),
        (error) =>
          sendResponse({
            success: false,
            message: error instanceof Error ? error.message : String(error)
          })
      )
      return true
    }
    switch (request?.action) {
      case "instagramGetPost":
        return reply(getInstagramPost(request).then((post) => ({ post })))
      case "instagramDownload":
        return reply(
          downloadInstagramFiles(
            Array.isArray(request.files) ? request.files : []
          ).then((downloadIds) => ({
            downloadIds
          }))
        )
      case "instagramShow":
        chrome.downloads.show(Number(request.downloadId))
        sendResponse({ success: true })
        return
    }
  })
}
