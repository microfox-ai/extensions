import { config } from "../../config"

export function startMidjourneyWorkflow(
  prompt: string,
  useLastImage: boolean = false,
  folderTag: string = ""
) {
  const baseUrl = config.midjourneyUrl
  const normalizedTag = (folderTag || "").trim()

  const buildUrlForFolder = (tag: string) => {
    if (!tag) return baseUrl
    const params = new URLSearchParams({ folder: tag })
    return `${baseUrl}?${params.toString()}`
  }

  chrome.tabs.query({ url: `${baseUrl}*` }, (tabs) => {
    // If no folder tag: reuse existing /imagine tab if possible, or open a fresh one
    if (normalizedTag.length === 0) {
      if (tabs.length > 0) {
        const tab = tabs[0]
        if (!tab.id) return

        chrome.tabs.update(tab.id, { active: true }, () => {
          executeWorkflow(tab.id!, prompt, useLastImage, "")
        })
        return
      }

      chrome.tabs.create({ url: baseUrl }, (tab) => {
        const listener = (
          updatedTabId: number,
          changeInfo: chrome.tabs.TabChangeInfo
        ) => {
          if (updatedTabId === tab.id && changeInfo.status === "complete") {
            if (tab.id !== undefined) {
              executeWorkflow(tab.id, prompt, useLastImage, "")
            }
            chrome.tabs.onUpdated.removeListener(listener)
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
      })
      return
    }

    // We have a non-empty folder tag: first try to reuse a tab already on that folder
    let sameFolderTab: chrome.tabs.Tab | null = null
    let anyImagineTab: chrome.tabs.Tab | null = null
    for (const t of tabs) {
      if (!t.url || !t.id) continue
      try {
        const currentUrl = new URL(t.url)
        const currentFolder = currentUrl.searchParams.get("folder")
        if (
          currentFolder &&
          currentFolder.toLowerCase() === normalizedTag.toLowerCase()
        ) {
          sameFolderTab = t
          break
        }
        if (!anyImagineTab) {
          anyImagineTab = t
        }
      } catch {
        // ignore parse errors
      }
    }

    // Case 1: reuse tab already on the correct folder
    if (sameFolderTab && sameFolderTab.id) {
      chrome.tabs.update(sameFolderTab.id, { active: true }, () => {
        executeWorkflow(sameFolderTab.id!, prompt, useLastImage, normalizedTag)
      })
      return
    }

    const desiredUrl = buildUrlForFolder(normalizedTag)

    // Case 2: navigate an existing /imagine tab to the desired folder URL
    if (anyImagineTab && anyImagineTab.id) {
      chrome.tabs.update(
        anyImagineTab.id,
        { active: true, url: desiredUrl },
        () => {
          const listener = (
            updatedTabId: number,
            changeInfo: chrome.tabs.TabChangeInfo
          ) => {
            if (
              updatedTabId === anyImagineTab.id &&
              changeInfo.status === "complete"
            ) {
              if (anyImagineTab.id !== undefined) {
                executeWorkflow(
                  anyImagineTab.id,
                  prompt,
                  useLastImage,
                  normalizedTag
                )
              }
              chrome.tabs.onUpdated.removeListener(listener)
            }
          }
          chrome.tabs.onUpdated.addListener(listener)
        }
      )
      return
    }

    // Case 3: no /imagine tab at all, open a new one for this folder
    chrome.tabs.create({ url: desiredUrl }, (tab) => {
      const listener = (
        updatedTabId: number,
        changeInfo: chrome.tabs.TabChangeInfo
      ) => {
        if (updatedTabId === tab.id && changeInfo.status === "complete") {
          if (tab.id !== undefined) {
            executeWorkflow(tab.id, prompt, useLastImage, normalizedTag)
          }
          chrome.tabs.onUpdated.removeListener(listener)
        }
      }
      chrome.tabs.onUpdated.addListener(listener)
    })
  })
}

function executeWorkflow(
  tabId: number,
  prompt: string,
  useLastImage: boolean = false,
  folderTag: string = ""
) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (prompt, useLastImage, folderTag) => {
      // Function to click the Use button on the first container
      const clickUseButton = (): Promise<void> => {
        return new Promise((resolve) => {
          // Find all containers with the grid layout
          const containers = document.querySelectorAll(
            'div[class*="grid-cols-[minmax(0,8fr)_minmax(0,3fr)]"]'
          )

          if (containers.length === 0) {
            console.log("No generation containers found")
            resolve()
            return
          }

          // Get the first container (most recent generation)
          const firstContainer = containers[0] as HTMLElement

          // Find the group/mediaGrid element - this is what needs to be hovered
          const mediaGridGroup = firstContainer.querySelector(
            '[class*="group"][class*="mediaGrid"]'
          ) as HTMLElement

          if (!mediaGridGroup) {
            console.log("Media grid group not found")
            resolve()
            return
          }

          // Find the sticky bottom section that contains the buttons
          const stickySection = firstContainer.querySelector(
            "div.sticky.pointer-events-auto.mt-auto.bottom-0"
          ) as HTMLElement

          if (!stickySection) {
            console.log("Sticky section not found")
            resolve()
            return
          }

          // Find all buttons in the sticky section
          const allButtons = stickySection.querySelectorAll("button")

          // Find the Use button by looking for the button with a span containing "Use"
          const useButton = Array.from(allButtons).find((btn) => {
            const spans = btn.querySelectorAll("span")
            return Array.from(spans).some(
              (span) => span.textContent?.trim() === "Use"
            )
          }) as HTMLElement

          if (!useButton) {
            console.log("Use button not found")
            resolve()
            return
          }

          // Get the button's parent container (the one with hidden group-hover:flex)
          const buttonContainer = useButton.closest(
            "div.items-start"
          ) as HTMLElement

          // Trigger hover on the mediaGridGroup to make buttons visible
          // Use multiple methods to ensure hover is triggered
          const triggerHover = () => {
            // Method 1: Mouse events
            const mouseEnterEvent = new MouseEvent("mouseenter", {
              bubbles: true,
              cancelable: true,
              view: window
            })
            mediaGridGroup.dispatchEvent(mouseEnterEvent)

            const mouseOverEvent = new MouseEvent("mouseover", {
              bubbles: true,
              cancelable: true,
              view: window
            })
            mediaGridGroup.dispatchEvent(mouseOverEvent)

            // Method 2: Directly manipulate the class if possible
            // Some frameworks use class manipulation, so we'll try to force visibility
            if (buttonContainer) {
              // Try to remove hidden class and add flex class
              buttonContainer.classList.remove("hidden")
              buttonContainer.classList.add("flex")
            }
          }

          triggerHover()

          // Wait a bit for the button to become visible, then click it
          setTimeout(() => {
            try {
              // Scroll the button into view if needed
              useButton.scrollIntoView({ behavior: "smooth", block: "center" })

              setTimeout(() => {
                useButton.click()
                console.log("Use button clicked")
                // Wait a bit for the image to be loaded into the input
                setTimeout(() => resolve(), 1500)
              }, 300)
            } catch (error) {
              console.error("Error clicking Use button:", error)
              resolve()
            }
          }, 500)
        })
      }

      // Main workflow execution
      const runWorkflow = async () => {
        if (useLastImage) {
          try {
            await clickUseButton()
          } catch (error) {
            console.error("Error clicking Use button:", error)
          }
        }

        // Now proceed with typing the prompt
        const textarea = document.getElementById(
          "desktop_input_bar"
        ) as HTMLTextAreaElement

        if (textarea) {
          // Clear any existing content first
          const descriptor = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value"
          )
          const nativeInputValueSetter = descriptor?.set
          if (!nativeInputValueSetter) {
            console.error("Could not get native value setter for textarea")
            return
          }
          nativeInputValueSetter.call(textarea, "")

          // Wait a bit, then set the prompt
          setTimeout(
            () => {
              nativeInputValueSetter.call(textarea, prompt)

              const inputEvent = new Event("input", { bubbles: true })
              textarea.dispatchEvent(inputEvent)

              setTimeout(() => {
                textarea.dispatchEvent(
                  new KeyboardEvent("keydown", {
                    key: "Enter",
                    bubbles: true,
                    cancelable: true,
                    keyCode: 13
                  })
                )
                console.log("Workflow completed: prompt submitted.")
              }, 500)
            },
            useLastImage ? 500 : 0
          )
        } else {
          console.error(
            "Midjourney prompt textarea not found. Selector #desktop_input_bar did not work."
          )
        }
      }

      runWorkflow()
    },
    args: [prompt, useLastImage, folderTag]
  })
}

