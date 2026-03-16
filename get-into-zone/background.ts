import {
  getMidjourneyQueueSize,
  scrapeMidjourney,
  startMidjourneyWorkflow
} from "./workflows/midjourney"
import { startSunoWorkflow } from "./workflows/suno"

const updateQueueItemStatus = (
  queueItemId: string,
  payload: Record<string, unknown>
) => {
  if (!queueItemId) return
  chrome.storage.local.get(
    ["agentApiUrl", "apiEndpoint", "apiKey"],
    (result) => {
      // Prefer agentApiUrl (used by Midjourney/Agents tabs), but fall back to
      // apiEndpoint from Settings if agentApiUrl hasn't been set explicitly.
      const baseUrl =
        (typeof result.agentApiUrl === "string" && result.agentApiUrl) ||
        (typeof result.apiEndpoint === "string" && result.apiEndpoint) ||
        ""
    if (!baseUrl || typeof baseUrl !== "string") {
      console.warn(
        "[get-into-zone] Missing agentApiUrl in storage; cannot PATCH queue item",
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
      })
      .catch((err) => {
        console.error("Failed to update midjourney queue item:", err)
      })
  })
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
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

        if (!audioUrl) {
          const [tab] = await chrome.tabs.query({ url: "https://suno.com/*" })
          if (tab?.id) {
            try {
              const [{ result: scrapeResult }]: any =
                await chrome.scripting.executeScript({
                  target: { tabId: tab.id },
                  func: () => {
                    const buttons = Array.from(
                      document.querySelectorAll("button")
                    ) as HTMLButtonElement[]
                    const remixButton = buttons.find((btn) =>
                      btn.textContent?.trim().toLowerCase().includes("remix/edit")
                    )
                    if (!remixButton) return null
                    const wrapperDiv = remixButton.closest("div.relative") as HTMLElement | null
                    if (!wrapperDiv) return null
                    const prev = wrapperDiv.previousElementSibling
                    const prevText = (prev?.textContent?.trim() ?? "").toLowerCase()
                    const isNextToAddCaption =
                      prev != null && prevText.includes("add a caption")
                    const isFullWidthPill =
                      remixButton.classList.contains("w-full") ||
                      /\bpy-\[13px\]\b/.test(remixButton.className) ||
                      /\brounded-\[16px\]\b/.test(remixButton.className)
                    if (!isNextToAddCaption && !isFullWidthPill) return null
                    let current: HTMLElement | null = wrapperDiv
                    let songLink: HTMLAnchorElement | null = null
                    while (current && current !== document.body) {
                      const candidate = current.querySelector('a[href*="/song/"]') as HTMLAnchorElement | null
                      if (candidate) {
                        songLink = candidate
                        break
                      }
                      current = current.parentElement
                    }
                    const href = songLink?.getAttribute("href") || ""
                    const lastSegment = href.split("/").filter(Boolean).pop() || ""
                    const songId = lastSegment.split("?")[0]?.trim() || null
                    const url = songId ? `https://cdn1.suno.ai/${songId}.m4a` : null
                    const audioEl = (wrapperDiv.closest("aside") || wrapperDiv.closest("div"))?.querySelector("audio") as HTMLAudioElement | null
                    return { audioUrl: url || audioEl?.src || null }
                  }
                })
              audioUrl = scrapeResult?.audioUrl || null
            } catch {
              audioUrl = null
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
          typeof result.selectedProjectId === "string"
            ? result.selectedProjectId
            : undefined

        const uploadUrl = `${baseUrl.replace(/\/+$/, "")}/api/workflows/workers/transcriber`

        try {
          const resp = await fetch(uploadUrl, {
            method: "POST",
            headers,
            body: JSON.stringify({
              input: {
                audioUrl,
                language: request.language || "en",
                tag: request.tag,
                projectId,
                clientId: "default"
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
          chrome.storage.local.get(["agentApiUrl"], (result) => {
            const baseUrl = result.agentApiUrl
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
      const { requests, delay, folderTag, maxQueueSize } = request
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
          if (typeof folderTag === "string" && folderTag.trim().length > 0) {
            effectiveFolderTag = folderTag.trim()
          }

          try {
            startMidjourneyWorkflow(
              promptText,
              request.useLastImage || false,
              effectiveFolderTag || "",
              item && typeof item.id === "string" ? item.id : undefined
            )
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
            }
          }

          currentIndex++
          if (currentIndex < requests.length) {
            setTimeout(processNext, delayMs)
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
      })
    }
  }
})
