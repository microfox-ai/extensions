console.log("Content script loaded.")

let isButtonFeatureEnabled = true

// Track which media elements already have buttons to prevent duplicates
const mediaElementsWithButtons = new WeakMap<
  HTMLImageElement | HTMLVideoElement,
  HTMLElement
>()

chrome.storage.local.get("isButtonEnabled", (result) => {
  if (result.isButtonEnabled !== undefined) {
    isButtonFeatureEnabled = result.isButtonEnabled
  }
})

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "local" && changes.isButtonEnabled) {
    isButtonFeatureEnabled = changes.isButtonEnabled.newValue
    if (!isButtonFeatureEnabled) {
      const buttons = document.querySelectorAll(".media-save-button")
      buttons.forEach((btn) => ((btn as HTMLElement).style.display = "none"))
    }
  }
})

/**
 * Find the *sidebar* Remix/Edit button only (track detail panel), not list items.
 * - In the ref HTML it sits in a div.relative whose previous sibling is "Add a Caption".
 * - Fallback: sidebar button is the full-width pill (w-full / py-[13px]); list items are icon-only.
 */
function findSidebarRemixEditButton(): HTMLButtonElement | null {
  const buttons = Array.from(
    document.querySelectorAll("button")
  ) as HTMLButtonElement[]
  for (const btn of buttons) {
    const text = btn.textContent?.trim().toLowerCase() ?? ""
    if (!text.includes("remix/edit")) continue
    const wrapperDiv = btn.closest("div.relative")
    if (!wrapperDiv) continue
    const prev = wrapperDiv.previousElementSibling
    const prevText = (prev?.textContent?.trim() ?? "").toLowerCase()
    const isNextToAddCaption = prev != null && prevText.includes("add a caption")
    const isFullWidthPill =
      btn.classList.contains("w-full") ||
      /\bpy-\[13px\]\b/.test(btn.className) ||
      /\brounded-\[16px\]\b/.test(btn.className)
    if (isNextToAddCaption || isFullWidthPill) return btn
  }
  return null
}

