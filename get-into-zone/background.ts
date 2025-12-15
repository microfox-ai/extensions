import {
  getMidjourneyQueueSize,
  scrapeMidjourney,
  startMidjourneyWorkflow
} from "./workflows/midjourney"
import { startSunoWorkflow } from "./workflows/suno"

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
  }
})
