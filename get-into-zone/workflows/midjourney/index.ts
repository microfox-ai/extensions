import { config } from "../../config"

const SAME_FOLDER_SETTLE_MS = 1000
const FOLDER_SWITCH_SETTLE_MS = 2000

export function startMidjourneyWorkflow(
  prompt: string,
  useLastImage: boolean = false,
  folderTag: string = "",
  queueItemId?: string
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
          executeWorkflow(tab.id!, prompt, useLastImage, "", queueItemId)
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
              executeWorkflow(tab.id, prompt, useLastImage, "", queueItemId)
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
    const sameFolderTabId = sameFolderTab?.id
    if (sameFolderTabId !== undefined) {
      chrome.tabs.update(sameFolderTabId, { active: true }, () => {
        // Tab is already on the correct folder; tiny delay to let UI settle
        setTimeout(() => {
          executeWorkflow(
            sameFolderTabId,
            prompt,
            useLastImage,
            normalizedTag,
            queueItemId
          )
        }, SAME_FOLDER_SETTLE_MS)
      })
      return
    }

    const desiredUrl = buildUrlForFolder(normalizedTag)

    // Case 2: navigate an existing /imagine tab to the desired folder URL
    const anyImagineTabId = anyImagineTab?.id
    if (anyImagineTabId !== undefined) {
      chrome.tabs.update(
        anyImagineTabId,
        { active: true, url: desiredUrl },
        () => {
          const listener = (
            updatedTabId: number,
            changeInfo: chrome.tabs.TabChangeInfo
          ) => {
            if (
              updatedTabId === anyImagineTabId &&
              changeInfo.status === "complete"
            ) {
              // Wait a bit after navigation so the folder filter applies
              setTimeout(() => {
                executeWorkflow(
                  anyImagineTabId,
                  prompt,
                  useLastImage,
                  normalizedTag,
                  queueItemId
                )
              }, FOLDER_SWITCH_SETTLE_MS)
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
            // New tab: also wait a bit so the page finishes folder initialization
            setTimeout(() => {
              executeWorkflow(
                tab.id!,
                prompt,
                useLastImage,
                normalizedTag,
                queueItemId
              )
            }, FOLDER_SWITCH_SETTLE_MS)
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
  folderTag: string = "",
  queueItemId?: string
) {
  chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: "MAIN",
    func: (prompt, useLastImage, folderTag, queueItemId) => {
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

      const startDomWatcherForJobId = (
        originalPrompt: string,
        folderTagForWatcher: string,
        queueItemIdForWatcher: string | undefined
      ) => {
        if (!queueItemIdForWatcher || typeof queueItemIdForWatcher !== "string") {
          return
        }

        const startedAt = Date.now()
        // DOM can take a long time to move from "Starting..." to showing images.
        // Allow up to 10 minutes for the job card + image URLs to appear.
        const timeoutMs = 10 * 60 * 1000 // 10 minutes
        const pollIntervalMs = 5000 // 5 seconds

        let targetGrid: HTMLElement | null = null

        const normalizePrompt = (value: string | null | undefined): string => {
          return (value || "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim()
        }

        const checkOnce = () => {
          const now = Date.now()
          if (now - startedAt > timeoutMs) {
            return
          }

          // Step 1: if we don't have a target grid yet, find the job card
          // whose prompt matches the originalPrompt, then grab its mediaGrid.
          if (!targetGrid) {
            const containers = document.querySelectorAll<HTMLElement>(
              'div[class*="grid-cols-[minmax(0,8fr)_minmax(0,3fr)]"]'
            )

            const normalizedOriginal = normalizePrompt(originalPrompt)

            for (const container of Array.from(containers)) {
              let promptText = ""
              try {
                const promptEl =
                  container.querySelector<HTMLElement>(
                    'div[class*="group/promptText"] span.relative'
                  ) ||
                  container.querySelector<HTMLElement>(
                    'div.break-word div.min-w-0 > div'
                  ) ||
                  container.querySelector<HTMLElement>('div.break-word')

                if (promptEl && promptEl.textContent) {
                  promptText = promptEl.textContent
                }
              } catch {
                // ignore
              }

              const normalizedPromptText = normalizePrompt(promptText)
              if (
                normalizedOriginal &&
                normalizedPromptText &&
                (normalizedOriginal === normalizedPromptText ||
                  normalizedPromptText.includes(normalizedOriginal) ||
                  normalizedOriginal.includes(normalizedPromptText))
              ) {
                const grid = container.querySelector<HTMLElement>(
                  'div[class*="group/mediaGrid"]'
                )
                if (grid) {
                  targetGrid = grid
                  break
                }
              }
            }

            // If still none, wait for next poll
            setTimeout(checkOnce, pollIntervalMs)
            return
          }

          // Step 2: we have a target grid; ensure it is still in the DOM
          if (!document.contains(targetGrid)) {
            targetGrid = null
            setTimeout(checkOnce, pollIntervalMs)
            return
          }

          // Step 3: once the grid has job links or images, extract jobId
          let jobId: string | null = null

          const link = targetGrid.querySelector<HTMLAnchorElement>(
            'a[href*="/jobs/"]'
          )
          if (link && link.href) {
            try {
              const url = new URL(link.href)
              const parts = url.pathname.split("/").filter(Boolean)
              const jobsIndex = parts.indexOf("jobs")
              if (jobsIndex >= 0 && parts.length > jobsIndex + 1) {
                jobId = parts[jobsIndex + 1]
              }
            } catch {
              // ignore
            }
          }

          if (!jobId) {
            const img = targetGrid.querySelector<HTMLImageElement>("img")
            if (img && img.src) {
              try {
                const imgUrl = new URL(img.src)
                const segments = imgUrl.pathname.split("/").filter(Boolean)
                if (segments.length > 0) {
                  jobId = segments[0]
                }
              } catch {
                // ignore
              }
            }
          }

          if (jobId) {
            // Extra safety: verify that the prompt text shown for this grid
            // matches the originalPrompt we submitted. This prevents us from
            // accidentally associating a job_id from another request.
            let gridPromptText = ""
            try {
              // The grid sits inside a larger "job card" container. Walk up to it.
              const jobContainer =
                targetGrid.closest<HTMLElement>(
                  'div[class*="grid-cols-[minmax(0,8fr)_minmax(0,3fr)]"]'
                ) || targetGrid.closest<HTMLElement>('div.group')

              if (jobContainer) {
                // Try modern prompt container first (if present)
                const promptEl =
                  jobContainer.querySelector<HTMLElement>(
                    'div[class*="group/promptText"] span.relative'
                  ) ||
                  jobContainer.querySelector<HTMLElement>(
                    'div.break-word div.min-w-0 > div'
                  ) ||
                  jobContainer.querySelector<HTMLElement>('div.break-word')

                if (promptEl && promptEl.textContent) {
                  gridPromptText = promptEl.textContent
                }
              }
            } catch {
              // ignore DOM traversal issues; we'll fall back to not matching
            }

            const normalizedOriginal = normalizePrompt(originalPrompt)
            const normalizedGrid = normalizePrompt(gridPromptText)

            // Require a strong match between the submitted prompt and the
            // prompt rendered next to this grid. If it doesn't match, keep
            // polling instead of emitting a possibly wrong jobId.
            if (
              !normalizedOriginal ||
              !normalizedGrid ||
              (
                normalizedOriginal !== normalizedGrid &&
                !normalizedGrid.includes(normalizedOriginal) &&
                !normalizedOriginal.includes(normalizedGrid)
              )
            ) {
              setTimeout(checkOnce, pollIntervalMs)
              return
            }

            window.postMessage(
              {
                type: "MIDJOURNEY_SUBMIT_JOB_RESULT",
                jobId,
                prompt: originalPrompt,
                folderTag: folderTagForWatcher,
                queueItemId: queueItemIdForWatcher
              },
              "*"
            )
            return
          }

          // Schedule next poll
          setTimeout(checkOnce, pollIntervalMs)
        }

        setTimeout(checkOnce, 2000)
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
          try {
            const w = window as any
            const normalizePrompt = (value: string | null | undefined) =>
              String(value || "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase()
            if (!w.__mjPendingSubmitContexts) {
              w.__mjPendingSubmitContexts = []
            }

            const emitSubmitJobResult = (
              jobId: string | null,
              context?: {
                prompt?: string
                folderTag?: string
                queueItemId?: string | null
              },
              source: "fetch" | "xhr" = "fetch"
            ) => {
              if (!jobId || typeof jobId !== "string") return

              const queueItemIdForEvent =
                typeof context?.queueItemId === "string"
                  ? context.queueItemId
                  : null

              const key = `${jobId}::${String(queueItemIdForEvent || "")}`
              if (!w.__mjEmittedSubmitJobKeys) {
                w.__mjEmittedSubmitJobKeys = new Set<string>()
              }
              if (w.__mjEmittedSubmitJobKeys.has(key)) return
              w.__mjEmittedSubmitJobKeys.add(key)

              console.log("[get-into-zone][midjourney][network] emit job result", {
                source,
                jobId,
                queueItemId: queueItemIdForEvent,
                prompt: context?.prompt || null
              })

              window.postMessage(
                {
                  type: "MIDJOURNEY_SUBMIT_JOB_RESULT",
                  jobId,
                  prompt: context?.prompt || "",
                  folderTag: context?.folderTag || "",
                  queueItemId: queueItemIdForEvent
                },
                "*"
              )
            }

            if (!w.__mjNetworkSubmitHookInstalled) {
              w.__mjNetworkSubmitHookInstalled = true
              w.__mjOriginalFetch = window.fetch.bind(window)
              window.fetch = async (...args: [input: RequestInfo | URL, init?: RequestInit]) => {
                const url =
                  typeof args[0] === "string" || args[0] instanceof URL
                    ? args[0].toString()
                    : (args[0] as Request)?.url
                const isSubmitJobs =
                  typeof url === "string" &&
                  url.includes("/api/submit-jobs")
                let requestPrompt = ""
                if (isSubmitJobs) {
                  try {
                    const initBody = args[1]?.body
                    if (typeof initBody === "string") {
                      const bodyJson = JSON.parse(initBody)
                      requestPrompt =
                        typeof bodyJson?.prompt === "string"
                          ? bodyJson.prompt
                          : ""
                    } else if (args[0] instanceof Request) {
                      const requestClone = args[0].clone()
                      const textBody = await requestClone.text()
                      if (textBody) {
                        const bodyJson = JSON.parse(textBody)
                        requestPrompt =
                          typeof bodyJson?.prompt === "string"
                            ? bodyJson.prompt
                            : ""
                      }
                    }
                  } catch {
                    // ignore body parse errors
                  }
                }

                const originalFetch: typeof fetch = w.__mjOriginalFetch
                const response = await originalFetch(...args)

                if (isSubmitJobs) {
                  try {
                    const cloned = response.clone()
                    cloned
                      .json()
                      .then((data: any) => {
                        const jobId =
                          data?.success &&
                          Array.isArray(data.success) &&
                          data.success[0]?.job_id
                            ? data.success[0].job_id
                            : null

                        const requestPromptNormalized = normalizePrompt(requestPrompt)
                        const pending = (w.__mjPendingSubmitContexts || []).filter(
                          (ctx: any) => Date.now() - Number(ctx.createdAt || 0) < 180000
                        )
                        w.__mjPendingSubmitContexts = pending

                        let contextIndex = -1
                        if (requestPromptNormalized) {
                          contextIndex = pending.findIndex((ctx: any) => {
                            const expected = normalizePrompt(ctx.expectedPrompt || ctx.prompt)
                            return (
                              expected === requestPromptNormalized ||
                              expected.includes(requestPromptNormalized) ||
                              requestPromptNormalized.includes(expected)
                            )
                          })
                        }
                        if (contextIndex < 0 && pending.length > 0) {
                          contextIndex = 0
                        }
                        const matchedContext =
                          contextIndex >= 0
                            ? pending.splice(contextIndex, 1)[0]
                            : null
                        w.__mjPendingSubmitContexts = pending

                        console.log("[get-into-zone][midjourney][network] fetch /api/submit-jobs", {
                          requestPrompt,
                          matchedQueueItemId: matchedContext?.queueItemId || null,
                          jobId
                        })

                        emitSubmitJobResult(
                          jobId,
                          matchedContext
                            ? {
                                prompt: matchedContext.prompt || "",
                                folderTag: matchedContext.folderTag || "",
                                queueItemId: matchedContext.queueItemId || null
                              }
                            : undefined,
                          "fetch"
                        )
                      })
                      .catch((error: any) => {
                        console.log(
                          "[get-into-zone][midjourney][network] fetch submit-jobs parse error",
                          error?.message || error
                        )
                      })
                  } catch {
                    // ignore clone/parse issues
                  }
                }
                return response
              }

              w.__mjOriginalXHROpen = XMLHttpRequest.prototype.open
              w.__mjOriginalXHRSend = XMLHttpRequest.prototype.send

              XMLHttpRequest.prototype.open = function (
                method: string,
                url: string | URL,
                async?: boolean,
                username?: string | null,
                password?: string | null
              ) {
                ;(this as any).__mjUrl = String(url || "")
                return w.__mjOriginalXHROpen.call(
                  this,
                  method,
                  url,
                  async,
                  username,
                  password
                )
              }

              XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
                const xhr = this as XMLHttpRequest & { __mjUrl?: string }
                let requestPrompt = ""
                try {
                  if (typeof body === "string") {
                    try {
                      const bodyJson = JSON.parse(body)
                      requestPrompt =
                        typeof bodyJson?.prompt === "string"
                          ? bodyJson.prompt
                          : ""
                    } catch {
                      // ignore parse errors
                    }
                  }
                  xhr.addEventListener("load", function () {
                    const requestUrl = xhr.__mjUrl || ""
                    if (!requestUrl.includes("/api/submit-jobs")) return
                    try {
                      const data = JSON.parse(xhr.responseText || "{}")
                      const jobId =
                        data?.success &&
                        Array.isArray(data.success) &&
                        data.success[0]?.job_id
                          ? data.success[0].job_id
                          : null

                      const requestPromptNormalized = normalizePrompt(requestPrompt)
                      const pending = (w.__mjPendingSubmitContexts || []).filter(
                        (ctx: any) => Date.now() - Number(ctx.createdAt || 0) < 180000
                      )
                      w.__mjPendingSubmitContexts = pending

                      let contextIndex = -1
                      if (requestPromptNormalized) {
                        contextIndex = pending.findIndex((ctx: any) => {
                          const expected = normalizePrompt(ctx.expectedPrompt || ctx.prompt)
                          return (
                            expected === requestPromptNormalized ||
                            expected.includes(requestPromptNormalized) ||
                            requestPromptNormalized.includes(expected)
                          )
                        })
                      }
                      if (contextIndex < 0 && pending.length > 0) {
                        contextIndex = 0
                      }
                      const matchedContext =
                        contextIndex >= 0
                          ? pending.splice(contextIndex, 1)[0]
                          : null
                      w.__mjPendingSubmitContexts = pending

                      console.log("[get-into-zone][midjourney][network] xhr /api/submit-jobs", {
                        requestPrompt,
                        matchedQueueItemId: matchedContext?.queueItemId || null,
                        jobId
                      })

                      emitSubmitJobResult(
                        jobId,
                        matchedContext
                          ? {
                              prompt: matchedContext.prompt || "",
                              folderTag: matchedContext.folderTag || "",
                              queueItemId: matchedContext.queueItemId || null
                            }
                          : undefined,
                        "xhr"
                      )
                    } catch (error: any) {
                      console.log(
                        "[get-into-zone][midjourney][network] xhr submit-jobs parse error",
                        error?.message || error
                      )
                    }
                  })
                } catch {
                  // ignore listener issues
                }
                return w.__mjOriginalXHRSend.call(this, body as any)
              }
            }
          } catch (e) {
            console.error("Failed to patch fetch for Midjourney:", e)
          }

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

              const w = window as any
              if (!w.__mjPendingSubmitContexts) {
                w.__mjPendingSubmitContexts = []
              }
              w.__mjPendingSubmitContexts = (w.__mjPendingSubmitContexts || []).filter(
                (ctx: any) => Date.now() - Number(ctx.createdAt || 0) < 180000
              )
              w.__mjPendingSubmitContexts.push({
                prompt: String(prompt || ""),
                expectedPrompt: String(prompt || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .toLowerCase(),
                folderTag: String(folderTag || ""),
                queueItemId: typeof queueItemId === "string" ? queueItemId : null,
                createdAt: Date.now()
              })
              console.log("[get-into-zone][midjourney][network] queued submit context", {
                queueItemId: typeof queueItemId === "string" ? queueItemId : null,
                prompt: String(prompt || "").slice(0, 140),
                pendingCount: w.__mjPendingSubmitContexts.length
              })
              setTimeout(() => {
                const pendingStillExists = (w.__mjPendingSubmitContexts || []).some(
                  (ctx: any) =>
                    ctx?.queueItemId ===
                    (typeof queueItemId === "string" ? queueItemId : null)
                )
                if (pendingStillExists) {
                  console.warn(
                    "[get-into-zone][midjourney][network] pending context not resolved after 20s",
                    {
                      queueItemId:
                        typeof queueItemId === "string" ? queueItemId : null,
                      expectedPrompt: String(prompt || "").slice(0, 140),
                      pendingCount: (w.__mjPendingSubmitContexts || []).length
                    }
                  )
                }
              }, 20000)

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
    args: [prompt, useLastImage, folderTag, queueItemId ?? null]
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