function injectSunoUploadUI() {
  try {
    const remixButton = findSidebarRemixEditButton()
    if (!remixButton) return

    const wrapperDiv = remixButton.closest("div.relative")
    if (!wrapperDiv) return
    // Avoid double inject: check if we already added our block after this div
    if (wrapperDiv.nextElementSibling?.hasAttribute?.("data-mediamake-suno-upload")) {
      return
    }

    const wrapper = document.createElement("div")
    wrapper.setAttribute("data-mediamake-suno-upload", "true")
    Object.assign(wrapper.style, {
      marginTop: "12px",
      padding: "12px",
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      background: "rgba(30, 30, 30, 0.95)",
      borderRadius: "12px",
      border: "1px solid rgba(255,255,255,0.08)",
      fontFamily: "inherit"
    })

    const tagLabel = document.createElement("label")
    tagLabel.textContent = "Tag"
    Object.assign(tagLabel.style, { fontSize: "11px", color: "rgba(255,255,255,0.6)", fontWeight: "500" })

    const tagInput = document.createElement("input")
    tagInput.type = "text"
    tagInput.placeholder = "e.g. suno-remix"
    Object.assign(tagInput.style, {
      padding: "8px 10px",
      fontSize: "12px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(0,0,0,0.3)",
      color: "#fff",
      outline: "none",
      width: "100%",
      boxSizing: "border-box"
    })

    const langLabel = document.createElement("label")
    langLabel.textContent = "Language"
    Object.assign(langLabel.style, { fontSize: "11px", color: "rgba(255,255,255,0.6)", fontWeight: "500" })

    const langInput = document.createElement("input")
    langInput.type = "text"
    langInput.placeholder = "en"
    langInput.value = "en"
    Object.assign(langInput.style, {
      padding: "8px 10px",
      fontSize: "12px",
      borderRadius: "8px",
      border: "1px solid rgba(255,255,255,0.15)",
      background: "rgba(0,0,0,0.3)",
      color: "#fff",
      outline: "none",
      width: "100%",
      boxSizing: "border-box"
    })

    const uploadButton = document.createElement("button")
    uploadButton.textContent = "Upload to Mediamake"
    Object.assign(uploadButton.style, {
      padding: "10px 14px",
      fontSize: "12px",
      fontWeight: "600",
      cursor: "pointer",
      borderRadius: "10px",
      border: "none",
      background: "linear-gradient(180deg, #6366f1 0%, #4f46e5 100%)",
      color: "#fff",
      marginTop: "4px"
    })
    uploadButton.addEventListener("mouseenter", () => {
      if (!uploadButton.disabled) uploadButton.style.background = "linear-gradient(180deg, #818cf8 0%, #6366f1 100%)"
    })
    uploadButton.addEventListener("mouseleave", () => {
      if (!uploadButton.disabled) uploadButton.style.background = "linear-gradient(180deg, #6366f1 0%, #4f46e5 100%)"
    })

    uploadButton.addEventListener("click", () => {
      uploadButton.disabled = true
      uploadButton.textContent = "Preparing upload..."

      const remixButton = findSidebarRemixEditButton()
      if (!remixButton) {
        uploadButton.disabled = false
        uploadButton.textContent = "Upload to Mediamake"
        alert("Open a track in the right sidebar first.")
        return
      }

      const wrapperDiv = remixButton.closest("div.relative") as HTMLElement | null
      if (!wrapperDiv) {
        uploadButton.disabled = false
        uploadButton.textContent = "Upload to Mediamake"
        alert("Could not locate track section.")
        return
      }

      // Walk up from the Remix/Edit container to find the nearest /song/ link
      let current: HTMLElement | null = wrapperDiv
      let songLink: HTMLAnchorElement | null = null
      while (current && current !== document.body) {
        const candidate = current.querySelector(
          'a[href*="/song/"]'
        ) as HTMLAnchorElement | null
        if (candidate) {
          songLink = candidate
          break
        }
        current = current.parentElement
      }

      const href = songLink?.getAttribute("href") || ""
      const lastSegment = href.split("/").filter(Boolean).pop() || ""
      const songId = lastSegment.split("?")[0]?.trim() || null
      const audioUrl = songId
        ? `https://cdn1.suno.ai/${songId}.m4a`
        : null
      const audioScope =
        (wrapperDiv.closest("aside") as HTMLElement | null) ||
        (wrapperDiv.closest("div") as HTMLElement | null) ||
        document.body
      const audioEl = audioScope.querySelector("audio") as
        | HTMLAudioElement
        | null
      const finalAudioUrl = audioUrl || audioEl?.src || null

      if (!finalAudioUrl) {
        uploadButton.disabled = false
        uploadButton.textContent = "Upload to Mediamake"
        alert("Could not find audio URL for this track.")
        return
      }

      uploadButton.textContent = "Triggering worker..."

      chrome.runtime.sendMessage(
        {
          action: "uploadSunoTrackToMediamake",
          audioUrl: finalAudioUrl,
          language: langInput.value.trim() || "en",
          tag: tagInput.value.trim() || undefined
        },
        (response) => {
          uploadButton.disabled = false
          if (!response) {
            uploadButton.textContent = "Upload to Mediamake"
            alert("No response from extension. Check API Endpoint in Settings.")
            return
          }
          if (!response.success) {
            uploadButton.textContent = "Upload to Mediamake"
            alert(response.message || "Failed to queue worker.")
            return
          }
          uploadButton.textContent = "Worker queued!"
          setTimeout(() => {
            uploadButton.textContent = "Upload to Mediamake"
          }, 3000)
        }
      )
    })

    wrapper.appendChild(tagLabel)
    wrapper.appendChild(tagInput)
    wrapper.appendChild(langLabel)
    wrapper.appendChild(langInput)
    wrapper.appendChild(uploadButton)

    wrapperDiv.after(wrapper)
  } catch (e) {
    console.error("Failed to inject Suno upload UI:", e)
  }
}

if (window.location.hostname === "suno.com") {
  const observer = new MutationObserver(() => {
    injectSunoUploadUI()
  })
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  })
  injectSunoUploadUI()
}

