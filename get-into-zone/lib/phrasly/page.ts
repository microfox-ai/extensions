// Phrasly's humanizer page, as the content script (contents/phrasly.ts)
// drives it for the background worker (lib/phraslyBridge.ts). It does one
// step at a time, the way a person would: read the settings, put one on, paste
// the text and press Humanize, ask for the next draft, read what the page
// shows. Waiting for the output to settle happens in the background worker,
// which polls `observe()`: Browse Hack's Phrasly tab sits in the background,
// where Chrome holds a page's timers to one a second, and to one a minute
// once it has been hidden for five minutes. So the waits here are on the
// page's own changes (a MutationObserver), never chains of sleeps.
//
// Ported from olympus-bridge/lib/phrasly.ts (2026-09-30 … 10-12), which drove
// this page daily. Everything that knows Phrasly's markup is here and in
// ./selectors.ts.

import type { PhraslySettings, SettingKey } from "../phraslyPrefs"
import { MODES } from "../phraslyPrefs"
import { SEL, STORAGE, SWITCH_NAMES, TEXT } from "./selectors"
import { cleanOutput, draftNumber, sameText, wordCount } from "./text"

const clean = (s: string | null | undefined, n = 80) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n)
const lower = (s: string | null | undefined) => clean(s, 200).toLowerCase()

/** A mouse press as the page's widgets hear it: pointer and mouse down and up, then the click. */
function press(el: HTMLElement) {
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true }))
  el.dispatchEvent(new MouseEvent("mousedown", at))
  el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }))
  el.dispatchEvent(new MouseEvent("mouseup", at))
  el.click()
}

function visible(el: Element | null | undefined): boolean {
  if (!el) return false
  const r = (el as HTMLElement).getBoundingClientRect?.()
  if (!r || r.width <= 0 || r.height <= 0) return false
  const cs = getComputedStyle(el as HTMLElement)
  return cs.visibility !== "hidden" && cs.display !== "none"
}

function textOf(el: Element | null | undefined): string {
  if (!el) return ""
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value
  return (el as HTMLElement).innerText ?? el.textContent ?? ""
}

const disabled = (el: Element | null | undefined) =>
  !el || (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true"

/**
 * Waits until `check` gives something truthy, looking again on every change
 * to the page (no polling), or gives up after `timeoutMs` with null.
 */
function waitFor<T>(check: () => T | null | undefined | false, timeoutMs = 3000): Promise<T | null> {
  const safe = () => {
    try {
      return check() || null
    } catch {
      return null
    }
  }
  return new Promise((resolve) => {
    const first = safe()
    if (first) return resolve(first)
    let done = false
    const finish = (value: T | null) => {
      if (done) return
      done = true
      observer.disconnect()
      clearTimeout(timer)
      resolve(value)
    }
    const observer = new MutationObserver(() => {
      const value = safe()
      if (value) finish(value)
    })
    const timer = setTimeout(() => finish(safe()), timeoutMs)
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })
  })
}

// --- What the page shows ---------------------------------------------------------------

/**
 * A captcha on the page (1 Oct 2026: "Please complete the captcha to continue
 * humanizing your document." after 52 humanizations in a day), or Cloudflare's
 * check before the page. It is the user's to complete, by hand, in the tab:
 * nothing is pressed while it shows. Returns what the page says, or null.
 */
export function captchaShown(): string | null {
  if (TEXT.challengeTitle.test(document.title)) return `Cloudflare's check ("${clean(document.title, 60)}")`
  for (const f of document.querySelectorAll<HTMLIFrameElement>(SEL.captchaFrames)) {
    if (TEXT.captchaFrame.test(`${f.src} ${f.title}`) && visible(f)) return `a captcha (${clean(f.title || f.src, 80)})`
  }
  for (const el of document.querySelectorAll("p, span, div, h1, h2, h3, label")) {
    if (el.children.length > 2) continue
    const t = clean(el.textContent, 200)
    if (t && TEXT.captcha.test(t) && visible(el)) return t
  }
  return null
}

