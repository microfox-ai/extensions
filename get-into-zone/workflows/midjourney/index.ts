import { config } from "../../config"

export function startMidjourneyWorkflow(
  prompt: string,
  useLastImage: boolean = false
) {
  chrome.tabs.query({ url: config.midjourneyUrl }, (tabs) => {
    if (tabs.length > 0) {
      const tabId = tabs[0].id
      chrome.tabs.update(tabId, { active: true }, () => {
        executeWorkflow(tabId, prompt, useLastImage)
      })
    } else {
      chrome.tabs.create({ url: config.midjourneyUrl }, (tab) => {
        // Wait for the tab to be completely loaded before executing the script
        const listener = (tabId, changeInfo, updatedTab) => {
          if (tabId === tab.id && changeInfo.status === "complete") {
            executeWorkflow(tab.id, prompt, useLastImage)
            chrome.tabs.onUpdated.removeListener(listener) // Clean up the listener
          }
        }
        chrome.tabs.onUpdated.addListener(listener)
      })
    }
  })
}

function executeWorkflow(
  tabId: number,
  prompt: string,
  useLastImage: boolean = false
) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: (prompt, useLastImage) => {
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
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype,
            "value"
          ).set
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
    args: [prompt, useLastImage]
  })
}

function scraper() {
  const results = []
  const jobContainers = document.querySelectorAll(
    'div[class*="grid-cols-[minmax(0,8fr)_minmax(0,3fr)]"]'
  )

  jobContainers.forEach((container) => {
    const promptEl = container.querySelector(
      'div[class*="group/promptText"] span.relative'
    )
    const prompt = promptEl ? (promptEl as HTMLElement).innerText : null

    if (prompt) {
      const imageUrls = []
      const images = container.querySelectorAll(
        'div[class*="group/mediaGrid"] img'
      )
      images.forEach((img: HTMLImageElement) => {
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
  chrome.tabs.query({ url: config.midjourneyUrl }, (tabs) => {
    if (tabs.length > 0) {
      const tabId = tabs[0].id
      chrome.scripting.executeScript(
        {
          target: { tabId: tabId },
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
