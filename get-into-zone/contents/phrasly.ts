import type { PlasmoCSConfig } from "plasmo"

import type { PhraslySettings, SettingKey } from "../lib/phraslyPrefs"
import {
  applySettings,
  observe,
  outline,
  pageState,
  pressAgain,
  readPageSettings,
  startDraft,
  startHumanize
} from "../lib/phrasly/page"

// Browse Hack on phrasly.ai, for the background worker (lib/phraslyBridge.ts)
// only: it does nothing on its own. Each message is one step a person would
// take on the humanizer page (read the settings, put one on, paste and press
// Humanize, ask for the next draft) or a look at what the page shows now,
// answered at once so the worker can watch a run settle. Nothing is pressed
// while Phrasly shows a captcha: that is the user's to complete in the tab.

export const config: PlasmoCSConfig = {
  matches: ["https://phrasly.ai/*"],
  run_at: "document_idle"
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))
const readDeep = (v: unknown): false | "cached" | "fresh" => (v === "fresh" || v === "cached" ? v : v === true ? "fresh" : false)

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (work: Promise<unknown> | unknown) => {
    Promise.resolve(work).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: errorText(error) })
    )
    return true
  }
  switch (msg?.action) {
    case "giz-phrasly-ping":
      sendResponse({ ok: true, ...pageState() })
      return
    case "giz-phrasly-read":
      return reply(readPageSettings(readDeep(msg.deep)))
    case "giz-phrasly-apply":
      return reply(applySettings((msg.settings ?? {}) as PhraslySettings, Array.isArray(msg.keys) ? (msg.keys as SettingKey[]) : []))
    case "giz-phrasly-humanize":
      return reply(startHumanize(String(msg.text ?? "")))
    case "giz-phrasly-draft":
      return reply(startDraft(String(msg.text ?? "")))
    case "giz-phrasly-observe":
      return reply(observe())
    case "giz-phrasly-press":
      return reply(pressAgain())
    case "giz-phrasly-probe":
      return reply(outline({ open: typeof msg.open === "string" ? msg.open : undefined, selector: typeof msg.selector === "string" ? msg.selector : undefined }))
  }
})