/** What the page says when it won't do the job (credits, plan, sign-in), if it says it. */
export function refusal(): string | null {
  for (const el of document.querySelectorAll(SEL.notices)) {
    const t = clean(textOf(el), 200)
    if (t && TEXT.refusal.test(t) && visible(el)) return t
  }
  return null
}

const onHumanizer = () => TEXT.humanizerPath.test(location.pathname)

function editables(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(SEL.editables)].filter(
    (el) =>
      visible(el) &&
      !(el as HTMLTextAreaElement).readOnly &&
      el.getAttribute("aria-readonly") !== "true" &&
      !(el as HTMLTextAreaElement).disabled
  )
}

/** The box the text is pasted into: the one that asks for it, else the first editable one. */
function inputBox(): HTMLElement | null {
  const eds = editables()
  const hint = (el: HTMLElement) =>
    `${el.getAttribute("placeholder") || ""} ${el.getAttribute("aria-label") || ""} ${el.getAttribute("data-placeholder") || ""}`
  return eds.find((el) => /paste|enter|type|your text|write/i.test(hint(el))) || eds[0] || null
}

/** The Humanize button: "Humanize" or "Humanizing...", never the "Humanizer" tool switcher (a menu button). */
export function isHumanizeControl(label: string, attrs: { haspopup?: string | null; role?: string | null } = {}) {
  const opensMenu = Boolean(attrs.haspopup) && attrs.haspopup !== "false"
  return TEXT.humanize.test(clean(label, 60)) && !opensMenu && !/^menuitem/i.test(attrs.role || "")
}

function humanizeButton(): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(SEL.buttons)].filter(
    (el) => visible(el) && isHumanizeControl(textOf(el), { haspopup: el.getAttribute("aria-haspopup"), role: el.getAttribute("role") })
  )
  return all.find((el) => el.closest(SEL.humanizerContainer)) || all[0] || null
}

const outputView = () => document.getElementById(SEL.outputId)

const currentDraft = () => draftNumber(document.querySelector(SEL.currentDraft)?.getAttribute("aria-label"))

/**
 * Whether the page is signed in: false on the login page (Phrasly sends a
 * signed-out visitor there), true once the humanizer's model button or editor
 * shows, undefined while the page is still drawing itself (the first probe on
 * 11 Nov found no controls at all a moment after load).
 */
function signedIn() {
  if (TEXT.signedOutPath.test(location.pathname)) return false
  if (document.querySelector(SEL.modelButton) || inputBox() || humanizeButton()) return true
  return undefined
}

export function pageState() {
  const btn = humanizeButton()
  return {
    ready: document.readyState === "complete",
    url: location.href,
    title: document.title,
    onHumanizer: onHumanizer(),
    signedIn: signedIn(),
    captcha: captchaShown(),
    busy: Boolean(btn) && (disabled(btn) || /humanizing/i.test(textOf(btn))),
    draft: currentDraft(),
    dialogsOpened
  }
}

// --- Dialogs ---------------------------------------------------------------------------------

const panels = () => [...document.querySelectorAll<HTMLElement>(SEL.settingsPanels)].filter(visible)
const overlayOpen = () => panels().length > 0 || [...document.querySelectorAll(SEL.overlays)].some(visible)

/** Closes any open dialog or menu the way a person does: its Close or Done button, then Escape, then a click outside. */
export async function closeOverlays() {
  for (const p of panels()) {
    const close = [...p.querySelectorAll<HTMLElement>("button")].find(
      (b) => TEXT.close.test(clean(textOf(b), 20)) || /^close$/i.test(b.getAttribute("aria-label") || "")
    )
    if (close) {
      press(close)
      await waitFor(() => !p.isConnected || !visible(p), 1500)
    }
  }
  for (let i = 0; i < 2 && overlayOpen(); i++) {
    const target = document.activeElement || document.body
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true }))
    }
    if (await waitFor(() => !overlayOpen(), 800)) break
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
    document.body.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }))
    await waitFor(() => !overlayOpen(), 800)
  }
}

