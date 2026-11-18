// Phrasly's AI humanizer through Browse Hack, on this server's side. The
// extension does what happens on phrasly.ai (get-into-zone/lib/phraslyBridge.ts):
// one job at a time in its own Phrasly tab, one a minute, the settings read
// off the page on the first run and kept as defaults, a run's overrides put
// back after it, and a captcha handed to the user. Here the tools check a
// request before anything is sent (Phrasly takes 30 to 5,000 words a run, up
// to five drafts) and give the extension long enough to make the drafts.
//
// Used only when the user asks to humanize text or to use Phrasly.

import type { Bridge } from "./bridge.js"

/** The user's Phrasly plan takes 30 to 5,000 words a run. */
export const MIN_WORDS = 30
export const MAX_WORDS = 5000
/** Phrasly keeps up to five drafts of one text ("Next draft"). */
export const MAX_DRAFTS = 5
export const DEFAULT_DRAFTS = 3

/** One job a minute and up to 300 s a job, so a draft may take 6 minutes; the first run also opens the tab. */
const PER_DRAFT_MS = 360_000
const OVERHEAD_MS = 120_000

export const countWords = (text: string) => (String(text ?? "").match(/\S+/g) || []).length

/** Throws, saying what to do instead, when Phrasly won't take the text. */
export function checkText(text: unknown) {
  if (typeof text !== "string" || !text.trim()) throw new Error("text is empty: give the words to humanize.")
  const words = countWords(text)
  if (words < MIN_WORDS) {
    throw new Error(
      `${words} word${words === 1 ? "" : "s"} is too short for Phrasly (it needs at least ${MIN_WORDS}), so nothing was sent. ` +
        `Send it with the sentences around it to reach ${MIN_WORDS}, then keep only the part you wanted.`
    )
  }
  if (words > MAX_WORDS) {
    throw new Error(
      `${words} words is more than one Phrasly run takes (${MAX_WORDS}), so nothing was sent. Split it at paragraph breaks and humanize each part.`
    )
  }
  return words
}

export function draftCount(drafts: unknown) {
  if (drafts === undefined || drafts === null) return DEFAULT_DRAFTS
  const n = Number(drafts)
  if (!Number.isInteger(n) || n < 1 || n > MAX_DRAFTS) throw new Error(`drafts is 1 to ${MAX_DRAFTS} (Phrasly keeps up to ${MAX_DRAFTS} drafts of one text).`)
  return n
}

const MODES = ["Gentle", "Light", "Balanced", "Strong", "Max"]

/** A run's overrides, tidied: the mode by name in any case or by step 1..5, sentences Longer or Shorter. */
export function readOverrides(settings: unknown) {
  if (settings === undefined || settings === null) return undefined
  if (typeof settings !== "object") throw new Error("settings is an object: { model?, mode?, sentences? }.")
  const v = settings as Record<string, unknown>
  const out: Record<string, string> = {}
  if (typeof v.model === "string" && v.model.trim()) out.model = v.model.trim()
  if (v.mode !== undefined && v.mode !== null && String(v.mode).trim()) {
    const raw = String(v.mode).trim()
    const mode = /^\d+$/.test(raw) ? MODES[Number(raw) - 1] : MODES.find((m) => m.toLowerCase() === raw.toLowerCase())
    if (!mode) throw new Error(`mode is one of ${MODES.join(", ")} (or its step, 1 to 5), not "${raw}".`)
    out.mode = mode
  }
  if (typeof v.sentences === "string" && v.sentences.trim()) {
    const s = v.sentences.trim().toLowerCase()
    if (s !== "longer" && s !== "shorter") throw new Error(`sentences is Longer or Shorter, not "${v.sentences}".`)
    out.sentences = s === "longer" ? "Longer" : "Shorter"
  }
  return Object.keys(out).length ? out : undefined
}

/** How long to give the extension for `drafts` drafts. */
export const humanizeTimeout = (drafts: number) => OVERHEAD_MS + drafts * PER_DRAFT_MS

type Caller = Pick<Bridge, "call">

export async function humanize(bridge: Caller, params: { text?: unknown; drafts?: unknown; settings?: unknown }) {
  const words = checkText(params.text)
  const drafts = draftCount(params.drafts)
  const settings = readOverrides(params.settings)
  const result: any = await bridge.call(
    "phrasly.humanize",
    { text: params.text, drafts, ...(settings ? { settings } : {}) },
    humanizeTimeout(drafts)
  )
  // The extension counts the words as sent; the server's count is the one the limits used.
  return result && typeof result === "object" && result.ok && result.wordsIn === undefined ? { ...result, wordsIn: words } : result
}

export const phraslySettings = (bridge: Caller, params: { refresh?: boolean }) =>
  bridge.call("phrasly.settings", { refresh: params.refresh === true }, params.refresh ? 120_000 : 15_000)

export const phraslyStatus = (bridge: Caller) => bridge.call("phrasly.status", {}, 20_000)
