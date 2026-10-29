import {
  isPinterestHost,
  isSaverActive,
  isSunoHost,
  watchSaverRules,
  type SaverFeature,
  type SaverRule
} from "./lib/saverRules"
import {
  pinImageIdFromElement,
  pinVideoIdFromElement,
  pinterestPageKey,
  type BulkItemKind
} from "./lib/pinterestBulk"

console.log("Content script loaded.")

const isPinterestPage = isPinterestHost(window.location.hostname)
const isSunoPage = isSunoHost(window.location.hostname)

// Saver toggles from the popup's Saver tab. Evaluated against the live URL so
// page rules keep working across SPA navigations.
let saverRules: SaverRule[] = []
let saverWindowId: number | undefined

const isSaverOn = (feature: SaverFeature) =>
  isSaverActive(saverRules, feature, {
    url: window.location.href,
    windowId: saverWindowId
  })

// Track which media elements already have buttons to prevent duplicates
const mediaElementsWithButtons = new WeakMap<
  HTMLImageElement | HTMLVideoElement,
  HTMLElement
>()
const pinterestOverlays = new WeakMap<HTMLImageElement, HTMLElement>()
const pinterestResultPanels = new WeakMap<HTMLImageElement, HTMLElement>()
// Show/hide controls per overlay, used by document-level hover delegation so
// the overlay appears even when Pinterest's own overlay/canvas layers sit on
// top of the image and swallow its pointer events.
const pinterestOverlayControls = new WeakMap<
  HTMLImageElement,
  { show: () => void; hide: () => void }
>()
const pinterestTrackedImages = new Set<HTMLImageElement>()
const pinterestAnalysisCache = new WeakMap<
  HTMLImageElement,
  {
    description?: string
    keywords?: string[]
    artStyle?: string[]
    audienceKeywords?: string[]
  }
>()

let activePinterestOverlayImage: HTMLImageElement | null = null

// Hide every overlay so the next hover re-renders it under the new rules.
function applySaverRules() {
  document
    .querySelectorAll(".media-save-button")
    .forEach((btn) => ((btn as HTMLElement).style.display = "none"))
  activePinterestOverlayImage = null
  if (isSunoPage) injectSunoUploadUI()
}

watchSaverRules((rules) => {
  saverRules = rules
  applySaverRules()
})

chrome.runtime.sendMessage({ action: "getSaverContext" }, (response) => {
  if (chrome.runtime.lastError) return
  if (typeof response?.windowId === "number") {
    saverWindowId = response.windowId
    applySaverRules()
  }
})