// --- Settings ----------------------------------------------------------------------------------

const modeSlider = () =>
  document.querySelector<HTMLInputElement>(SEL.modeSlider) || document.querySelector<HTMLInputElement>(SEL.anySlider)

function readModel(): string | undefined {
  const label = document.querySelector(SEL.modelButton)?.getAttribute("aria-label") || ""
  const name = label.replace(/^select model:\s*/i, "").trim()
  return name || undefined
}

/** The slider's step by name: its aria-valuetext, else the Ultra modes' names by step. */
function readMode(slider = modeSlider()): string | undefined {
  if (!slider) return undefined
  const text = clean(slider.getAttribute("aria-valuetext"), 40)
  if (text) return text
  const step = Number(slider.value) - Number(slider.min || 1)
  return MODES[step] ?? slider.value
}

const inPanel = (el: Element) => Boolean(el.closest(SEL.panelLike))

/** What a switch in Text settings is called: its label, else the text beside it. */
function switchLabel(el: Element): string {
  const own = el.getAttribute("aria-label")
  if (own) return clean(own, 40)
  const by = el.getAttribute("aria-labelledby")
  if (by) {
    const t = by
      .split(/\s+/)
      .map((id) => textOf(document.getElementById(id)))
      .join(" ")
    if (clean(t)) return clean(t, 40)
  }
  const label = el.closest("label")
  if (label && clean(textOf(label))) return clean(textOf(label), 40)
  let row: Element | null = el.parentElement
  for (let i = 0; row && i < 3; i++, row = row.parentElement) {
    const t = clean(textOf(row), 60)
    if (t) return t
  }
  return ""
}

const switchOn = (el: Element) =>
  el instanceof HTMLInputElement ? el.checked : el.getAttribute("aria-checked") === "true"

// Sentence length as last set on this page load (or read from the dialog when
// the page's storage didn't have it).
let sentencesKnown: string | undefined
// Dialogs opened on this page load. In a background tab a Headless UI or
// Radix dialog never finishes its opening animation, so it stays in the page
// (invisible) after Done; the worker reloads the tab after a run that opened one.
let dialogsOpened = 0

/** Text settings as the page saved them, without opening the dialog. */
function storedTextSettings(): { sentences?: string; other: Record<string, boolean> } | null {
  try {
    const raw = localStorage.getItem(STORAGE.textSettings)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || typeof v !== "object") return null
    const other: Record<string, boolean> = {}
    for (const [key, on] of Object.entries(v)) if (typeof on === "boolean") other[SWITCH_NAMES[key] ?? key] = on
    const length = typeof v.sentenceLength === "string" ? v.sentenceLength.trim().toLowerCase() : ""
    const sentences = length === "shorter" ? "Shorter" : length === "longer" ? "Longer" : undefined
    return { sentences, other }
  } catch {
    return null
  }
}

/** Opens Text settings, reads sentence length and the switches, and closes it again. */
async function readTextSettings(): Promise<{ sentences?: string; other: Record<string, boolean>; note?: string }> {
  const open = document.querySelector<HTMLElement>(SEL.textSettingsButton)
  if (!open) return { other: {}, note: "sentences: not read (no Text settings button)" }
  press(open)
  dialogsOpened++
  const ready = await waitFor(() => [...document.querySelectorAll(SEL.pressed)].some((b) => inPanel(b) && TEXT.sentences.test(clean(textOf(b), 20))), 3000)
  if (!ready) {
    await closeOverlays()
    return { other: {}, note: "sentences: not read (Text settings showed no Longer / Shorter)" }
  }
  const choice = [...document.querySelectorAll(SEL.pressed)].find(
    (b) => inPanel(b) && TEXT.sentences.test(clean(textOf(b), 20)) && b.getAttribute("aria-pressed") === "true"
  )
  const other: Record<string, boolean> = {}
  for (const el of document.querySelectorAll(SEL.switches)) {
    if (!inPanel(el) || el.matches(SEL.pressed)) continue
    const name = switchLabel(el)
    if (name && !(name in other)) other[name] = switchOn(el)
  }
  await closeTextSettings()
  sentencesKnown = choice ? clean(textOf(choice), 20) : undefined
  return { sentences: sentencesKnown, other }
}