// Listen for Midjourney job submit results from the page context
window.addEventListener("message", (event) => {
  try {
    const data = event.data
    if (
      !data ||
      typeof data !== "object" ||
      data.type !== "MIDJOURNEY_SUBMIT_JOB_RESULT"
    ) {
      return
    }
    const { jobId, folderTag, queueItemId } = data
    console.log(
      "[get-into-zone] MIDJOURNEY_SUBMIT_JOB_RESULT in content script",
      { jobId, folderTag, queueItemId }
    )
    if (!jobId || typeof jobId !== "string") return
    if (!queueItemId || typeof queueItemId !== "string") return

    chrome.runtime.sendMessage({
      action: "midjourneyJobSubmitted",
      jobId,
      folderTag: typeof folderTag === "string" ? folderTag : null,
      queueItemId
    })
  } catch (e) {
    console.error("Failed to handle MIDJOURNEY_SUBMIT_JOB_RESULT message:", e)
  }
})

function createOverlayButton(
  mediaElement: HTMLImageElement | HTMLVideoElement
) {
  // Skip if button already exists for this element
  if (mediaElementsWithButtons.has(mediaElement)) {
    return mediaElementsWithButtons.get(mediaElement)!
  }

  // Skip if element doesn't have a valid src or is too small
  if (!mediaElement.src || mediaElement.src === "") {
    return null
  }

  const button = document.createElement("button")
  button.innerText = "Save"
  button.className = "media-save-button" // Add a class for easy selection
  button.style.position = "absolute"
  button.style.zIndex = "10000"
  button.style.backgroundColor = "rgba(0, 0, 0, 0.7)"
  button.style.color = "white"
  button.style.border = "1px solid white"
  button.style.borderRadius = "4px"
  button.style.padding = "4px 8px"
  button.style.cursor = "pointer"
  button.style.fontSize = "12px"
  button.style.display = "none" // Initially hide the button
  document.body.appendChild(button)

  // Track this button for this media element
  mediaElementsWithButtons.set(mediaElement, button)

  const setButtonPosition = () => {
    const rect = mediaElement.getBoundingClientRect()
    // Only position button if element is visible
    if (rect.width > 0 && rect.height > 0) {
      button.style.left = `${window.scrollX + rect.left}px`
      button.style.top = `${window.scrollY + rect.top}px`
    }
  }

  setButtonPosition()

  // Update button position on scroll and resize
  const updatePosition = () => {
    if (button.style.display !== "none") {
      setButtonPosition()
    }
  }
  window.addEventListener("scroll", updatePosition, true)
  window.addEventListener("resize", updatePosition)

  let hideTimeout: number

  const showButton = () => {
    if (!isButtonFeatureEnabled) {
      button.style.display = "none"
      return
    }

    // Show button for any image/video that's at least 50x50 pixels
    if (mediaElement.clientWidth < 50 || mediaElement.clientHeight < 50) {
      return
    }
    clearTimeout(hideTimeout)
    button.style.display = "block"
    setButtonPosition()
  }

  const hideButton = () => {
    hideTimeout = window.setTimeout(() => {
      button.style.display = "none"
    }, 200)
  }

  mediaElement.addEventListener("mouseenter", showButton)
  mediaElement.addEventListener("mouseleave", hideButton)
  button.addEventListener("mouseenter", showButton)
  button.addEventListener("mouseleave", hideButton)

  button.addEventListener("click", () => {
    button.innerText = "Saving..."
    button.disabled = true

    const resetButtonState = () => {
      button.innerText = "Save"
      button.disabled = false
    }

    chrome.storage.local.get(["apiEndpoint", "tags", "apiKey"], (result) => {
      const { apiEndpoint, tags, apiKey } = result
      if (!apiEndpoint || !apiKey) {
        console.error("API endpoint or API key is not set.")
        alert(
          "API endpoint or API key is not set. Please configure it in the extension popup."
        )
        resetButtonState()
        return
      }

      let mediaUrl = mediaElement.src
      if (mediaUrl.startsWith("https://cdn.midjourney.com/")) {
        try {
          const url = new URL(mediaUrl)
          const pathname = url.pathname
          const parts = pathname.split("/")
          const filenameWithExt = parts.pop()
          if (filenameWithExt) {
            const filenameParts = filenameWithExt.split("_")
            if (filenameParts.length > 2) {
              const basename = filenameParts.slice(0, -2).join("_")
              const newFilename = `${basename}.png`
              const newPath = [...parts, newFilename].join("/")
              mediaUrl = `${url.origin}${newPath}`
            }
          }
        } catch (e) {
          console.error("Could not reformat Midjourney URL", e)
        }
      }

      let prompt =
        mediaElement instanceof HTMLImageElement ? mediaElement.alt || "" : ""

      if (window.location.hostname.includes("midjourney.com")) {
        const mainGrid = mediaElement.closest('div[class*="grid-cols-"]')
        if (mainGrid) {
          const promptContainer = mainGrid.querySelector(
            'div[class*="group/promptText"]'
          )
          if (promptContainer) {
            const promptDiv = promptContainer.querySelector(
              'div[class*="break-word"]'
            )
            if (promptDiv) {
              const promptParts: string[] = []
              const allSpans = promptDiv.querySelectorAll("span.relative")
              allSpans.forEach((span) => {
                if (!span.classList.contains("select-none")) {
                  promptParts.push(span.textContent || "")
                }
              })
              if (promptParts.length > 0) {
                prompt = promptParts.join(" ").trim()
              }
            }
          }
        }
      }
      const tagsArray = tags
        ? tags.split(",").map((tag: string) => tag.trim())
        : []

      fetch(mediaUrl)
        .then((response) => response.blob())
        .then((blob) => {
          console.log("blob received for", mediaUrl, blob.size)
          const reader = new FileReader()
          reader.onloadend = () => {
            const imageData = reader.result
            const payload = {
              prompt,
              tags: tagsArray,
              imageData: imageData,
              imageMimeType: blob.type
            }

            chrome.runtime.sendMessage(
              {
                action: "sendApiRequest",
                endpoint: apiEndpoint,
                apiKey: apiKey,
                payload: payload
              },
              (response) => {
                if (response.success) {
                  console.log("API response:", response.data)
                  button.innerText = "Saved!"
                  setTimeout(() => {
                    resetButtonState()
                  }, 2000)
                } else {
                  console.error("Error sending data to API:", response.error)
                  alert("Failed to send media information.")
                  resetButtonState()
                }
              }
            )
          }
          reader.readAsDataURL(blob)
        })
        .catch((error) => {
          console.error("Error fetching or converting image:", error)
          alert("Failed to fetch media to send.")
          resetButtonState()
        })
    })
  })

  return button
}

