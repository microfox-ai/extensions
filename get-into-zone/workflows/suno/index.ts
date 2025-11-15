import { config } from "../../config"
import { scrapeSunoMusic } from "./scraper"

export function startSunoWorkflow() {
  chrome.tabs.query({ url: config.sunoUrl }, (tabs) => {
    if (tabs.length > 0) {
      const tabId = tabs[0].id
      chrome.tabs.update(tabId, { active: true }, () => {
        executeSunoScript(tabId)
      })
    } else {
      chrome.tabs.create({ url: config.sunoUrl }, (tab) => {
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === "complete") {
            setTimeout(() => {
              executeSunoScript(tab.id)
              chrome.tabs.onUpdated.removeListener(listener)
            }, 2000)
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
      })
    }
  })
}

async function executeSunoScript(tabId: number) {
  let allResults = []
  let previousHeight = 0
  let scrollCount = 0
  const maxScrolls = 50 // Prevent infinite loops

  while (scrollCount < maxScrolls) {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: scrapeSunoMusic
    })

    if (results && results[0] && results[0].result) {
      const newItems = results[0].result.filter(
        (newItem) =>
          !allResults.some(
            (existingItem) =>
              existingItem.title === newItem.title &&
              existingItem.audioUrl === newItem.audioUrl
          )
      )

      if (newItems.length > 0) {
        allResults = allResults.concat(newItems)
      }
    }

    // Scroll down
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const scrollable =
          document.querySelector(
            ".clip-browser-list-scroller.css-11nl96j.e1ereieb2"
          ) || document.body
        scrollable.scrollTo(0, scrollable.scrollHeight)
      }
    })

    // Wait for new content to load
    await new Promise((resolve) => setTimeout(resolve, 4000))

    const newHeightResult = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const scrollable =
          document.querySelector(
            ".clip-browser-list-scroller.css-11nl96j.e1ereieb2"
          ) || document.body
        return scrollable.scrollHeight
      }
    })

    const newHeight = newHeightResult[0].result
    if (newHeight === previousHeight) {
      // If the height hasn't changed, scrape one last time and then exit
      const finalResults = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: scrapeSunoMusic
      })
      if (finalResults && finalResults[0] && finalResults[0].result) {
        const finalNewItems = finalResults[0].result.filter(
          (newItem) =>
            !allResults.some(
              (existingItem) =>
                existingItem.title === newItem.title &&
                existingItem.audioUrl === newItem.audioUrl
            )
        )
        if (finalNewItems.length > 0) {
          allResults = allResults.concat(finalNewItems)
        }
      }
      break
    }
    previousHeight = newHeight
    scrollCount++
  }

  chrome.runtime.sendMessage({
    action: "sunoDataExtracted",
    data: allResults
  })
}