chrome.runtime.onMessage.addListener((request) => {
  if (
    request?.action === "saverWindowChanged" &&
    typeof request.windowId === "number"
  ) {
    saverWindowId = request.windowId
    applySaverRules()
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
    const isNextToAddCaption =
      prev != null && prevText.includes("add a caption")
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
    if (!isSaverOn("all")) {
      document
        .querySelectorAll("[data-mediamake-suno-upload]")
        .forEach((el) => el.remove())
      return
    }

    const remixButton = findSidebarRemixEditButton()
    if (!remixButton) return

    const wrapperDiv = remixButton.closest("div.relative")
    if (!wrapperDiv) return
    // Avoid double inject: check if we already added our block after this div
    if (
      wrapperDiv.nextElementSibling?.hasAttribute?.(
        "data-mediamake-suno-upload"
      )
    ) {
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
    tagLabel.textContent = "Tags (comma-separated) - used in saving images"
    Object.assign(tagLabel.style, {
      fontSize: "11px",
      color: "rgba(255,255,255,0.6)",
      fontWeight: "500"
    })

    const tagInput = document.createElement("input")
    tagInput.type = "text"
    tagInput.placeholder = "e.g. suno, remix, temp"
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
    Object.assign(langLabel.style, {
      fontSize: "11px",
      color: "rgba(255,255,255,0.6)",
      fontWeight: "500"
    })

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
      if (!uploadButton.disabled)
        uploadButton.style.background =
          "linear-gradient(180deg, #818cf8 0%, #6366f1 100%)"
    })
    uploadButton.addEventListener("mouseleave", () => {
      if (!uploadButton.disabled)
        uploadButton.style.background =
          "linear-gradient(180deg, #6366f1 0%, #4f46e5 100%)"
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

      const wrapperDiv = remixButton.closest(
        "div.relative"
      ) as HTMLElement | null
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
          'h3 a[href*="/song/"]'
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
      const audioUrl = songId ? `https://cdn1.suno.ai/${songId}.m4a` : null
      const audioScope =
        (wrapperDiv.closest("aside") as HTMLElement | null) ||
        (wrapperDiv.closest("div") as HTMLElement | null) ||
        document.body
      const audioEl = audioScope.querySelector(
        "audio"
      ) as HTMLAudioElement | null
      const finalAudioUrl = audioUrl || audioEl?.src || null
      const title = songLink?.textContent?.trim()
      const copyLyricsButton = document.querySelector(
        'button[aria-label="Copy lyrics to clipboard"]'
      ) as HTMLButtonElement | null
      const lyricsDisplayContainer = copyLyricsButton?.closest("div.css-x4if1z")
      const lyricsDisplayText = (
        (lyricsDisplayContainer?.querySelector(".pr-6") as HTMLElement | null)
          ?.innerText || ""
      ).trim()
      const lyricsTextarea =
        (document.querySelector(
          '[data-testid="lyrics-textarea"]'
        ) as HTMLTextAreaElement | null) ||
        (audioScope.querySelector(
          '[data-testid="lyrics-textarea"]'
        ) as HTMLTextAreaElement | null) ||
        null
      const sunoLyricsRaw = (
        lyricsDisplayText ||
        lyricsTextarea?.value ||
        lyricsTextarea?.textContent ||
        ""
      ).trim()
      const sunoLyricsFallback = (
        (
          document.querySelector(
            '[data-testid="lyrics-textarea"]'
          ) as HTMLElement | null
        )?.innerText || ""
      ).trim()
      const sunoLyrics =
        sunoLyricsRaw.length > 0
          ? sunoLyricsRaw
          : sunoLyricsFallback.length > 0
            ? sunoLyricsFallback
            : undefined
      const tags = tagInput.value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)

      if (!finalAudioUrl) {
        uploadButton.disabled = false
        uploadButton.textContent = "Upload to Mediamake"
        alert("Could not find audio URL for this track.")
        return
      }

      uploadButton.textContent = "Triggering worker..."

      chrome.storage.local.get(["selectedProjectId"], (storage) => {
        chrome.runtime.sendMessage(
          {
            action: "uploadSunoTrackToMediamake",
            audioUrl: finalAudioUrl,
            language: langInput.value.trim() || "en",
            tags: tags.length > 0 ? tags : undefined,
            title: title || undefined,
            sunoLyrics,
            projectId:
              typeof storage.selectedProjectId === "string" &&
              storage.selectedProjectId.trim().length > 0
                ? storage.selectedProjectId.trim()
                : undefined
          },
          (response) => {
            uploadButton.disabled = false
            if (!response) {
              uploadButton.textContent = "Upload to Mediamake"
              alert(
                "No response from extension. Check API Endpoint in Settings."
              )
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

if (isSunoPage) {
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
      "[browse-hack] MIDJOURNEY_SUBMIT_JOB_RESULT in content script",
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

function removePinterestPanel(mediaElement: HTMLImageElement) {
  const panel = pinterestResultPanels.get(mediaElement)
  if (panel && panel.parentElement) {
    panel.parentElement.removeChild(panel)
  }
  pinterestResultPanels.delete(mediaElement)
}

function renderPinterestPanel(
  mediaElement: HTMLImageElement,
  status: "loading" | "success" | "error",
  content: { title: string; description?: string; keywords?: string[] }
) {
  removePinterestPanel(mediaElement)
  const panel = document.createElement("div")
  panel.className = "media-save-button"
  panel.setAttribute("data-mm-overlay-type", "pinterest-analysis")
  panel.style.position = "absolute"
  panel.style.zIndex = "10001"
  panel.style.maxWidth = "320px"
  panel.style.padding = "10px"
  panel.style.borderRadius = "10px"
  panel.style.border = "1px solid rgba(255,255,255,0.18)"
  panel.style.background =
    status === "error" ? "rgba(112, 28, 28, 0.96)" : "rgba(15, 23, 42, 0.95)"
  panel.style.color = "white"
  panel.style.fontSize = "12px"
  panel.style.lineHeight = "1.4"
  panel.style.boxShadow = "0 8px 20px rgba(0,0,0,0.35)"

  const rect = mediaElement.getBoundingClientRect()
  panel.style.left = `${window.scrollX + rect.left}px`
  panel.style.top = `${window.scrollY + rect.top}px`

  const header = document.createElement("div")
  header.style.display = "flex"
  header.style.alignItems = "center"
  header.style.justifyContent = "space-between"
  header.style.gap = "8px"
  header.style.marginBottom = "6px"

  const title = document.createElement("div")
  title.style.fontWeight = "600"
  title.style.flex = "1"
  title.innerText = content.title
  header.appendChild(title)

  if (content.description && content.description.trim().length > 0) {
    const copyButton = document.createElement("button")
    copyButton.innerText = "📋"
    copyButton.title = "Copy description"
    copyButton.style.border = "1px solid rgba(255,255,255,0.3)"
    copyButton.style.borderRadius = "6px"
    copyButton.style.background = "rgba(255,255,255,0.1)"
    copyButton.style.color = "#fff"
    copyButton.style.cursor = "pointer"
    copyButton.style.fontSize = "12px"
    copyButton.style.padding = "2px 6px"
    copyButton.style.lineHeight = "1.1"

    copyButton.addEventListener("click", async (event) => {
      event.preventDefault()
      event.stopPropagation()
      const textToCopy = content.description || ""
      try {
        await navigator.clipboard.writeText(textToCopy)
      } catch {
        const textArea = document.createElement("textarea")
        textArea.value = textToCopy
        textArea.style.position = "fixed"
        textArea.style.opacity = "0"
        document.body.appendChild(textArea)
        textArea.select()
        document.execCommand("copy")
        document.body.removeChild(textArea)
      }
      const oldLabel = copyButton.innerText
      copyButton.innerText = "✓"
      window.setTimeout(() => {
        copyButton.innerText = oldLabel
      }, 1200)
    })

    header.appendChild(copyButton)
  }

  panel.appendChild(header)

  if (content.description) {
    const description = document.createElement("div")
    description.style.marginBottom = "6px"
    description.innerText = content.description
    panel.appendChild(description)
  }

  if (content.keywords && content.keywords.length > 0) {
    const keywords = document.createElement("div")
    keywords.style.opacity = "0.9"
    keywords.innerText = `Keywords: ${content.keywords.slice(0, 8).join(", ")}`
    panel.appendChild(keywords)
  }

  document.body.appendChild(panel)
  pinterestResultPanels.set(mediaElement, panel)

  if (status !== "loading") {
    window.setTimeout(() => {
      removePinterestPanel(mediaElement)
    }, 8000)
  }
}

function setPinterestButtonState(
  button: HTMLButtonElement,
  text: string,
  disabled: boolean
) {
  button.innerText = text
  button.disabled = disabled
  button.style.opacity = disabled ? "0.7" : "1"
  button.style.cursor = disabled ? "default" : "pointer"
}

function queueSparkboardUpload(
  payload: {
    sourceUrl: string
    pageUrl: string
    tags: string[]
    metadata: Record<string, unknown>
  },
  onDone: (ok: boolean, message: string) => void
) {
  chrome.runtime.sendMessage(
    {
      action: "queueSparkboardIndex",
      sourceUrl: payload.sourceUrl,
      tags: payload.tags,
      contentMimeType: "image/jpeg",
      contentSubType: "general",
      contentSource: "web",
      // Use the actual media source URL for dedupe, not page URL.
      contentSourceUrl: payload.sourceUrl,
      metadata: payload.metadata || {},
      analyzeImage: false,
      generateDescription: false,
      generateKeywords: false
    },
    (response) => {
      if (!response?.success) {
        onDone(false, response?.message || "Failed to queue sparkboard worker.")
        return
      }
      onDone(true, "Queued for upload/indexing.")
    }
  )
}

function handlePinterestUpload(
  mediaElement: HTMLImageElement,
  withAi: boolean,
  withAiButton: HTMLButtonElement,
  noAiButton: HTMLButtonElement,
  viewAiButton: HTMLButtonElement
) {
  setPinterestButtonState(
    withAiButton,
    withAi ? "Analyzing..." : "Save + AI",
    true
  )
  setPinterestButtonState(
    noAiButton,
    withAi ? "Save (No AI)" : "Uploading...",
    true
  )

  const prompt = mediaElement.alt || ""
  chrome.storage.local.get(["tags"], (result) => {
    const storedTags =
      typeof result.tags === "string"
        ? result.tags
            .split(",")
            .map((tag: string) => tag.trim())
            .filter((tag: string) => tag.length > 0)
        : []
    const payloadTags =
      storedTags.length > 0 ? storedTags : ["pinterest", "extension-upload"]

    const queueNow = (
      metadata: Record<string, unknown>,
      successTitle: string
    ) => {
      queueSparkboardUpload(
        {
          sourceUrl: mediaElement.src,
          pageUrl: window.location.href,
          tags: payloadTags,
          metadata
        },
        (ok, message) => {
          if (ok) {
            renderPinterestPanel(mediaElement, "success", {
              title: successTitle,
              description: message,
              keywords: Array.isArray(metadata.keywords)
                ? (metadata.keywords as string[])
                : []
            })
            setPinterestButtonState(withAiButton, "Done", true)
            setPinterestButtonState(noAiButton, "Done", true)
            window.setTimeout(() => {
              setPinterestButtonState(withAiButton, "Save + AI", false)
              setPinterestButtonState(noAiButton, "Save (No AI)", false)
            }, 1800)
            return
          }

          renderPinterestPanel(mediaElement, "error", {
            title: "Worker queue failed",
            description: message
          })
          setPinterestButtonState(withAiButton, "Save + AI", false)
          setPinterestButtonState(noAiButton, "Save (No AI)", false)
        }
      )
    }

    if (!withAi) {
      renderPinterestPanel(mediaElement, "loading", {
        title: "Queueing upload/index worker..."
      })
      queueNow(
        {
          platform: "web",
          platformId: "web",
          platformUrl: window.location.href,
          imageLink: mediaElement.src,
          src: mediaElement.src
        },
        "Uploaded without AI generation"
      )
      return
    }

    chrome.runtime.sendMessage(
      {
        action: "analyzeImageWithApi",
        imageUrl: mediaElement.src,
        pageUrl: window.location.href,
        imageAlt: mediaElement.alt || "",
        prompt,
        tags: payloadTags
      },
      (response) => {
        if (!response?.success) {
          renderPinterestPanel(mediaElement, "error", {
            title: "AI analysis failed",
            description: response?.message || "Request failed."
          })
          setPinterestButtonState(withAiButton, "Save + AI", false)
          setPinterestButtonState(noAiButton, "Save (No AI)", false)
          return
        }

        const apiData = response.data?.data || response.data
        const analysis = apiData?.analysis
        if (!analysis) {
          renderPinterestPanel(mediaElement, "error", {
            title: "AI analysis failed",
            description: "No AI analysis was returned."
          })
          setPinterestButtonState(withAiButton, "Save + AI", false)
          setPinterestButtonState(noAiButton, "Save (No AI)", false)
          return
        }

        pinterestAnalysisCache.set(mediaElement, analysis)
        setPinterestButtonState(viewAiButton, "View AI", false)

        // Persist the analysis to DB so it shows in the Pinterest tab
        chrome.runtime.sendMessage({
          action: "savePinterestAnalysis",
          imageUrl: mediaElement.src,
          pageUrl: window.location.href,
          imageAlt: mediaElement.alt || "",
          description: analysis.description,
          keywords: analysis.keywords || [],
          artStyle: analysis.artStyle || [],
          audienceKeywords: analysis.audienceKeywords || []
        })

        renderPinterestPanel(mediaElement, "loading", {
          title: "AI complete. Queueing upload/index worker...",
          description: analysis.description || "",
          keywords: analysis.keywords || []
        })

        queueNow(
          {
            description: analysis.description,
            keywords: analysis.keywords || [],
            artStyle: analysis.artStyle || [],
            audienceKeywords: analysis.audienceKeywords || [],
            platform: "web",
            platformId: "web",
            platformUrl: window.location.href,
            imageLink: mediaElement.src,
            src: mediaElement.src
          },
          "Uploaded with AI metadata"
        )
      }
    )
  })
}

function handlePinterestAnalyzeOnly(
  mediaElement: HTMLImageElement,
  aiOnlyButton: HTMLButtonElement,
  withAiButton: HTMLButtonElement,
  noAiButton: HTMLButtonElement,
  viewAiButton: HTMLButtonElement
) {
  setPinterestButtonState(aiOnlyButton, "Analyzing...", true)
  setPinterestButtonState(withAiButton, "Save + AI", true)
  setPinterestButtonState(noAiButton, "Save (No AI)", true)

  const prompt = mediaElement.alt || ""
  chrome.storage.local.get(["tags"], (result) => {
    const storedTags =
      typeof result.tags === "string"
        ? result.tags
            .split(",")
            .map((tag: string) => tag.trim())
            .filter((tag: string) => tag.length > 0)
        : []
    const payloadTags =
      storedTags.length > 0 ? storedTags : ["pinterest", "analysis-only"]

    renderPinterestPanel(mediaElement, "loading", {
      title: "Running AI analysis only..."
    })

    chrome.runtime.sendMessage(
      {
        action: "analyzeImageWithApi",
        imageUrl: mediaElement.src,
        pageUrl: window.location.href,
        imageAlt: mediaElement.alt || "",
        prompt,
        tags: payloadTags
      },
      (response) => {
        if (!response?.success) {
          renderPinterestPanel(mediaElement, "error", {
            title: "AI analysis failed",
            description: response?.message || "Request failed."
          })
          setPinterestButtonState(aiOnlyButton, "AI Only", false)
          setPinterestButtonState(withAiButton, "Save + AI", false)
          setPinterestButtonState(noAiButton, "Save (No AI)", false)
          return
        }

        const apiData = response.data?.data || response.data
        const analysis = apiData?.analysis
        if (!analysis) {
          renderPinterestPanel(mediaElement, "error", {
            title: "AI analysis failed",
            description: "No AI analysis was returned."
          })
          setPinterestButtonState(aiOnlyButton, "AI Only", false)
          setPinterestButtonState(withAiButton, "Save + AI", false)
          setPinterestButtonState(noAiButton, "Save (No AI)", false)
          return
        }

        pinterestAnalysisCache.set(mediaElement, analysis)
        setPinterestButtonState(viewAiButton, "View AI", false)

        // Persist the analysis to DB so it shows in the Pinterest tab
        chrome.runtime.sendMessage({
          action: "savePinterestAnalysis",
          imageUrl: mediaElement.src,
          pageUrl: window.location.href,
          imageAlt: mediaElement.alt || "",
          description: analysis.description,
          keywords: analysis.keywords || [],
          artStyle: analysis.artStyle || [],
          audienceKeywords: analysis.audienceKeywords || []
        })

        renderPinterestPanel(mediaElement, "success", {
          title: "AI analysis ready (not saved)",
          description: analysis.description || "",
          keywords: analysis.keywords || []
        })

        setPinterestButtonState(aiOnlyButton, "Done", true)
        setPinterestButtonState(withAiButton, "Save + AI", false)
        setPinterestButtonState(noAiButton, "Save (No AI)", false)
        window.setTimeout(() => {
          setPinterestButtonState(aiOnlyButton, "AI Only", false)
        }, 1500)
      }
    )
  })
}

function createPinterestOverlay(mediaElement: HTMLImageElement) {
  if (pinterestOverlays.has(mediaElement)) {
    return pinterestOverlays.get(mediaElement)!
  }
  if (!mediaElement.src || mediaElement.src === "") {
    return null
  }

  const wrapper = document.createElement("div")
  wrapper.className = "media-save-button"
  wrapper.setAttribute("data-mm-overlay-type", "pinterest-actions")
  wrapper.style.position = "absolute"
  wrapper.style.zIndex = "10000"
  wrapper.style.display = "none"
  wrapper.style.flexDirection = "column"
  wrapper.style.gap = "6px"
  wrapper.style.padding = "8px"
  wrapper.style.borderRadius = "10px"
  wrapper.style.background = "rgba(0,0,0,0.72)"
  wrapper.style.boxShadow = "0 6px 16px rgba(0,0,0,0.3)"
  document.body.appendChild(wrapper)
  pinterestOverlays.set(mediaElement, wrapper)

  const withAiButton = document.createElement("button")
  withAiButton.innerText = "Save + AI"
  withAiButton.style.border = "none"
  withAiButton.style.borderRadius = "7px"
  withAiButton.style.padding = "6px 9px"
  withAiButton.style.fontSize = "12px"
  withAiButton.style.fontWeight = "600"
  withAiButton.style.background = "#2563eb"
  withAiButton.style.color = "#fff"
  withAiButton.style.cursor = "pointer"

  const withoutAiButton = document.createElement("button")
  withoutAiButton.innerText = "Save (No AI)"
  withoutAiButton.style.border = "1px solid rgba(255,255,255,0.4)"
  withoutAiButton.style.borderRadius = "7px"
  withoutAiButton.style.padding = "6px 9px"
  withoutAiButton.style.fontSize = "12px"
  withoutAiButton.style.fontWeight = "600"
  withoutAiButton.style.background = "rgba(255,255,255,0.09)"
  withoutAiButton.style.color = "#fff"
  withoutAiButton.style.cursor = "pointer"

  const aiOnlyButton = document.createElement("button")
  aiOnlyButton.innerText = "AI Only"
  aiOnlyButton.style.border = "1px solid rgba(16,185,129,0.6)"
  aiOnlyButton.style.borderRadius = "7px"
  aiOnlyButton.style.padding = "6px 9px"
  aiOnlyButton.style.fontSize = "12px"
  aiOnlyButton.style.fontWeight = "600"
  aiOnlyButton.style.background = "rgba(16,185,129,0.16)"
  aiOnlyButton.style.color = "#d1fae5"
  aiOnlyButton.style.cursor = "pointer"

  const viewAiButton = document.createElement("button")
  viewAiButton.innerText = "View AI"
  viewAiButton.style.border = "1px solid rgba(96,165,250,0.65)"
  viewAiButton.style.borderRadius = "7px"
  viewAiButton.style.padding = "6px 9px"
  viewAiButton.style.fontSize = "12px"
  viewAiButton.style.fontWeight = "600"
  viewAiButton.style.background = "rgba(37,99,235,0.15)"
  viewAiButton.style.color = "#dbeafe"
  viewAiButton.style.cursor = "pointer"
  viewAiButton.disabled = !pinterestAnalysisCache.has(mediaElement)
  if (viewAiButton.disabled) {
    viewAiButton.style.opacity = "0.65"
    viewAiButton.innerText = "View AI (none)"
  }

  withAiButton.addEventListener("click", () =>
    handlePinterestUpload(
      mediaElement,
      true,
      withAiButton,
      withoutAiButton,
      viewAiButton
    )
  )
  withoutAiButton.addEventListener("click", () =>
    handlePinterestUpload(
      mediaElement,
      false,
      withAiButton,
      withoutAiButton,
      viewAiButton
    )
  )
  aiOnlyButton.addEventListener("click", () =>
    handlePinterestAnalyzeOnly(
      mediaElement,
      aiOnlyButton,
      withAiButton,
      withoutAiButton,
      viewAiButton
    )
  )
  viewAiButton.addEventListener("click", () => {
    const analysis = pinterestAnalysisCache.get(mediaElement)
    if (!analysis) {
      renderPinterestPanel(mediaElement, "error", {
        title: "No AI analysis yet",
        description: "Use Save + AI or AI Only first to generate analysis."
      })
      return
    }
    renderPinterestPanel(mediaElement, "success", {
      title: "AI analysis",
      description: analysis.description || "",
      keywords: analysis.keywords || []
    })
  })

  wrapper.appendChild(withAiButton)
  wrapper.appendChild(withoutAiButton)
  wrapper.appendChild(aiOnlyButton)
  wrapper.appendChild(viewAiButton)

  const setPosition = () => {
    const rect = mediaElement.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      wrapper.style.left = `${window.scrollX + rect.left}px`
      wrapper.style.top = `${window.scrollY + rect.top}px`
      const panel = pinterestResultPanels.get(mediaElement)
      if (panel) {
        panel.style.left = `${window.scrollX + rect.left}px`
        panel.style.top = `${window.scrollY + rect.top + 60}px`
      }
    }
  }

  const updatePosition = () => {
    if (wrapper.style.display !== "none") setPosition()
  }
  window.addEventListener("scroll", updatePosition, true)
  window.addEventListener("resize", updatePosition)

  let hideTimeout: number
  const show = () => {
    const saveOn = isSaverOn("save")
    const aiOn = isSaverOn("ai")
    withAiButton.style.display = saveOn && aiOn ? "" : "none"
    withoutAiButton.style.display = saveOn ? "" : "none"
    aiOnlyButton.style.display = aiOn ? "" : "none"
    viewAiButton.style.display = aiOn ? "" : "none"
    if (!saveOn && !aiOn) {
      wrapper.style.display = "none"
      return
    }
    if (mediaElement.clientWidth < 50 || mediaElement.clientHeight < 50) {
      return
    }
    clearTimeout(hideTimeout)
    wrapper.style.display = "flex"
    setPosition()
  }
  const hide = () => {
    hideTimeout = window.setTimeout(() => {
      wrapper.style.display = "none"
    }, 240)
  }
  mediaElement.addEventListener("mouseenter", show)
  mediaElement.addEventListener("mouseleave", hide)
  wrapper.addEventListener("mouseenter", show)
  wrapper.addEventListener("mouseleave", hide)

  pinterestOverlayControls.set(mediaElement, { show, hide })
  pinterestTrackedImages.add(mediaElement)

  return wrapper
}

function processPinterestMediaElements() {
  const mediaElements = document.querySelectorAll("img")
  mediaElements.forEach((element) => {
    if (element instanceof HTMLImageElement) {
      createPinterestOverlay(element)
    }
  })
}

// Pinterest's own hover overlay sits on top of the pin image and steals the
// hover, causing our overlay to flicker/hide. Disable its pointer events so it
// stops intercepting hover, but keep it in the DOM (removing it drops the pin
// from the list).
function disablePinterestHoverOverlays(root: ParentNode = document) {
  const overlays = root.querySelectorAll('[data-test-id="pin-card-hover-overlay"]')
  overlays.forEach((el) => {
    ;(el as HTMLElement).style.pointerEvents = "none"
  })
}

// Pinterest layers its own hover overlay (data-test-id="pin-card-hover-overlay")
// and renders the main pin on a canvas, both of which sit above the <img> and
// swallow its pointer events — so the image's own mouseenter often never fires.
// To make our overlay appear reliably, we resolve the hovered image by
// hit-testing the cursor against the bounding rects of every tracked image,
// regardless of what's painted on top.
function findPinterestImageAtPoint(x: number, y: number): HTMLImageElement | null {
  let best: HTMLImageElement | null = null
  let bestArea = Infinity
  for (const img of pinterestTrackedImages) {
    if (!img.isConnected) {
      pinterestTrackedImages.delete(img)
      continue
    }
    const rect = img.getBoundingClientRect()
    if (rect.width < 50 || rect.height < 50) continue
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      const area = rect.width * rect.height
      // Prefer the smallest (most specific) image when rects overlap/nest.
      if (area < bestArea) {
        bestArea = area
        best = img
      }
    }
  }
  return best
}

if (isPinterestPage) {
  document.addEventListener(
    "mousemove",
    (e) => {
      if (!isSaverOn("save") && !isSaverOn("ai")) return

      // Keep current state while the cursor is over our own overlay/panel so
      // the buttons stay interactive (their element listeners manage this).
      const target = e.target as HTMLElement | null
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest('.media-save-button, [data-mm-overlay-type]')
      ) {
        return
      }

      const img = findPinterestImageAtPoint(e.clientX, e.clientY)
      if (img === activePinterestOverlayImage) return

      if (activePinterestOverlayImage) {
        pinterestOverlayControls.get(activePinterestOverlayImage)?.hide()
      }
      if (img) {
        pinterestOverlayControls.get(img)?.show()
        activePinterestOverlayImage = img
      } else {
        activePinterestOverlayImage = null
      }
    },
    true
  )
}

// Pinterest bulk download: while the popup has a session running for this tab,
// report every page the tab visits and the pin images and videos on it. The
// background worker applies the per-page limit, skips pages already visited
// this session and does the saving.
function initPinterestBulkCollector() {
  let pageKey: string | null = null
  let collecting = false
  let includeVideos = false
  let sentKeys = new Set<string>()
  let scanTimer: number | undefined
  let urlTimer: number | undefined

  const scan = () => {
    scanTimer = undefined
    if (!collecting || !pageKey) return
    const items: { kind: BulkItemKind; id: string; alt: string }[] = []
    const add = (kind: BulkItemKind, id: string | null, alt: string) => {
      if (!id || sentKeys.has(`${kind}:${id}`)) return
      sentKeys.add(`${kind}:${id}`)
      items.push({ kind, id, alt })
    }

    const videoCards = new Set<Element>()
    if (includeVideos) {
      document
        .querySelectorAll<HTMLVideoElement | HTMLImageElement>("video[poster], img")
        .forEach((el) => {
          const id = pinVideoIdFromElement(el)
          if (!id) return
          const card = el.closest("[data-grid-item]")
          if (card) videoCards.add(card)
          add("video", id, card?.querySelector("img[alt]")?.getAttribute("alt") || "")
        })
    }
    document.querySelectorAll("img").forEach((img) => {
      // A video pin's cover image is skipped when its video is being saved.
      const card = img.closest("[data-grid-item]")
      if (card && videoCards.has(card)) return
      add("image", pinImageIdFromElement(img), img.alt || "")
    })

    if (items.length === 0) return
    const key = pageKey
    chrome.runtime.sendMessage(
      {
        action: "pinterestBulkAddItems",
        pageKey: key,
        pageUrl: window.location.href,
        items
      },
      (response) => {
        if (chrome.runtime.lastError) return
        if (pageKey === key && response?.done) collecting = false
      }
    )
  }

  const scheduleScan = () => {
    if (!collecting || scanTimer !== undefined) return
    scanTimer = window.setTimeout(scan, 400)
  }

  const enterPage = () => {
    const key = pinterestPageKey(window.location.href)
    pageKey = key
    collecting = false
    sentKeys = new Set()
    chrome.runtime.sendMessage(
      { action: "pinterestBulkEnterPage", pageKey: key },
      (response) => {
        if (chrome.runtime.lastError || pageKey !== key) return
        collecting = Boolean(response?.collect)
        includeVideos = Boolean(response?.videos)
        scheduleScan()
      }
    )
  }

  // Infinite scroll adds pins, and lazy images get their src late.
  const observer = new MutationObserver(scheduleScan)

  const setActive = (active: boolean) => {
    observer.disconnect()
    window.clearInterval(urlTimer)
    pageKey = null
    collecting = false
    if (!active) return
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "srcset", "poster"]
    })
    // Pinterest navigates without reloading the page.
    urlTimer = window.setInterval(() => {
      if (pinterestPageKey(window.location.href) !== pageKey) enterPage()
    }, 500)
    enterPage()
  }

  const sync = () =>
    chrome.runtime.sendMessage({ action: "pinterestBulkStatus" }, (response) => {
      if (chrome.runtime.lastError) return
      setActive(Boolean(response?.active))
    })

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.action !== "pinterestBulkSync") return
    sync()
    // The background treats a missing reply as "content script not loaded".
    sendResponse({ ok: true })
  })
  sync()
}

