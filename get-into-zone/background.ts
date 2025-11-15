import {
  scrapeMidjourney,
  startMidjourneyWorkflow
} from "./workflows/midjourney"
import { startSunoWorkflow } from "./workflows/suno"

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "startWorkflow") {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs.length > 0) {
        startMidjourneyWorkflow(request.prompt, request.useLastImage || false)
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
        const { prompts, delay } = request
        let currentIndex = 0

        const processNextPrompt = () => {
          if (currentIndex < prompts.length) {
            const item = prompts[currentIndex]
            const promptText = typeof item === "string" ? item : item?.prompt

            if (promptText) {
              startMidjourneyWorkflow(promptText, request.useLastImage || false)
            }
            currentIndex++
            if (currentIndex < prompts.length) {
              setTimeout(processNextPrompt, delay)
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