async function closeTextSettings() {
  const done = [...document.querySelectorAll<HTMLElement>("button")].find((b) => inPanel(b) && TEXT.done.test(clean(textOf(b), 20)))
  if (done) {
    press(done)
    await waitFor(() => !overlayOpen(), 1500)
  }
  await closeOverlays()
}

/**
 * The page's settings. `deep` also reads sentence length and Text settings'
 * switches: what this page load set, else the page's saved settings
 * (localStorage), and only when neither is there, the dialog.
 */
export async function readPageSettings(deep: false | "cached" | "fresh") {
  await closeOverlays()
  const notes: string[] = []
  const settings: PhraslySettings = {}
  const model = readModel()
  if (model) settings.model = model
  else notes.push("model: not read (no model button)")
  const mode = readMode()
  if (mode) settings.mode = mode
  else notes.push("mode: not read (no Rewrite approach slider)")
  let other: Record<string, boolean> | undefined
  if (deep) {
    const saved = storedTextSettings()
    if (sentencesKnown) settings.sentences = sentencesKnown
    else if (saved?.sentences) settings.sentences = saved.sentences
    if (saved) other = saved.other
    if (!sentencesKnown && !saved) {
      const text = await readTextSettings()
      if (text.sentences) settings.sentences = text.sentences
      if (text.note) notes.push(text.note)
      other = text.other
    }
  }
  return { settings, other, notes }
}

const sameName = (a?: string, b?: string) => lower(a) === lower(b)

async function setModel(name: string): Promise<string | null> {
  const want = name.trim().toLowerCase()
  const trigger = document.querySelector<HTMLElement>(SEL.modelButton)
  if (!trigger) return "model: no model button"
  if (sameName(readModel(), name)) return null
  press(trigger)
  dialogsOpened++
  const option = await waitFor(
    () => [...document.querySelectorAll<HTMLElement>(SEL.modelOptions)].find((b) => lower(textOf(b)).startsWith(want)),
    3000
  )
  if (!option) {
    await closeOverlays()
    return `model: no "${name}" in the model dialog`
  }
  press(option)
  const ok = await waitFor(() => sameName(readModel(), name), 3000)
  await closeOverlays()
  return ok ? null : `model: still "${readModel() ?? "none"}" after choosing "${name}"`
}

function setSlider(slider: HTMLInputElement, value: number) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(slider, String(value))
  slider.dispatchEvent(new Event("input", { bubbles: true }))
  slider.dispatchEvent(new Event("change", { bubbles: true }))
}

/** Moves the Rewrite approach slider to the step named `name` (its first guess is the Ultra modes' order). */
async function setMode(name: string): Promise<string | null> {
  const slider = modeSlider()
  if (!slider) return "mode: no Rewrite approach slider"
  if (sameName(readMode(slider), name)) return null
  const min = Number(slider.min || 1)
  const max = Number(slider.max || MODES.length)
  const guess = MODES.findIndex((m) => sameName(m, name))
  const tries = [...(guess >= 0 ? [min + guess] : []), ...Array.from({ length: max - min + 1 }, (_, i) => min + i)].filter(
    (v, i, all) => v >= min && v <= max && all.indexOf(v) === i
  )
  for (const value of tries) {
    setSlider(slider, value)
    if (await waitFor(() => sameName(readMode(slider), name), 1200)) return null
  }
  return `mode: the slider has no "${name}" step (it shows "${readMode(slider) ?? "?"}")`
}

