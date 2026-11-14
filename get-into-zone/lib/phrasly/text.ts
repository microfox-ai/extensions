// Phrasly's limits and the text that comes back from it, with no page or
// Chrome in sight so the tests can run on it (lib/phrasly.test.mjs). The MCP
// server checks the same limits before it sends anything
// (mcp/src/phrasly.ts); these are the extension's own second check.

/** Phrasly takes 30 to 5,000 words a run on the user's plan. */
export const MIN_WORDS = 30
export const MAX_WORDS = 5000
/** The page keeps up to five drafts of one text ("Next draft"). */
export const MAX_DRAFTS = 5

export const wordCount = (text: string) => (String(text ?? "").match(/\S+/g) || []).length

/** Whether Phrasly will take this text, and if not, what to do instead. */
export function checkWords(text: string, min = MIN_WORDS, max = MAX_WORDS) {
  const words = wordCount(text)
  if (words < min) {
    return {
      ok: false as const,
      words,
      error:
        `${words} word${words === 1 ? "" : "s"} is too short for Phrasly (it needs at least ${min}). ` +
        `Send it with the sentences around it to reach ${min}, then keep only the part you wanted.`
    }
  }
  if (words > max) {
    return {
      ok: false as const,
      words,
      error: `${words} words is more than one Phrasly run takes (${max}). Split it at paragraph breaks and humanize each part.`
    }
  }
  return { ok: true as const, words }
}

/** The same words, whatever the spacing: the page's editor rewraps what it's given. */
export const sameText = (a: string, b: string) =>
  String(a ?? "").replace(/\s+/g, " ").trim() === String(b ?? "").replace(/\s+/g, " ").trim()

/**
 * The output as the page shows it (innerText of the output view, a block of
 * sentence spans), tidied: no zero-width or non-breaking spaces, no spaces
 * before punctuation the spans leave behind, single spaces inside lines, and
 * paragraphs kept as one blank line between them.
 */
export function cleanOutput(raw: string) {
  return String(raw ?? "")
    .replace(/[​-‍﻿]/g, "")
    .replace(/ /g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/ ([,.;:!?])/g, "$1").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** "Draft 3" (a draft button's label, or "Draft 3 of 5") → 3. */
export function draftNumber(label: string | null | undefined) {
  const m = String(label ?? "").match(/^\s*draft\s+(\d+)\b/i)
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 && n <= 99 ? n : null
}

export interface PhraslyDraft {
  /** Which draft of the text the page showed it as (1 for the first humanization). */
  draft: number
  text: string
  words: number
  /** Set when the page gave back the same words as an earlier draft. */
  sameAs?: number
}

/**
 * Adds one output to the drafts collected so far: numbered as the page
 * numbered it when it said (else the next number), and marked when it repeats
 * an earlier draft word for word.
 */
export function addDraft(drafts: PhraslyDraft[], raw: string, pageNumber?: number | null): PhraslyDraft[] {
  const text = cleanOutput(raw)
  const used = new Set(drafts.map((d) => d.draft))
  let draft = pageNumber && !used.has(pageNumber) ? pageNumber : 0
  if (!draft) draft = Math.max(0, ...drafts.map((d) => d.draft)) + 1
  const twin = drafts.find((d) => sameText(d.text, text))
  return [...drafts, { draft, text, words: wordCount(text), ...(twin ? { sameAs: twin.draft } : {}) }]
}

// --- Watching a run settle -------------------------------------------------------------
//
// The background worker asks the page what it shows once a second
// (page.ts observe) and feeds each answer through watchStep. An output counts
// once it is new since the press (other words than before, or another draft
// number), between half and two and a half times the input's length, unchanged
// for settleMs, with the Humanize button free again. A first humanization that
// shows nothing 45 s after the press, with the button free, is pressed once
// more, as a person would (1 Oct 2026: a press that produced nothing).

export interface WatchObservation {
  output: string
  busy: boolean
  captcha: string | null
  refusal: string | null
  draft: number | null
}

export interface WatchState {
  startedAt: number
  /** The output view's text and draft number just before the press. */
  before: string
  beforeDraft: number | null
  inWords: number
  last: string
  stableSince: number
  repressed: boolean
}

export type WatchStep =
  | { kind: "wait"; state: WatchState }
  | { kind: "repress"; state: WatchState }
  | { kind: "done"; state: WatchState; output: string; draft: number | null; seconds: number }
  | { kind: "captcha"; detail: string }
  | { kind: "refused"; detail: string }
  | { kind: "timeout"; detail: string }

export const startWatch = (s: { before: string; beforeDraft: number | null; inWords: number }, now: number): WatchState => ({
  startedAt: now,
  before: s.before,
  beforeDraft: s.beforeDraft,
  inWords: s.inWords,
  last: "",
  stableSince: 0,
  repressed: false
})

/** Whether the output view holds this run's output rather than an earlier one or a partial one. */
export function isNewOutput(state: Pick<WatchState, "before" | "beforeDraft" | "inWords">, obs: Pick<WatchObservation, "output" | "draft">) {
  const n = wordCount(obs.output)
  if (!n || n < state.inWords * 0.5 || n > state.inWords * 2.5) return false
  return !sameText(obs.output, state.before) || (obs.draft != null && obs.draft !== state.beforeDraft)
}

export function watchStep(
  state: WatchState,
  obs: WatchObservation,
  now: number,
  opts: { timeoutMs?: number; settleMs?: number; repressAfterMs?: number; canRepress?: boolean } = {}
): WatchStep {
  const { timeoutMs = 300_000, settleMs = 4000, repressAfterMs = 45_000, canRepress = false } = opts
  const elapsed = now - state.startedAt
  if (obs.captcha) return { kind: "captcha", detail: obs.captcha }
  if (obs.refusal && elapsed > 1500) return { kind: "refused", detail: obs.refusal }
  const current = isNewOutput(state, obs) ? obs.output : ""
  const next: WatchState = { ...state }
  if (current && current === state.last) {
    if (!next.stableSince) next.stableSince = now
    if (now - next.stableSince >= settleMs && !obs.busy) {
      return { kind: "done", state: next, output: current, draft: obs.draft, seconds: Math.round(elapsed / 1000) }
    }
  } else {
    next.stableSince = 0
    next.last = current
  }
  if (elapsed >= timeoutMs) {
    const shown = obs.output ? `"${obs.output.slice(0, 120)}"` : "nothing"
    return {
      kind: "timeout",
      detail:
        `no settled output from Phrasly within ${Math.round(timeoutMs / 1000)} s (the output view shows ${shown}; ` +
        `Humanize ${obs.busy ? "still busy" : "free"}${state.repressed ? "; pressed twice" : ""})`
    }
  }
  if (canRepress && !state.repressed && !next.last && !obs.busy && elapsed > repressAfterMs) {
    next.repressed = true
    return { kind: "repress", state: next }
  }
  return { kind: "wait", state: next }
}