function createOverlayButton(
  mediaElement: HTMLImageElement | HTMLVideoElement
) {
  // Never show legacy single Save overlay on Pinterest pages.
  if (isPinterestPage) {
    return null
  }

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
    if (!isSaverOn("save")) {
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

    chrome.storage.local.get(["tags"], (result) => {
      const { tags } = result

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

            console.log("payload", payload)

            chrome.runtime.sendMessage(
              {
                action: "sendApiRequest",
                path: "/api/media-files/midjourney",
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

if (isPinterestPage) {
  processPinterestMediaElements()
  disablePinterestHoverOverlays()
  const pinterestObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLImageElement) {
          createPinterestOverlay(node)
        } else if (node.nodeType === 1) {
          const el = node as Element
          if (el.matches('[data-test-id="pin-card-hover-overlay"]')) {
            ;(el as HTMLElement).style.pointerEvents = "none"
            return
          }
          disablePinterestHoverOverlays(el)
          const mediaInNode = el.querySelectorAll("img")
          mediaInNode.forEach((media) => {
            if (media instanceof HTMLImageElement) {
              createPinterestOverlay(media)
            }
          })
        }
      })
    })
  })
  pinterestObserver.observe(document.body, { childList: true, subtree: true })
  initPinterestBulkCollector()
} else {
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
}