/** Picks Longer or Shorter in Text settings; says what was on before. */
async function setSentences(choice: string): Promise<{ problem: string | null; before?: string }> {
  const open = document.querySelector<HTMLElement>(SEL.textSettingsButton)
  if (!open) return { problem: "sentences: no Text settings button" }
  press(open)
  dialogsOpened++
  const options = await waitFor(() => {
    const all = [...document.querySelectorAll<HTMLElement>(SEL.pressed)].filter((b) => inPanel(b) && TEXT.sentences.test(clean(textOf(b), 20)))
    return all.length ? all : null
  }, 3000)
  const before = options?.find((b) => b.getAttribute("aria-pressed") === "true")
  const beforeName = before ? clean(textOf(before), 20) : undefined
  const btn = options?.find((b) => sameName(clean(textOf(b), 40), choice))
  let problem: string | null = null
  if (!btn) problem = `sentences: no "${choice}" in Text settings`
  else if (btn.getAttribute("aria-pressed") !== "true") {
    press(btn)
    if (!(await waitFor(() => btn.getAttribute("aria-pressed") === "true", 1500))) problem = `sentences: "${choice}" didn't stay on`
  }
  await closeTextSettings()
  if (!problem) sentencesKnown = btn ? clean(textOf(btn), 20) : choice
  return { problem, before: beforeName }
}

/**
 * Puts `keys` of `wanted` on the page and says what each was before, so the
 * worker can put them back after the run. Nothing is changed while a captcha
 * shows.
 */
export async function applySettings(wanted: PhraslySettings, keys: SettingKey[]) {
  if (captchaShown()) return { before: {}, changed: [], failed: ["a captcha is showing: nothing was changed"], captcha: true }
  await closeOverlays()
  const before: PhraslySettings = {}
  const changed: SettingKey[] = []
  const failed: string[] = []
  // The model first: the other settings may depend on it.
  for (const key of (["model", "mode", "sentences"] as SettingKey[]).filter((k) => keys.includes(k))) {
    const value = wanted[key]
    if (!value) continue
    if (key === "sentences") {
      const r = await setSentences(value)
      if (r.problem) failed.push(r.problem)
      else if (!sameName(r.before, value)) {
        if (r.before) before.sentences = r.before
        changed.push(key)
      }
      continue
    }
    const now = key === "model" ? readModel() : readMode()
    if (sameName(now, value)) continue
    const problem = key === "model" ? await setModel(value) : await setMode(value)
    if (problem) failed.push(problem)
    else {
      if (now) before[key] = now
      changed.push(key)
    }
  }
  return { before, changed, failed }
}

// --- A run -------------------------------------------------------------------------------------

/** Puts the text in the editor the way a paste does, so the page's own editor state sees it. */
async function setText(el: HTMLElement, text: string) {
  el.focus()
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new Event("change", { bubbles: true }))
    return
  }
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  sel?.removeAllRanges()
  sel?.addRange(range)
  let ok = false
  try {
    ok = document.execCommand("insertText", false, text)
  } catch {
    ok = false
  }
  const landed = () => wordCount(textOf(el)) >= wordCount(text) * 0.9 && sameText(textOf(el), text)
  if (!ok || !(await waitFor(landed, 1500))) {
    const dt = new DataTransfer()
    dt.setData("text/plain", text)
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }))
  }
  if (!(await waitFor(landed, 1500))) {
    el.textContent = text
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
  }
}

/** The output: the page's own output view, else the container whose text is new since the run started. */
function outputElement(): HTMLElement | null {
  const mapped = outputView()
  if (mapped) return mapped
  if (!watch) return null
  const { input, before, inWords } = watch
  let best: HTMLElement | null = null
  for (const el of document.querySelectorAll<HTMLElement>("textarea, [contenteditable], [role=\"textbox\"], article, section, div, p")) {
    if (el === input || el.contains(input) || input.contains(el) || !visible(el)) continue
    const t = textOf(el)
    const n = wordCount(t)
    if (n < inWords * 0.5 || n > inWords * 2.5 || before.get(el) === t) continue
    if (!best || best.contains(el)) best = el
  }
  return best
}

// What the current run needs to find its output when the page has no output view.
let watch: { input: HTMLElement; before: Map<Element, string>; inWords: number } | null = null

function snapshot() {
  const before = new Map<Element, string>()
  for (const el of document.querySelectorAll("textarea, [contenteditable], [role=\"textbox\"], article, section, div, p")) before.set(el, textOf(el))
  return before
}

