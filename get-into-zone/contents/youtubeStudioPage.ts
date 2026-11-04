import type { PlasmoCSConfig } from "plasmo"

// Runs in YouTube Studio's own page (not the extension's isolated world). A
// thumbnail the content script (contents/youtubeStudio.ts) hands to Studio's file
// input from the isolated world gets as far as Studio's preview, then its upload
// to YouTube fails; the same file set from here goes up. The content script marks
// the input and posts the file; this sets it. It also reads a thumbnail editor's
// error message, which only Studio's own element properties hold.

export const config: PlasmoCSConfig = {
  matches: ["https://studio.youtube.com/*"],
  world: "MAIN",
  run_at: "document_idle"
}

const SOURCE = "browse-hack-ytstudio"
const ERROR_PROPS = ["uploadErrorMessage", "errorMessage", "permanentErrorMessage"]

window.addEventListener("message", (event) => {
  const data = event.data
  if (event.source !== window || data?.source !== "browse-hack-ytstudio-cs" || typeof data.id !== "string") return
  const answer = (reply: Record<string, unknown>) =>
    window.postMessage({ source: SOURCE, type: `${data.type}-done`, id: data.id, ...reply }, location.origin)
  const target = document.querySelector(`[data-browse-hack-target="${CSS.escape(data.id)}"]`)

  if (data.type === "set-file") {
    if (!(target instanceof HTMLInputElement) || !(data.file instanceof File)) {
      return answer({ ok: false, error: "no file input or no file" })
    }
    try {
      const transfer = new DataTransfer()
      transfer.items.add(data.file)
      target.files = transfer.files
      target.dispatchEvent(new Event("change", { bubbles: true }))
      answer({ ok: true })
    } catch (error) {
      answer({ ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  if (data.type === "read-errors") {
    const element = target as unknown as Record<string, unknown> | null
    const errors = ERROR_PROPS.map((key) => element?.[key]).filter(
      (value): value is string => typeof value === "string" && !!value.trim()
    )
    answer({ ok: !!element, errors: [...new Set(errors)] })
  }
})
