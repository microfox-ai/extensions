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
      const tagsArray = tags ? tags.split(",").map((tag) => tag.trim()) : []

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