export type StartResult =
  | { started: true; before: string; beforeDraft: number | null; inWords: number; note: string }
  | { captcha: string }
  | { error: string }
  | { fallback: string }

/** Pastes the text and presses Humanize; the worker then watches the output (observe). */
export async function startHumanize(text: string): Promise<StartResult> {
  if (!onHumanizer()) return { error: `the Phrasly tab is on ${location.pathname}, not the humanizer` }
  const cap = captchaShown()
  if (cap) return { captcha: cap }
  await closeOverlays()
  const input = inputBox()
  if (!input) return { error: "no text box on Phrasly's humanizer (signed out, or the page changed: run phrasly.probe)" }
  await setText(input, text)
  const landed = wordCount(textOf(input))
  if (landed < wordCount(text) * 0.9) return { error: `the text didn't land in Phrasly's box (${landed} of ${wordCount(text)} words)` }
  const before = cleanOutput(textOf(outputView()))
  const beforeDraft = currentDraft()
  watch = { input, before: snapshot(), inWords: wordCount(text) }
  const btn = await waitFor(() => {
    const b = humanizeButton()
    return b && !disabled(b) ? b : null
  }, 5000)
  if (!btn) return { error: `no Humanize button to press${refusal() ? ` (the page says: ${refusal()})` : ""}` }
  btn.click()
  return { started: true, before, beforeDraft, inWords: wordCount(text), note: `pressed Humanize ("${clean(textOf(btn), 30)}")` }
}

/**
 * Asks the page for its next draft of the text it holds. When the page no
 * longer holds this text, or has no next draft, says so (fallback) and the
 * worker humanizes afresh.
 */
export async function startDraft(text: string): Promise<StartResult> {
  if (!onHumanizer()) return { error: `the Phrasly tab is on ${location.pathname}, not the humanizer` }
  const cap = captchaShown()
  if (cap) return { captcha: cap }
  await closeOverlays()
  const input = inputBox()
  if (!input) return { error: "no text box on Phrasly's humanizer (signed out, or the page changed: run phrasly.probe)" }
  if (!sameText(textOf(input), text)) return { fallback: "the page no longer holds this text" }
  const next = document.querySelector<HTMLElement>(SEL.nextDraft)
  const beforeDraft = currentDraft()
  if (!next || disabled(next)) return { fallback: `no next draft to ask for (${beforeDraft ? `Draft ${beforeDraft} is the last` : "no drafts shown"})` }
  const before = cleanOutput(textOf(outputView()))
  watch = { input, before: snapshot(), inWords: wordCount(text) }
  press(next)
  return { started: true, before, beforeDraft, inWords: wordCount(text), note: `asked for the draft after ${beforeDraft ? `Draft ${beforeDraft}` : "the first"}` }
}

/** What the worker watches while a run settles: answered at once, from the page as it is. */
export function observe() {
  const out = outputElement()
  const btn = humanizeButton()
  return {
    output: cleanOutput(textOf(out)),
    busy: !btn || disabled(btn) || /humanizing/i.test(textOf(btn)),
    captcha: captchaShown(),
    refusal: refusal(),
    draft: currentDraft()
  }
}

/** Presses Humanize again (the worker asks when nothing appeared 45 s after the press). */
export function pressAgain() {
  const btn = humanizeButton()
  if (!btn || disabled(btn)) return false
  btn.click()
  return true
}

// --- The probe: what the page is now, read-only -----------------------------------------

function attrsOf(el: Element) {
  const o: Record<string, string> = {}
  for (const a of Array.from(el.attributes)) {
    if (/^(id|name|type|role|placeholder|aria-[a-z-]+|data-[a-z-]+|value|title|for|disabled|contenteditable|maxlength|min|max)$/.test(a.name)) {
      o[a.name] = a.value.slice(0, 140)
    }
  }
  return o
}

