import {
  getMidjourneyQueueSize,
  scrapeMidjourney,
  startMidjourneyWorkflow
} from "./workflows/midjourney"
import { startSunoWorkflow } from "./workflows/suno"
import { initSaverBackground } from "./lib/saverBackground"
import { initPinterestBulkBackground } from "./lib/pinterestBulkBackground"
import { initYouTubeBackground } from "./lib/youtubeBackground"
import { initPinterestVideoDownloads } from "./lib/pinterestVideoDownload"
import { initInstagramBackground } from "./lib/instagramBackground"
import { normalizeTags, queueSparkboardIndex } from "./lib/mediamake"
import { initMidjourneyEdit } from "./lib/midjourneyEdit"
import { initMcpBridge } from "./lib/mcpBridge"

initSaverBackground()
initPinterestBulkBackground()
initYouTubeBackground()
initPinterestVideoDownloads()
initInstagramBackground()

const QUEUE_REQUEST_RATE_LIMIT_MS = 3000

const updateQueueItemStatus = (
  queueItemId: string,
  payload: Record<string, unknown>,
  onSuccess?: () => void
) => {
  if (!queueItemId) return
  chrome.storage.local.get(
    ["apiEndpoint", "apiKey"],
    (result) => {
      const baseUrl =
        (typeof result.apiEndpoint === "string" && result.apiEndpoint) ||
        ""
    if (!baseUrl || typeof baseUrl !== "string") {
      console.warn(
        "[get-into-zone] Missing apiEndpoint in storage; cannot PATCH queue item",
        { queueItemId, payload }
      )
      return
    }
    const headers: HeadersInit = {
      "Content-Type": "application/json"
    }
    if (result.apiKey && typeof result.apiKey === "string") {
      headers["Authorization"] = `Bearer ${result.apiKey}`
    }
    const url = `${baseUrl}/api/midjourney-queue/${encodeURIComponent(queueItemId)}`
    console.log("[get-into-zone] PATCH midjourney queue item", {
      url,
      payload
    })
    fetch(url, {
      method: "PATCH",
      headers,
      body: JSON.stringify(payload)
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => "")
          console.error(
            "[get-into-zone] midjourney queue PATCH failed",
            res.status,
            text
          )
          return
        }

        // Notify popup to refresh the queue list
        chrome.runtime.sendMessage({ action: "midjourneyQueueUpdated" })
        onSuccess?.()
      })
      .catch((err) => {
        console.error("Failed to update midjourney queue item:", err)
      })
  })
}

const queueTriggerWaiters = new Map<string, () => void>()

const waitForQueueItemTriggered = (queueItemId: string) =>
  new Promise<void>((resolve) => {
    console.log("[get-into-zone][queue] waiting for triggered status", {
      queueItemId
    })
    queueTriggerWaiters.set(queueItemId, resolve)
  })

const resolveQueueItemTriggered = (queueItemId: string) => {
  const resolve = queueTriggerWaiters.get(queueItemId)
  if (!resolve) return
  queueTriggerWaiters.delete(queueItemId)
  console.log("[get-into-zone][queue] triggered wait resolved", {
    queueItemId
  })
  resolve()
}