function processMediaElements() {
  const mediaElements = document.querySelectorAll("img, video")
  mediaElements.forEach((element) => {
    // Check if the element is an instance of HTMLImageElement or HTMLVideoElement
    if (
      element instanceof HTMLImageElement ||
      element instanceof HTMLVideoElement
    ) {
      // Create button for all images/videos on any website
      const button = createOverlayButton(element)
      if (!button) {
        // Element doesn't have a valid src, skip it
        return
      }
    }
  })
}

// Initial run
processMediaElements()

// Set up a MutationObserver to watch for new media elements being added to the DOM
const observer = new MutationObserver((mutations) => {
  mutations.forEach((mutation) => {
    mutation.addedNodes.forEach((node) => {
      if (
        node instanceof HTMLImageElement ||
        node instanceof HTMLVideoElement
      ) {
        // Create button for new images/videos on any website
        createOverlayButton(node)
      } else if (node.nodeType === 1) {
        // Element node - check for nested media elements
        const mediaInNode = (node as Element).querySelectorAll("img, video")
        mediaInNode.forEach((media) => {
          if (
            media instanceof HTMLImageElement ||
            media instanceof HTMLVideoElement
          ) {
            // Create button for nested images/videos on any website
            createOverlayButton(media)
          }
        })
      }
    })
  })
})

observer.observe(document.body, { childList: true, subtree: true })