function scraper() {
  const results: { prompt: string; imageUrls: string[] }[] = []
  const jobContainers = document.querySelectorAll(
    'div[class*="grid-cols-[minmax(0,8fr)_minmax(0,3fr)]"]'
  )

  jobContainers.forEach((container) => {
    const promptEl = container.querySelector(
      'div[class*="group/promptText"] span.relative'
    )
    const prompt = promptEl ? (promptEl as HTMLElement).innerText : null

    if (prompt) {
      const imageUrls: string[] = []
      const images = container.querySelectorAll(
        'div[class*="group/mediaGrid"] img'
      ) as NodeListOf<HTMLImageElement>
      images.forEach((img) => {
        imageUrls.push(img.src)
      })

      if (imageUrls.length > 0) {
        results.push({
          prompt: prompt,
          imageUrls: imageUrls
        })
      }
    }
  })

  return results
}

export function scrapeMidjourney(callback: (results: any) => void) {
  chrome.tabs.query({ url: `${config.midjourneyUrl}*` }, (tabs) => {
    if (tabs.length > 0) {
      const tabId = tabs[0].id
      if (tabId === undefined) {
        console.error("Midjourney tab has undefined id")
        callback(null)
        return
      }
      chrome.scripting.executeScript(
        {
          target: { tabId },
          func: scraper
        },
        (injectionResults) => {
          if (chrome.runtime.lastError) {
            console.error(chrome.runtime.lastError.message)
            callback(null)
          } else if (injectionResults && injectionResults.length > 0) {
            callback(injectionResults[0].result)
          } else {
            callback(null)
          }
        }
      )
    } else {
      console.log("Midjourney tab not found.")
      callback(null)
    }
  })
}

function queueSizeInspector(): number | null {
  const divs = Array.from(document.querySelectorAll("div"))
  for (const div of divs) {
    const text = div.textContent?.trim()
    if (!text) continue

    const match = text.match(/^(\d+)\s+queued jobs$/i)
    if (match) {
      const count = parseInt(match[1], 10)
      if (!isNaN(count)) {
        return count
      }
    }
  }
  return null
}

export function getMidjourneyQueueSize(
  callback: (queueSize: number | null) => void
) {
  chrome.tabs.query({ url: `${config.midjourneyUrl}*` }, (tabs) => {
    if (tabs.length === 0) {
      callback(null)
      return
    }

    const tabId = tabs[0].id
    if (tabId === undefined) {
      callback(null)
      return
    }

    chrome.scripting.executeScript(
      {
        target: { tabId },
        func: queueSizeInspector
      },
      (injectionResults) => {
        if (chrome.runtime.lastError) {
          console.error(chrome.runtime.lastError.message)
          callback(null)
          return
        }

        if (injectionResults && injectionResults.length > 0) {
          callback(injectionResults[0].result as number | null)
        } else {
          callback(null)
        }
      }
    )
  })
}
