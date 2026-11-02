import type { PlasmoCSConfig } from "plasmo"

// Runs in suno.com's own page (not the extension's isolated world) before the
// site's code, so it sees the answer to the site's own Create request: the ids
// of the two songs it started, or why it was refused (captcha, credits). Only
// those reach the content script (contents/suno.ts); request headers, tokens
// and bodies never leave the page. It also sets the lyrics editor's text and
// catches Suno's file picker for an upload, when the content script asks.

export const config: PlasmoCSConfig = {
  matches: ["https://suno.com/*"],
  world: "MAIN",
  run_at: "document_start"
}

const GENERATE = /\/api\/generate\/(v2-web|v2|concat|upsample)/
const SOURCE = "browse-hack-suno"

function clipIdsOf(body: any): string[] {
  const clips = Array.isArray(body?.clips) ? body.clips : Array.isArray(body) ? body : []
  return clips.map((clip: any) => clip?.id).filter((id: unknown) => typeof id === "string")
}

function report(url: string, status: number, body: any) {
  const ids = clipIdsOf(body)
  const detail =
    typeof body?.detail === "string"
      ? body.detail
      : typeof body?.detail?.message === "string"
        ? body.detail.message
        : typeof body?.message === "string"
          ? body.message
          : typeof body?.error === "string"
            ? body.error
            : undefined
  window.postMessage(
    {
      source: SOURCE,
      type: "generate",
      endpoint: new URL(url, location.href).pathname,
      ok: status >= 200 && status < 300 && ids.length > 0,
      status,
      clipIds: ids,
      batchId: typeof body?.id === "string" ? body.id : undefined,
      detail: detail?.slice(0, 300)
    },
    location.origin
  )
}

// The lyrics box is a Lexical editor, which ignores text typed from outside
// (line breaks get lost). The content script asks here, where the editor
// object lives, to set the lyrics: one paragraph per line, blank lines kept.
window.addEventListener("message", (event) => {
  const data = event.data
  if (event.source !== window || data?.source !== "browse-hack-suno-cs" || data.type !== "set-lyrics") return
  const answer = (ok: boolean, error?: string) =>
    window.postMessage({ source: SOURCE, type: "lyrics-set", id: data.id, ok, error }, location.origin)
  try {
    const root = document.querySelector('[aria-label="Lyrics editor"]') as any
    const editor = root?.__lexicalEditor
    if (!editor?.parseEditorState) return answer(false, "no Lexical editor on the lyrics box")
    const paragraph = (text: string) => ({
      children: text ? [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }] : [],
      direction: text ? "ltr" : null,
      format: "",
      indent: 0,
      type: "paragraph",
      version: 1,
      textFormat: 0,
      textStyle: ""
    })
    const lines = String(data.text ?? "").replace(/\r/g, "").split("\n")
    const state = { root: { children: lines.map(paragraph), direction: "ltr", format: "", indent: 0, type: "root", version: 1 } }
    editor.setEditorState(editor.parseEditorState(JSON.stringify(state)))
    answer(true)
  } catch (error) {
    answer(false, error instanceof Error ? error.message : String(error))
  }
})

// Suno opens its file picker by clicking a file input its code made, often one
// that isn't in the page. To cover a library track, the content script arms
// this first: the next file input Suno clicks gets marked (and put in the page,
// hidden) instead of opening the picker, so the content script can give it the
// file. Unarmed, or after ten seconds, every click goes through as usual.
let pickerArmedUntil = 0
window.addEventListener("message", (event) => {
  const data = event.data
  if (event.source === window && data?.source === "browse-hack-suno-cs" && data.type === "arm-file-input") {
    pickerArmedUntil = Date.now() + 10_000
  }
})
const originalClick = HTMLInputElement.prototype.click
HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
  if (this.type !== "file" || Date.now() > pickerArmedUntil) return originalClick.call(this)
  pickerArmedUntil = 0
  if (!this.isConnected) {
    this.hidden = true
    document.body.appendChild(this)
  }
  this.setAttribute("data-browse-hack-file", "")
}

const originalFetch = window.fetch
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const response = await originalFetch.call(this, input, init)
  try {
    const url = input instanceof Request ? input.url : String(input)
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (method === "POST" && GENERATE.test(url)) {
      response
        .clone()
        .json()
        .then(
          (body) => report(url, response.status, body),
          () => report(url, response.status, null)
        )
    }
  } catch {
    // Never get in the way of the site's own request.
  }
  return response
}

const originalOpen = XMLHttpRequest.prototype.open
XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: any[]) {
  if (String(method).toUpperCase() === "POST" && GENERATE.test(String(url))) {
    this.addEventListener("load", () => {
      let body: any = null
      try {
        body = JSON.parse(this.responseText)
      } catch {
        // not JSON
      }
      report(String(url), this.status, body)
    })
  }
  return (originalOpen as any).call(this, method, url, ...rest)
}