const handleMessage = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) => {
  if (request.action === "startWorkflow") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {
        startMidjourneyWorkflow(
          request.prompt,
          request.useLastImage || false,
          request.folderTag || ""
        )
        sendResponse({ status: "Midjourney workflow started" })
      }
    })
  } else if (request.action === "startSunoWorkflow") {
    chrome.tabs.query({ url: "https://suno.com/*" }, function (tabs) {
      if (tabs.length > 0) {
        startSunoWorkflow()
        sendResponse({ status: "Suno workflow started" })
      }
    })
  } else if (request.action === "uploadSunoTrackToMediamake") {
    chrome.storage.local.get(
      ["apiEndpoint", "apiKey", "selectedProjectId"],
      async (result) => {
        const baseUrl =
          (typeof result.apiEndpoint === "string" && result.apiEndpoint) || ""
        if (!baseUrl || typeof baseUrl !== "string") {
          sendResponse({
            success: false,
            message: "Missing API Endpoint in Settings."
          })
          return
        }

        let audioUrl: string | null =
          typeof request.audioUrl === "string" && request.audioUrl
            ? request.audioUrl
            : null
        let title: string | null =
          typeof request.title === "string" && request.title.trim().length > 0
            ? request.title.trim()
            : null
        let sunoLyrics: string | null =
          typeof request.sunoLyrics === "string" &&
          request.sunoLyrics.trim().length > 0
            ? request.sunoLyrics.trim()
            : null

        if (!audioUrl || !title || !sunoLyrics) {
          const [tab] = await chrome.tabs.query({ url: "https://suno.com/*" })
          if (tab?.id) {
            try {
              const [{ result: scrapeResult }]: any =
                await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: () => {
                    const playbarTitleAnchor = document.querySelector(
                      'a[aria-label^="Playbar: Title for "]'
                    ) as HTMLAnchorElement | null
                    const fallbackSongAnchor = document.querySelector(
                      'a[href*="/song/"]'
                    ) as HTMLAnchorElement | null
                    const href =
                      playbarTitleAnchor?.getAttribute("href") ||
                      fallbackSongAnchor?.getAttribute("href") ||
                      ""
                    const lastSegment = href.split("/").filter(Boolean).pop() || ""
                    const songId = lastSegment.split("?")[0]?.trim() || null
                    const url = songId ? `https://cdn1.suno.ai/${songId}.m4a` : null
                    const audioEl = document.querySelector("audio") as
                      | HTMLAudioElement
                      | null
                    const titleFromPlaybarText =
                      playbarTitleAnchor?.textContent?.trim() || ""
                    const titleFromPlaybarLabel = (
                      playbarTitleAnchor?.getAttribute("aria-label") || ""
                    )
                      .replace(/^Playbar:\s*Title for\s*/i, "")
                      .trim()
                    const titleFromSongAnchor =
                      fallbackSongAnchor?.textContent?.trim() || ""
                    const finalTitle =
                      titleFromPlaybarText ||
                      titleFromPlaybarLabel ||
                      titleFromSongAnchor ||
                      null
                    const copyLyricsButton = document.querySelector(
                      'button[aria-label="Copy lyrics to clipboard"]'
                    ) as HTMLButtonElement | null
                    const lyricsDisplayContainer = copyLyricsButton?.closest(
                      "div.css-x4if1z"
                    )
                    const lyricsDisplayText = (
                      (lyricsDisplayContainer?.querySelector(
                        ".pr-6"
                      ) as HTMLElement | null)?.innerText || ""
                    ).trim()
                    const lyricsTextarea = document.querySelector(
                      '[data-testid="lyrics-textarea"]'
                    ) as HTMLTextAreaElement | null
                    const lyricsFromTextarea = (
                      lyricsDisplayText ||
                      lyricsTextarea?.value ||
                      lyricsTextarea?.textContent ||
                      ""
                    ).trim()
                    const lyricsFromInnerText = (
                      (document.querySelector(
                        '[data-testid="lyrics-textarea"]'
                      ) as HTMLElement | null)?.innerText || ""
                    ).trim()
                    const lyrics =
                      lyricsFromTextarea.length > 0
                        ? lyricsFromTextarea
                        : lyricsFromInnerText

                    return {
                      audioUrl: url || audioEl?.src || null,
                      title: finalTitle,
                      sunoLyrics: lyrics || null
                    }
                  }
                })
              audioUrl = audioUrl || scrapeResult?.audioUrl || null
              title = title || scrapeResult?.title || null
              sunoLyrics = sunoLyrics || scrapeResult?.sunoLyrics || null
            } catch {
              // Keep whatever values we already had from the request payload.
            }
          }
        }

        if (!audioUrl) {
          sendResponse({
            success: false,
            message: "Could not find track audio. Open a track in the sidebar first."
          })
          return
        }

        const headers: HeadersInit = {
          "Content-Type": "application/json"
        }
        if (result.apiKey && typeof result.apiKey === "string") {
          headers["Authorization"] = `Bearer ${result.apiKey}`
        }

        const projectId =
          typeof result.selectedProjectId === "string" &&
          result.selectedProjectId.trim() !== ""
            ? result.selectedProjectId.trim()
            : typeof request.projectId === "string" &&
              request.projectId.trim() !== ""
            ? request.projectId.trim()
            : undefined
        const tags = Array.isArray(request.tags)
          ? request.tags
              .map((entry: unknown) =>
                typeof entry === "string" ? entry.trim() : ""
              )
              .filter((entry: string) => entry.length > 0)
          : typeof request.tags === "string"
          ? request.tags
              .split(",")
              .map((entry: string) => entry.trim())
              .filter((entry: string) => entry.length > 0)
          : typeof request.tag === "string"
          ? request.tag
              .split(",")
              .map((entry: string) => entry.trim())
              .filter((entry: string) => entry.length > 0)
          : []

        const uploadUrl = `${baseUrl.replace(/\/+$/, "")}/api/workflows/workers/transcriber`

        try {
          const resp = await fetch(uploadUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              input: {
                audioUrl,
                language: request.language || "en",
                tags: tags.length > 0 ? tags : undefined,
                title: title || undefined,
                sunoLyrics: sunoLyrics || undefined,
                projectId
              },
              await: false
            })
          })

          if (!resp.ok) {
            const text = await resp.text().catch(() => "")
            console.error(
              "[get-into-zone] Suno upload worker failed",
              resp.status,
              text
            )
            sendResponse({
              success: false,
              message: `Worker call failed: ${resp.status}`
            })
            return
          }

          const data = await resp.json().catch(() => ({}))
          sendResponse({
            success: resp.ok,
            message:
              data?.message || (resp.ok ? "Worker queued for transcription." : "Failed to queue worker.")
          })
        } catch (err) {
          console.error("[get-into-zone] Failed to upload Suno track:", err)
          sendResponse({
            success: false,
            message: err instanceof Error ? err.message : "Unexpected error while triggering worker."
          })
        }
      }
    )
    return true
  } else if (
    request.action === "analyzeImageWithApi" ||
    request.action === "analyzePinterestImage"
  ) {
    chrome.storage.local.get(
      ["apiEndpoint", "apiKey", "selectedProjectId", "tags"],
      async (result) => {
        const baseUrl =
          (typeof result.apiEndpoint === "string" && result.apiEndpoint) || ""
        if (!baseUrl || typeof baseUrl !== "string") {
          sendResponse({
            success: false,
            message: "Missing API Endpoint in Settings."
          })
          return
        }

        const headers: HeadersInit = {
          "Content-Type": "application/json"
        }
        if (result.apiKey && typeof result.apiKey === "string") {
          headers["Authorization"] = `Bearer ${result.apiKey}`
        }
        const projectId =
          typeof result.selectedProjectId === "string" &&
          result.selectedProjectId.trim().length > 0
            ? result.selectedProjectId.trim()
            : undefined

        const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/media/analyze-image`
        const payload = {
          imageUrl: request.imageUrl,
          pageUrl: request.pageUrl,
          imageAlt: request.imageAlt,
          prompt: request.prompt,
          ...(projectId ? { projectId } : {}),
          tags: normalizeTags(request.tags || result.tags),
        }

        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload)
          })
          const data = await resp.json().catch(() => ({}))
          if (!resp.ok) {
            sendResponse({
              success: false,
              message: data?.error || `Analyze request failed: ${resp.status}`
            })
            return
          }
          sendResponse({
            success: true,
            data
          })
        } catch (error) {
          sendResponse({
            success: false,
            message:
              error instanceof Error
                ? error.message
                : "Unexpected error while analyzing image."
          })
        }
      }
    )
    return true
  } else if (request.action === "savePinterestAnalysis") {
    chrome.storage.local.get(
      ["apiEndpoint", "apiKey", "selectedProjectId"],
      async (result) => {
        const baseUrl =
          (typeof result.apiEndpoint === "string" && result.apiEndpoint) || ""
        if (!baseUrl) {
          sendResponse({ success: false, message: "Missing API Endpoint in Settings." })
          return
        }
        const headers: HeadersInit = { "Content-Type": "application/json" }
        if (result.apiKey && typeof result.apiKey === "string") {
          headers["Authorization"] = `Bearer ${result.apiKey}`
        }
        const projectId =
          typeof result.selectedProjectId === "string" &&
          result.selectedProjectId.trim().length > 0
            ? result.selectedProjectId.trim()
            : undefined

        const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/pinterest-analyses`
        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({
              imageUrl: request.imageUrl,
              pageUrl: request.pageUrl,
              imageAlt: request.imageAlt || "",
              description: request.description,
              keywords: request.keywords || [],
              artStyle: request.artStyle || [],
              audienceKeywords: request.audienceKeywords || [],
              ...(projectId ? { projectId } : {})
            })
          })
          const data = await resp.json().catch(() => ({}))
          if (!resp.ok) {
            sendResponse({ success: false, message: data?.error || `Save failed: ${resp.status}` })
            return
          }
          sendResponse({ success: true, data })
        } catch (error) {
          sendResponse({
            success: false,
            message: error instanceof Error ? error.message : "Failed to save analysis."
          })
        }
      }
    )
    return true
  } else if (request.action === "fetchPinterestAnalyses") {
    chrome.storage.local.get(
      ["apiEndpoint", "apiKey"],
      async (result) => {
        const baseUrl =
          (typeof result.apiEndpoint === "string" && result.apiEndpoint) || ""
        if (!baseUrl) {
          sendResponse({ success: false, message: "Missing API Endpoint in Settings." })
          return
        }
        const headers: HeadersInit = {}
        if (result.apiKey && typeof result.apiKey === "string") {
          headers["Authorization"] = `Bearer ${result.apiKey}`
        }
        const limit = typeof request.limit === "number" ? request.limit : 50
        const offset = typeof request.offset === "number" ? request.offset : 0
        const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/pinterest-analyses?limit=${limit}&offset=${offset}`
        try {
          const resp = await fetch(endpoint, { headers })
          const data = await resp.json().catch(() => ({}))
          if (!resp.ok) {
            sendResponse({ success: false, message: data?.error || `Fetch failed: ${resp.status}` })
            return
          }
          sendResponse({ success: true, data })
        } catch (error) {
          sendResponse({
            success: false,
            message: error instanceof Error ? error.message : "Failed to fetch analyses."
          })
        }
      }
    )
    return true
  } else if (request.action === "queueSparkboardIndex") {
    queueSparkboardIndex(request).then(sendResponse)
    return true
  } else if (request.action === "scrapeMidjourney") {
    chrome.tabs.query(
      { url: "https://www.midjourney.com/imagine*" },
      function (tabs) {
        if (tabs.length > 0) {
          scrapeMidjourney((results) => {
            sendResponse({ status: "completed", data: results })
          })
        }
      }
    )
  } else if (request.action === "startMidjourneyJsonWorkflow") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {
        const { prompts, delay, folderTag, maxQueueSize, promptSuffix } =
          request
        const threshold =
          typeof maxQueueSize === "number" && maxQueueSize > 0
            ? maxQueueSize
            : 8
        let currentIndex = 0

        const markPromptProcessed = (recordId: string, promptIndex: number) => {
          if (!recordId || promptIndex < 0) return
          chrome.storage.local.get(["apiEndpoint"], (result) => {
            const baseUrl = result.apiEndpoint
            if (!baseUrl || typeof baseUrl !== "string") {
              return
            }
            fetch(
              `${baseUrl}/api/midjourney-prompts/${encodeURIComponent(
                recordId
              )}/mark-processed`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({ promptIndex })
              }
            ).catch((err) => {
              console.error("Failed to mark prompt as processed:", err)
            })
          })
        }

        const processNextPrompt = () => {
          if (currentIndex < prompts.length) {
            const item = prompts[currentIndex]
            const promptText = typeof item === "string" ? item : item?.prompt

            if (promptText) {
              const fullPrompt =
                typeof promptSuffix === "string" &&
                promptSuffix.trim().length > 0
                  ? `${promptText} ${promptSuffix.trim()}`
                  : promptText

              // First, check the Midjourney queue size in the current tab
              getMidjourneyQueueSize((queueSize) => {
                // If queue is at or above the threshold, do NOT advance the index.
                // Just wait for the delay and try the same prompt again.
                if (queueSize !== null && queueSize >= threshold) {
                  setTimeout(processNextPrompt, delay)
                  return
                }

                // Queue is acceptable (or cannot be read) — proceed with this prompt.
                // Allow per-prompt folder tag, falling back to the global folderTag.
                let effectiveFolderTag = ""
                if (
                  typeof item === "object" &&
                  item !== null &&
                  typeof item.tag === "string"
                ) {
                  effectiveFolderTag = item.tag.trim()
                }
                if (!effectiveFolderTag && typeof folderTag === "string") {
                  effectiveFolderTag = folderTag.trim()
                }

                const recordId =
                  typeof item === "object" &&
                  item !== null &&
                  typeof item.recordId === "string"
                    ? item.recordId
                    : null
                const pIndex =
                  typeof item === "object" &&
                  item !== null &&
                  typeof item.pIndex === "number"
                    ? item.pIndex
                    : null

                startMidjourneyWorkflow(
                  fullPrompt,
                  request.useLastImage || false,
                  effectiveFolderTag || ""
                )

                if (recordId && pIndex !== null) {
                  markPromptProcessed(recordId, pIndex)
                }

                currentIndex++
                if (currentIndex < prompts.length) {
                  setTimeout(processNextPrompt, delay)
                }
              })
            }
          }
        }

        processNextPrompt()
        sendResponse({ status: "Midjourney JSON workflow started" })
      }
    })
  } else if (request.action === "startMidjourneyQueueBatch") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length === 0) {
        sendResponse({ status: "No active tab" })
        return
      }
      const { requests, delay, folderTag, overwriteQueueFolder, maxQueueSize } = request
      if (!Array.isArray(requests) || requests.length === 0) {
        sendResponse({ status: "No requests to process" })
        return
      }
      const threshold =
        typeof maxQueueSize === "number" && maxQueueSize > 0 ? maxQueueSize : 8
      const delayMs =
        typeof delay === "number" && delay > 0 ? delay : 15000
      let currentIndex = 0

      const processNext = () => {
        if (currentIndex >= requests.length) {
          return
        }
        const item = requests[currentIndex]
        const promptText =
          typeof item === "string"
            ? item
            : typeof item?.prompt === "string"
            ? item.prompt
            : ""

        if (!promptText) {
          currentIndex++
          if (currentIndex < requests.length) {
            setTimeout(processNext, delayMs)
          }
          return
        }

        getMidjourneyQueueSize((queueSize) => {
          if (queueSize !== null && queueSize >= threshold) {
            setTimeout(processNext, delayMs)
            return
          }

          let effectiveFolderTag = ""
          const hasQueueFolderInput =
            typeof folderTag === "string" && folderTag.trim().length > 0
          const shouldOverridePerItemFolder = Boolean(overwriteQueueFolder)

          if (shouldOverridePerItemFolder && hasQueueFolderInput) {
            effectiveFolderTag = folderTag.trim()
          } else if (
            typeof item?.folder === "string" &&
            item.folder.trim().length > 0
          ) {
            effectiveFolderTag = item.folder.trim()
          } else if (hasQueueFolderInput) {
            // Fallback folder when queue item does not have a saved folder.
            effectiveFolderTag = folderTag.trim()
          }

          try {
            const queueItemId =
              item && typeof item.id === "string" ? item.id : undefined
            const waitForTriggered = queueItemId
              ? waitForQueueItemTriggered(queueItemId)
              : null
            if (queueItemId) {
              console.log("[get-into-zone][queue] starting workflow for queue item", {
                queueItemId,
                effectiveFolderTag,
                promptPreview: String(promptText).slice(0, 120)
              })
            }

            startMidjourneyWorkflow(
              promptText,
              request.useLastImage || false,
              effectiveFolderTag || "",
              queueItemId
            )

            if (waitForTriggered) {
              waitForTriggered.then(() => {
                currentIndex++
                if (currentIndex < requests.length) {
                  setTimeout(processNext, QUEUE_REQUEST_RATE_LIMIT_MS)
                }
              })
              return
            }
          } catch (err: any) {
            console.error(
              "Failed to start Midjourney workflow for queued item:",
              err
            )
            if (item && typeof item.id === "string") {
              updateQueueItemStatus(item.id, {
                status: "failed",
                errorMessage:
                  (err && err.message) ||
                  "Failed to start Midjourney workflow"
              })
              resolveQueueItemTriggered(item.id)
            }
          }

          currentIndex++
          if (currentIndex < requests.length) {
            setTimeout(
              processNext,
              Math.max(delayMs, QUEUE_REQUEST_RATE_LIMIT_MS)
            )
          }
        })
      }

      processNext()
      sendResponse({ status: "Midjourney queue batch started" })
    })
    return true
  } else if (request.action === "sendApiRequest") {
    fetch(request.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.apiKey}`
      },
      body: JSON.stringify(request.payload)
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Network response was not ok " + response.statusText)
        }
        return response.json()
      })
      .then((data) => {
        sendResponse({ success: true, data })
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message })
      })
    return true // Indicates that the response is sent asynchronously
  } else if (request.action === "midjourneyJobSubmitted") {
    const { queueItemId, jobId, folderTag } = request
    console.log(
      "[get-into-zone] midjourneyJobSubmitted in background",
      request
    )
    if (typeof queueItemId === "string" && typeof jobId === "string") {
      updateQueueItemStatus(queueItemId, {
        status: "triggered",
        jobId,
        folder: typeof folderTag === "string" ? folderTag : null,
        triggeredAt: new Date().toISOString()
      }, () => {
        resolveQueueItemTriggered(queueItemId)
      })
    }
  }
}

chrome.runtime.onMessage.addListener(handleMessage)
initMcpBridge(handleMessage)
initMidjourneyEdit()