function pathOf(el: Element) {
  const parts: string[] = []
  let e: Element | null = el
  for (let depth = 0; e && e !== document.body && depth < 7; depth++) {
    let p = e.tagName.toLowerCase()
    if (e.id) {
      parts.unshift(`${p}#${e.id}`)
      break
    }
    const cls = (e.getAttribute("class") || "").split(/\s+/).filter(Boolean).slice(0, 2)
    if (cls.length) p += `.${cls.join(".")}`
    parts.unshift(p)
    e = e.parentElement
  }
  return parts.join(" > ")
}

const KEYWORDS = /ultra|aggress|strength|approach|sentence|shorter|longer|mode|model|humaniz|words?\b|credit|limit|upgrade|plan|output|draft|captcha|settings?/i

/**
 * Describes the page for fixing selectors.ts: its fields, controls and short
 * texts about settings. `open` presses the control with exactly that text first
 * (never Humanize) and closes what it opened; `selector` returns one element's HTML.
 */
export async function outline(opts: { open?: string; selector?: string }) {
  let opened: string | null = null
  if (opts.open && !/humaniz/i.test(opts.open)) {
    const want = opts.open.toLowerCase()
    const hit = [...document.querySelectorAll<HTMLElement>('button, [role="button"], [role="combobox"], [role="tab"]')].find(
      (el) => visible(el) && (lower(textOf(el)) === want || (el.getAttribute("aria-label") || "").toLowerCase() === want)
    )
    if (hit) {
      press(hit)
      opened = pathOf(hit)
      await waitFor(overlayOpen, 1500)
    } else opened = "not found"
  }
  const fields = [...document.querySelectorAll(`${SEL.editables}, input, select`)].slice(0, 40).map((el) => ({
    tag: el.tagName.toLowerCase(),
    path: pathOf(el),
    attrs: attrsOf(el),
    visible: visible(el),
    words: wordCount(textOf(el)),
    sample: clean(textOf(el), 120)
  }))
  const controls = [...document.querySelectorAll('button, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="checkbox"], [role="combobox"], [role="option"], [role="menuitem"], [role="slider"], label')]
    .filter(visible)
    .slice(0, 200)
    .map((el) => ({ tag: el.tagName.toLowerCase(), text: clean(textOf(el), 80), attrs: attrsOf(el), path: pathOf(el), disabled: disabled(el) }))
  const texts: { tag: string; text: string }[] = []
  for (const el of document.querySelectorAll("body *")) {
    if (texts.length >= 120) break
    if (el.children.length > 3 || !visible(el)) continue
    const t = clean(el.textContent, 120)
    if (t && t.length <= 100 && KEYWORDS.test(t)) texts.push({ tag: el.tagName.toLowerCase(), text: t })
  }
  const dialogs = [...document.querySelectorAll(`${SEL.overlays}, ${SEL.settingsPanels}`)]
    .filter(visible)
    .map((el) => ({ role: el.getAttribute("role"), path: pathOf(el), html: el.outerHTML.slice(0, 12000) }))
  let selected: string | null = null
  if (opts.selector) {
    try {
      selected = document.querySelector(opts.selector)?.outerHTML.slice(0, 30000) ?? "no element matches"
    } catch (e) {
      selected = `bad selector: ${String(e)}`
    }
  }
  if (opened && opened !== "not found") await closeOverlays()
  return { ...pageState(), opened, dialogs, fields, controls, texts, selected, storage: settingsStorage() }
}

/**
 * The page's own saved preferences in localStorage, for the probe: only keys
 * that name a setting, never ones that look like a sign-in or a key.
 */
function settingsStorage() {
  const out: Record<string, string> = {}
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i) || ""
      if (/token|auth|session|secret|password|key\b|jwt|cookie|user|posthog|^ph_|analytics/i.test(key)) continue
      const value = localStorage.getItem(key) || ""
      if (/setting|sentence|comma|grammar|proofread|ultra|mode|model|humaniz|rewrite|approach|neo/i.test(`${key} ${value.slice(0, 400)}`)) {
        out[key] = value.slice(0, 400)
      }
    }
  } catch {
    // storage may be blocked
  }
  return out
}
