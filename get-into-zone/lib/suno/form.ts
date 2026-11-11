// Suno's Create form, driven the way a person would: Browse Hack fills the
// fields, picks the model and workspace, attaches audio and clicks Create, so
// suno.com runs its own checks (including its captcha) on every song. Runs in
// the suno.com content script. Values are set through the element's native
// setter, which both React and this isolated world see.

import { CONDITIONS, DOWNLOAD, ROW, SEL, SLIDERS, TEXT, UPLOAD } from "./selectors"

export interface SunoFormJob {
  lyrics?: string
  instrumental?: boolean
  styles?: string
  excludeStyles?: string
  title?: string
  /** v6, v6-wild, v6-mini, as the model menu names them. */
  model?: string
  vocalGender?: "male" | "female"
  /** 0-100. */
  weirdness?: number
  styleInfluence?: number
  audioInfluence?: number
  /** The Variety slider's own value. */
  variety?: number
  maxMode?: boolean
  myTaste?: boolean
  /** The workspace's name, checked against the form's workspace button. */
  workspaceName?: string
  /** Cover, Extend… for the audio condition. */
  condition?: string
  /** Extend from this many seconds into the song. */
  extendFrom?: number
}

export interface SunoFormState {
  ready: boolean
  advanced: boolean
  /** The model button's text, as the menu names it (v6-wild). */
  model?: string
  credits?: number
  workspace?: string
  condition?: string
  title?: string
  styles?: string
  excludeStyles?: string
  lyrics?: string
  sliders: Record<string, number | undefined>
  createEnabled: boolean
  captcha: boolean
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor<T>(find: () => T | null | undefined | false, timeoutMs = 10_000, everyMs = 200) {
  const start = Date.now()
  for (;;) {
    const found = find()
    if (found) return found
    if (Date.now() - start > timeoutMs) return null
    await sleep(everyMs)
  }
}

const text = (el: Element | null | undefined) => ((el as HTMLElement | null)?.innerText ?? el?.textContent ?? "").trim()
const firstLine = (el: Element) => text(el).split("\n")[0].trim()
const norm = (value: string) => value.replace(/\r/g, "").replace(/\s+/g, " ").trim().toLowerCase()

export const visible = (el: Element | null | undefined): el is HTMLElement => {
  if (!el) return false
  const rect = el.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility !== "hidden"
}

/**
 * A visible menu or dialog that isn't closing. A closed dialog stays in the page
 * until its exit animation ends, which never happens in a background tab, where
 * Browse Hack's Suno tabs run: Base UI (the upload dialog) marks it data-closed /
 * data-ending-style, Radix data-state="closed".
 */
const isOpen = (el: Element | null | undefined): el is HTMLElement =>
  visible(el) &&
  !el.hasAttribute("data-closed") &&
  !el.hasAttribute("data-ending-style") &&
  el.getAttribute("data-state") !== "closed"

/** The Create panel: the nearest box holding both the Create button and the lyrics. */
export function createPanel(): HTMLElement | null {
  const create = document.querySelector(SEL.createButton)
  const lyrics = document.querySelector(SEL.lyrics)
  if (!create) return null
  if (!lyrics) return create.closest("form") ?? (create.parentElement?.parentElement as HTMLElement | null)
  let node: HTMLElement | null = create.parentElement
  while (node && !node.contains(lyrics)) node = node.parentElement
  return node
}

function within<T extends Element>(root: ParentNode, selector: string) {
  return Array.from(root.querySelectorAll<T>(selector))
}

/** A button in the panel by its visible text (first line). */
function buttonByText(root: ParentNode, label: string) {
  return within<HTMLButtonElement>(root, "button").find((b) => firstLine(b) === label)
}

/** The buttons of a More Options row ("Vocal Gender": Male / Female). */
function rowButtons(panel: HTMLElement, label: string) {
  // The page also keeps a hidden copy of each row (no size, its buttons carry no
  // data-selected): the live row is the one whose buttons say whether they're on.
  const rows: HTMLButtonElement[][] = []
  for (const leaf of within<HTMLElement>(panel, "div, span, label, p")) {
    if (leaf.children.length !== 0 || text(leaf) !== label) continue
    let box: HTMLElement | null = leaf
    for (let i = 0; box && i < 5; i++) {
      const buttons = within<HTMLButtonElement>(box, "button")
      if (buttons.length >= 2) {
        rows.push(buttons)
        break
      }
      box = box.parentElement
    }
  }
  const live = (buttons: HTMLButtonElement[]) =>
    buttons.some((b) => b.hasAttribute("data-selected") || b.hasAttribute("aria-pressed") || b.hasAttribute("aria-checked"))
  return rows.find(live) ?? rows.find((buttons) => buttons.some(visible)) ?? rows[0] ?? []
}

/** Whether a toggle-style button is the selected one. */
function isOn(button: HTMLElement) {
  const attrs = ["aria-pressed", "aria-checked", "aria-selected"].map((a) => button.getAttribute(a))
  if (attrs.includes("true")) return true
  if (attrs.includes("false")) return false
  const state = button.getAttribute("data-state") ?? ""
  if (/^(on|active|checked|selected)$/.test(state)) return true
  if (/^(off|inactive|unchecked)$/.test(state)) return false
  for (const flag of ["data-selected", "data-active"]) {
    const value = button.getAttribute(flag)
    if (value !== null) return value !== "false"
  }
  // Segmented buttons often mark the chosen one only by its colours.
  const siblings = Array.from(button.parentElement?.querySelectorAll("button") ?? [])
  const mine = getComputedStyle(button).backgroundColor
  const others = siblings.filter((b) => b !== button).map((b) => getComputedStyle(b).backgroundColor)
  const transparent = (c: string) => c === "rgba(0, 0, 0, 0)" || c === "transparent"
  return others.length > 0 && !transparent(mine) && others.every((c) => transparent(c) || c !== mine)
}

/** Sets an input's or textarea's value so React sees the change. */
export function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = Object.getPrototypeOf(el)
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set
  el.focus()
  if (setter) setter.call(el, value)
  else el.value = value
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
}

/** The lyrics as lines: one per paragraph of the editor. */
export function lyricsText(editor = document.querySelector<HTMLElement>(SEL.lyrics)) {
  if (!editor) return undefined
  const paragraphs = Array.from(editor.querySelectorAll("p"))
  return paragraphs.length ? paragraphs.map((p) => p.textContent ?? "").join("\n") : (editor.textContent ?? "")
}

/** Asks contents/sunoPage.ts, in the page itself, to do something; resolves with its answer, or null if none comes. */
function askPage(type: string, reply: string, extra: Record<string, unknown> = {}) {
  const id = Math.random().toString(36).slice(2)
  return new Promise<any>((resolve) => {
    const done = (answer: any) => {
      clearTimeout(timer)
      window.removeEventListener("message", onMessage)
      resolve(answer)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source === window && event.data?.source === "browse-hack-suno" && event.data.type === reply && event.data.id === id) {
        done(event.data)
      }
    }
    const timer = setTimeout(() => done(null), 2000)
    window.addEventListener("message", onMessage)
    window.postMessage({ source: "browse-hack-suno-cs", type, id, ...extra }, location.origin)
  })
}

/** Sets the Lexical editor's text from the page. */
const setLyricsInPage = async (value: string) => Boolean((await askPage("set-lyrics", "lyrics-set", { text: value }))?.ok)

/** Replaces the lyrics: through the page's editor, else by typing (which loses line breaks). */
export async function setLyrics(value: string) {
  const editor = document.querySelector<HTMLElement>(SEL.lyrics)
  if (!editor) return false
  const lines = (text: string) => text.replace(/\r/g, "").split("\n").map((l) => l.trim()).join("\n").trim()
  const matches = () => lines(lyricsText(editor) ?? "") === lines(value)
  if (await setLyricsInPage(value)) {
    await sleep(150)
    if (matches()) return true
  }
  editor.focus()
  const range = document.createRange()
  range.selectNodeContents(editor)
  window.getSelection()?.removeAllRanges()
  window.getSelection()?.addRange(range)
  document.execCommand(value ? "insertText" : "delete", false, value)
  await sleep(150)
  return matches()
}

const key = (el: HTMLElement, name: string) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: name, code: name, bubbles: true, cancelable: true }))
  el.dispatchEvent(new KeyboardEvent("keyup", { key: name, code: name, bubbles: true, cancelable: true }))
}

/** Moves a slider with its keyboard keys, the way the site's own sliders allow. */
export async function setSlider(panel: HTMLElement, label: string, target: number) {
  const slider = panel.querySelector<HTMLElement>(SEL.slider(label))
  if (!slider) return false
  const read = () => Number(slider.getAttribute("aria-valuenow"))
  const min = Number(slider.getAttribute("aria-valuemin") ?? 0)
  const max = Number(slider.getAttribute("aria-valuemax") ?? 100)
  const goal = Math.min(max, Math.max(min, Math.round(target)))
  slider.focus()
  for (let guard = 0; guard < 220 && read() !== goal; guard++) {
    const before = read()
    const gap = goal - before
    key(slider, Math.abs(gap) >= 10 && max - min >= 50 ? (gap > 0 ? "PageUp" : "PageDown") : gap > 0 ? "ArrowRight" : "ArrowLeft")
    await sleep(15)
    if (read() === before) {
      // PageUp may be ignored; fall back to single steps once.
      key(slider, gap > 0 ? "ArrowRight" : "ArrowLeft")
      await sleep(15)
      if (read() === before) return false
    }
  }
  return read() === goal
}

// The workspace picker lists names with a count: "My Workspace (12 clips)".
const bare = (value: string) => norm(value.replace(/\s*\(\d[\d,]*\s+clips?\)\s*$/i, ""))

/** An item in the open menu or picker dialog whose name is `label` (or matches it). */
export function openItem(label: string | RegExp, except?: Element) {
  const scopes = within<HTMLElement>(document, `${SEL.popups}, ${SEL.contextMenu}`).filter(isOpen)
  const named = (el: Element) =>
    typeof label === "string" ? bare(firstLine(el)) === norm(label) : label.test(firstLine(el))
  for (const el of scopes.flatMap((scope) => within<HTMLElement>(scope, "span, div, button, li, p, [role='option'], [role='menuitem']"))) {
    if (el === except || el.children.length > 1 || !named(el)) continue
    // Suno's own menus ("+ Audio", the condition type) put each label in a wrapper
    // with no size (display: contents): only the item around it has one.
    const item = el.closest<HTMLElement>(SEL.clickable) ?? el
    if (visible(item)) return item
  }
  return undefined
}

const escape = () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
const mouseDown = (el: HTMLElement) => el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }))

/** Opens a menu with its button and finds an item: some of Suno's menus open on a click, others on mouse-down. */
async function openMenu<T>(opener: HTMLElement, find: () => T | null | undefined, opensOn: "click" | "mousedown" = "click") {
  const press = [() => opener.click(), () => mouseDown(opener)]
  if (opensOn === "mousedown") press.reverse()
  press[0]()
  const found = await waitFor(find, 1500)
  if (found) return found
  press[1]()
  return waitFor(find, 3000)
}

/** Opens a menu or picker with `opener` and clicks the item named `label`. */
async function pickFromMenu(opener: HTMLElement, label: string) {
  const item = await openMenu(opener, () => openItem(label, opener))
  if (!item) {
    escape()
    return false
  }
  item.click()
  await sleep(400)
  return true
}

/** The model button in the form's header: its text is the model (v6-wild). */
function modelButton(panel: HTMLElement) {
  return within<HTMLButtonElement>(panel, "button").find((b) => /^v\d[\w.+-]*$/i.test(firstLine(b)))
}

/** Model names as the menu, the API and a request spell them, made comparable: "V6 Wild" = v6-wild. */
export const sameModel = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && norm(a).replace(/[\s_]+/g, "-") === norm(b).replace(/[\s_]+/g, "-")

/** The model the form shows now, read from its button. */
export function readModel(panel = createPanel()) {
  const button = panel && modelButton(panel)
  return button ? firstLine(button) : undefined
}

/**
 * The model once the form has settled on it: the page restores the model it
 * last used a moment after the form is on the page, so a read taken too soon
 * (or a pick made too soon) can be undone by that restore. Resolves with the
 * text the button has kept for `holdMs`, or whatever it shows at `timeoutMs`.
 */
export async function settledModel(panel: HTMLElement, holdMs = 700, timeoutMs = 5000) {
  const start = Date.now()
  let last = readModel(panel)
  let since = Date.now()
  while (Date.now() - start < timeoutMs) {
    await sleep(100)
    const now = readModel(panel)
    if (now !== last) {
      last = now
      since = Date.now()
    } else if (Date.now() - since >= holdMs) break
  }
  return last
}

/**
 * Picks `model` in the model menu and reads the button back, up to `attempts`
 * times: a pick counts only once the button shows the model and keeps it.
 * Resolves with the model the form shows at the end.
 */
export async function setModel(panel: HTMLElement, model: string, attempts = 2) {
  let shown = await settledModel(panel)
  for (let attempt = 0; attempt < attempts && !sameModel(shown, model); attempt++) {
    const button = modelButton(panel)
    if (!button) return shown
    if (!(await pickFromMenu(button, model))) return shown
    await waitFor(() => sameModel(readModel(panel), model), 3000)
    shown = await settledModel(panel)
  }
  return shown
}

/** The workspace button: beside the form's "Save to..." label; it opens the workspace picker. */
function workspaceButton(panel: HTMLElement) {
  return within<HTMLButtonElement>(panel, 'button[aria-haspopup="dialog"]').find((b) =>
    (b.parentElement?.textContent ?? "")
      .replace(b.textContent ?? "", "")
      .trim()
      .startsWith(TEXT.saveTo)
  )
}

function stylesBox(panel: HTMLElement) {
  const clear = panel.querySelector(SEL.clearStyles)
  let box = clear?.parentElement ?? null
  for (let i = 0; box && i < 5; i++) {
    const area = box.querySelector<HTMLTextAreaElement>("textarea")
    if (area) return area
    box = box.parentElement
  }
  return panel.querySelector<HTMLTextAreaElement>(SEL.stylesFallback) ?? undefined
}

const creditsOf = (el: Element | null) => {
  const label = el?.getAttribute("aria-label") ?? ""
  const n = Number(label.replace(/[^\d]/g, ""))
  return label && Number.isFinite(n) ? n : undefined
}

export function captchaVisible() {
  return within<HTMLIFrameElement>(document, SEL.captchaFrames).some((frame) => {
    const rect = frame.getBoundingClientRect()
    return rect.width > 60 && rect.height > 60 && visible(frame)
  })
}

export function readForm(): SunoFormState {
  const panel = createPanel()
  const sliders: Record<string, number | undefined> = {}
  for (const [name, label] of Object.entries(SLIDERS)) {
    const el = panel?.querySelector(SEL.slider(label))
    sliders[name] = el ? Number(el.getAttribute("aria-valuenow")) : undefined
  }
  const create = document.querySelector<HTMLButtonElement>(SEL.createButton)
  const advancedTab = panel ? within<HTMLElement>(panel, '[role="tab"]').find((t) => text(t) === TEXT.advanced) : undefined
  return {
    ready: !!panel && !!document.querySelector(SEL.lyrics),
    advanced: advancedTab ? advancedTab.getAttribute("aria-selected") === "true" || isOn(advancedTab) : false,
    model: panel ? modelButton(panel) && firstLine(modelButton(panel)!) : undefined,
    credits: creditsOf(document.querySelector(SEL.credits)),
    workspace: panel ? workspaceButton(panel) && firstLine(workspaceButton(panel)!) : undefined,
    condition: firstLine(document.querySelector(SEL.conditionType) ?? document.createElement("i")) || undefined,
    title: document.querySelector<HTMLInputElement>(SEL.title)?.value,
    styles: panel ? stylesBox(panel)?.value : undefined,
    excludeStyles: document.querySelector<HTMLInputElement>(SEL.excludeStyles)?.value,
    lyrics: lyricsText(),
    sliders,
    createEnabled: !!create && !create.disabled && create.getAttribute("aria-disabled") !== "true",
    captcha: captchaVisible()
  }
}

/** Selects the Songs tab and Advanced mode, where every field is. */
async function ensureAdvanced(panel: HTMLElement) {
  for (const label of [TEXT.songsTab, TEXT.advanced]) {
    const tab = within<HTMLElement>(panel, '[role="tab"]').find((t) => text(t) === label)
    if (tab && tab.getAttribute("aria-selected") !== "true") {
      tab.click()
      await sleep(300)
    }
  }
}

/** Opens More Options when its rows aren't on the page yet. */
async function ensureMoreOptions(panel: HTMLElement) {
  if (panel.querySelector(SEL.excludeStyles)) return
  const header = within<HTMLElement>(panel, "button, div, span").find((el) => firstLine(el) === TEXT.moreOptions)
  header?.click()
  await waitFor(() => panel.querySelector(SEL.excludeStyles), 3000)
}

/** Turns on `option` in a More Options row and reads it back: true only once the row shows it on. */
async function clickRow(panel: HTMLElement, row: string, option: string, attempts = 3) {
  const find = () => rowButtons(panel, row).find((b) => firstLine(b) === option)
  for (let attempt = 0; attempt < attempts; attempt++) {
    const button = find()
    if (!button) return false
    if (isOn(button)) return true
    button.click()
    if (await waitFor(() => (find() ? isOn(find()!) : false), 1500)) return true
  }
  return false
}

const genderOption = (gender: "male" | "female") => (gender === "male" ? ROW.vocalGender.male : ROW.vocalGender.female)

/** Whether the form's Vocal Gender row shows `gender` on. */
export function vocalGenderOn(gender: "male" | "female", panel = createPanel()) {
  const button = panel && rowButtons(panel, ROW.vocalGender.label).find((b) => firstLine(b) === genderOption(gender))
  return !!button && isOn(button)
}

/**
 * The last check before Create is clicked: the Vocal Gender row shows `gender`
 * (turned on once more if a later step cleared it), or it throws.
 */
export async function assertVocalGender(gender: "male" | "female" | undefined) {
  if (!gender) return
  const panel = createPanel()
  if (!panel) throw new Error("Suno's Create form isn't on the page.")
  if (vocalGenderOn(gender, panel)) return
  await ensureMoreOptions(panel)
  if (!(await clickRow(panel, ROW.vocalGender.label, genderOption(gender))) || !vocalGenderOn(gender, panel)) {
    throw new Error(`Suno's form doesn't show Vocal Gender: ${genderOption(gender)}: Create wasn't clicked.`)
  }
}

/** Sets the audio condition (Cover, Extend…) when audio is attached. */
export async function setCondition(name: string) {
  const label = CONDITIONS[name.toLowerCase()] ?? name
  const opener = await waitFor(() => document.querySelector<HTMLElement>(SEL.conditionType), 15_000)
  if (!opener) return false
  if (norm(firstLine(opener)) === norm(label)) return true
  return pickFromMenu(opener, label)
}

const clock = (seconds: number) => {
  const m = Math.floor(seconds / 60)
  const s = seconds - m * 60
  return `${String(m).padStart(2, "0")}:${s.toFixed(1).padStart(4, "0")}`
}

async function setExtendFrom(panel: HTMLElement, seconds: number) {
  const label = within<HTMLElement>(panel, "div, span, label").find(
    (el) => el.children.length === 0 && text(el).startsWith(TEXT.extendFrom)
  )
  const input = label?.parentElement?.querySelector<HTMLInputElement>("input")
  if (!input) return false
  setValue(input, clock(seconds))
  key(input, "Enter")
  input.blur()
  return true
}

export interface FillResult {
  warnings: string[]
  form: SunoFormState
  /** With job.model: whether the form shows that model now (never click Create when it doesn't). */
  modelOk?: boolean
}

/**
 * Fills the Create form from a job. Leaves out what the job doesn't set, so a
 * cover keeps the lyrics and styles suno.com loaded from the source song.
 * Returns what couldn't be set, and whether the model the job asked for is
 * the one the form shows: picked from the menu, read back, and checked again
 * at the end, after the other fields (the page may restore its last model
 * while the form fills).
 */
export async function fillForm(job: SunoFormJob): Promise<FillResult> {
  const warnings: string[] = []
  const panel = (await waitFor(createPanel, 15_000)) as HTMLElement | null
  if (!panel) throw new Error("Suno's Create form isn't on the page.")
  await ensureAdvanced(panel)

  if (job.model) {
    if (!modelButton(panel)) warnings.push("the model menu isn't on the form")
    else if (!sameModel(await setModel(panel, job.model), job.model)) warnings.push(`model ${job.model} isn't in the model menu`)
  }
  if (job.condition && !(await setCondition(job.condition))) warnings.push(`couldn't switch the audio to ${job.condition}`)
  if (job.extendFrom !== undefined && !(await setExtendFrom(panel, job.extendFrom))) {
    warnings.push("couldn't set where to extend from")
  }

  if (job.instrumental || job.lyrics !== undefined) {
    const lyrics = job.instrumental ? (job.condition ? "[Instrumental]" : "") : job.lyrics ?? ""
    if (!(await setLyrics(lyrics))) warnings.push("the lyrics didn't take; check the Lyrics box")
  }
  if (job.styles !== undefined) {
    const area = stylesBox(panel)
    if (area) setValue(area, job.styles.slice(0, area.maxLength > 0 ? area.maxLength : 1000))
    else warnings.push("no Styles box")
  }

  const wantsMore =
    job.excludeStyles !== undefined ||
    job.vocalGender ||
    job.maxMode !== undefined ||
    job.myTaste !== undefined ||
    [job.weirdness, job.styleInfluence, job.audioInfluence, job.variety].some((v) => v !== undefined)
  if (wantsMore) await ensureMoreOptions(panel)
  if (job.excludeStyles !== undefined) {
    const input = panel.querySelector<HTMLInputElement>(SEL.excludeStyles)
    if (input) setValue(input, job.excludeStyles)
    else warnings.push("no Exclude styles box (Pro and Premier only)")
  }
  if (job.vocalGender && !(await clickRow(panel, ROW.vocalGender.label, genderOption(job.vocalGender)))) {
    warnings.push("couldn't set Vocal Gender")
  }
  if (job.maxMode !== undefined && !(await clickRow(panel, ROW.maxMode.label, job.maxMode ? ROW.maxMode.on : ROW.maxMode.off))) {
    warnings.push("couldn't set Max Mode")
  }
  if (job.myTaste !== undefined && !(await clickRow(panel, ROW.myTaste.label, job.myTaste ? ROW.myTaste.on : ROW.myTaste.off))) {
    warnings.push("couldn't set My Taste")
  }
  const sliders: [keyof typeof SLIDERS, number | undefined][] = [
    ["weirdness", job.weirdness],
    ["styleInfluence", job.styleInfluence],
    ["audioInfluence", job.audioInfluence],
    ["variety", job.variety]
  ]
  for (const [name, value] of sliders) {
    if (value === undefined) continue
    if (!(await setSlider(panel, SLIDERS[name], value))) warnings.push(`couldn't move ${SLIDERS[name]} to ${value}`)
  }

  if (job.title !== undefined) {
    const input = panel.querySelector<HTMLInputElement>(SEL.title)
    if (input) setValue(input, job.title.slice(0, 100))
    else warnings.push("no Song Title box")
  }
  if (job.workspaceName) {
    const button = workspaceButton(panel)
    const ok = button && (norm(firstLine(button)) === norm(job.workspaceName) || (await pickFromMenu(button, job.workspaceName)))
    if (!ok) warnings.push(`couldn't pick the workspace "${job.workspaceName}"`)
  }
  await sleep(200)
  let modelOk: boolean | undefined
  if (job.model) {
    // Read back once everything else is set: a late restore or a re-render can undo the pick.
    let shown = await settledModel(panel)
    if (!sameModel(shown, job.model) && modelButton(panel)) shown = await setModel(panel, job.model, 1)
    modelOk = sameModel(shown, job.model)
    if (!modelOk) warnings.push(`the form shows model ${shown ?? "none"}, not ${job.model}`)
  }
  // The model and workspace picks re-render the form: set the voice again if they cleared it.
  if (job.vocalGender && !vocalGenderOn(job.vocalGender, panel)) {
    await ensureMoreOptions(panel)
    await clickRow(panel, ROW.vocalGender.label, genderOption(job.vocalGender))
  }
  return { warnings, form: readForm(), modelOk }
}

/** Throws when the form's model isn't `model`: the last check before Create is clicked. */
export function assertModel(model: string | undefined) {
  if (!model) return
  const shown = readModel()
  if (!sameModel(shown, model)) {
    throw new Error(`Suno's form shows model ${shown ?? "none"}, not ${model}: Create wasn't clicked.`)
  }
}

/** Clicks Create. Throws with the reason when the button can't be pressed. */
export function clickCreate() {
  const button = document.querySelector<HTMLButtonElement>(SEL.createButton)
  if (!button) throw new Error("Suno's Create button isn't on the page.")
  if (button.disabled || button.getAttribute("aria-disabled") === "true") {
    throw new Error("Suno's Create button is disabled: the form needs lyrics, styles or audio first.")
  }
  button.click()
}

type UploadStep =
  | { kind: "rights" | "terms"; confirm?: HTMLButtonElement }
  | { kind: "pick"; input: HTMLInputElement }
  | { kind: "categories"; next?: HTMLButtonElement }
  | { kind: "description"; next?: HTMLButtonElement; skip?: HTMLButtonElement; uploaded: boolean }
  | { kind: "refused"; reason: string }

/** The step Suno's upload dialog is at, when it is open (UPLOAD in selectors.ts has them all). */
export function uploadStep(): UploadStep | null {
  for (const dialog of dialogs()) {
    const words = text(dialog)
    const button = (pattern: RegExp) =>
      within<HTMLButtonElement>(dialog, "button").find((b) => pattern.test(firstLine(b)) && !b.disabled)
    if (UPLOAD.copyright.test(words)) return { kind: "refused", reason: words.replace(/\s+/g, " ").slice(0, 200) }
    if (UPLOAD.rights.test(words)) return { kind: "rights", confirm: button(UPLOAD.yes) }
    const agree = button(UPLOAD.agree)
    if (agree) return { kind: "terms", confirm: agree }
    if (UPLOAD.categories.test(words)) return { kind: "categories", next: button(UPLOAD.next) }
    if (UPLOAD.description.test(words)) {
      return { kind: "description", next: button(UPLOAD.next), skip: button(UPLOAD.skip), uploaded: UPLOAD.uploaded.test(words) }
    }
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]')
    if (input) return { kind: "pick", input }
  }
  return null
}

/** What an upload left on the page, for an error message: its dialogs (closing ones too) and the form's audio. */
export function uploadSnapshot() {
  const boxes = within<HTMLElement>(document, '[role="dialog"], [role="alertdialog"]')
    .filter(visible)
    .map((d) => `${isOpen(d) ? "an open" : "a closing"} dialog "${text(d).replace(/\s+/g, " ").slice(0, 150)}"`)
  const audio = document.querySelector(SEL.conditionType)?.getAttribute("aria-label")
  return `${boxes.join(", ") || "no dialog"}; ${audio ? `"${audio}" on the form` : "no audio on the form"}`
}

function giveFile(input: HTMLInputElement, file: File) {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

// While armed, contents/sunoPage.ts (in the page) marks the file input Suno
// clicks to open its file picker, instead of opening the picker.
const PICKER = "data-browse-hack-file"

/**
 * Hands a file to Suno's audio upload, as if picked in its file picker: to the
 * upload dialog's own file input when it is open, else through the Create
 * form's Upload (the empty Audio card's, or the "+ Audio" menu's). Resolves
 * false when Suno asks for the rights or terms first: answer, then call again.
 */
export async function pickAudio(file: File) {
  const open = uploadStep()
  if (open?.kind === "pick") {
    giveFile(open.input, file)
    return true
  }
  document.querySelector(`[${PICKER}]`)?.removeAttribute(PICKER)
  if (!(await askPage("arm-file-input", "file-input-armed"))) {
    throw new Error("Browse Hack's page script isn't running in the Suno tab. Reload the tab and try again.")
  }
  const button = document.querySelector<HTMLElement>(UPLOAD.button)
  if (button) button.click()
  else {
    const add = document.querySelector<HTMLElement>(SEL.addAudio)
    if (!add) throw new Error("Suno's audio upload isn't on the page.")
    // "+ Audio" toggles its menu on mouse-down: press it only when the menu isn't open yet.
    const upload = () => openItem(UPLOAD.menuItem, add)
    const item = upload() ?? (await openMenu(add, upload, "mousedown"))
    if (!item) {
      // Suno may ask for the rights first: the caller answers, then picks again.
      const step = uploadStep()
      if (step?.kind === "rights" || step?.kind === "terms") return false
      const shown = [...dialogs(), ...within<HTMLElement>(document, `${SEL.popups}, ${SEL.contextMenu}`).filter(isOpen)]
        .map((el) => `"${text(el).replace(/\s+/g, " ").slice(0, 120)}"`)
        .join(", ")
      escape()
      throw new Error(`Suno's Add audio menu has no Upload (on the page: ${shown || "no menu or dialog"}).`)
    }
    item.click()
  }
  const found = await waitFor(() => {
    const step = uploadStep()
    if (step?.kind === "rights" || step?.kind === "terms") return "question"
    return document.querySelector<HTMLInputElement>(`[${PICKER}]`) ?? (step?.kind === "pick" ? step.input : null)
  }, 8000)
  if (!found) throw new Error("Suno's file picker didn't open.")
  if (found === "question") return false
  // The menu stays open after Upload; close it before the upload dialog opens (Escape would close that too).
  if (openItem(UPLOAD.menuItem)) escape()
  giveFile(found, file)
  return true
}

/** An error message Suno shows near the form (upload rejected, out of credits…). */
export function visibleError() {
  const alert = within<HTMLElement>(document, '[role="alert"], [data-sonner-toast], [role="status"]').find(
    (el) => visible(el) && /fail|error|can't|cannot|unable|not enough|insufficient|limit|match|copyright|reject/i.test(text(el))
  )
  return alert ? text(alert).slice(0, 300) : undefined
}

/** The song's "…" (More options) button: in its row of a song list, or on its own page. */
export function songMenuButton(clipId: string) {
  const row = within<HTMLElement>(document, SEL.clipRow).find((r) => r.querySelector(`a[href^="/song/${clipId}"]`))
  const inRow = row?.querySelector<HTMLButtonElement>(SEL.moreOptions)
  if (inRow) return inRow
  if (!location.pathname.startsWith(`/song/${clipId}`)) return undefined
  // The song's own page also shows other songs (its parent, more by the artist),
  // each with a More options of its own: take the one whose box links to this song only.
  const near = (button: Element) => {
    let box = button.parentElement
    let mine = false
    for (let i = 0; box && i < 5; i++, box = box.parentElement) {
      for (const a of within<HTMLAnchorElement>(box, SEL.songLink)) {
        if (a.getAttribute("href")!.startsWith(`/song/${clipId}`)) mine = true
        else return "other"
      }
    }
    return mine ? "mine" : "none"
  }
  const buttons = within<HTMLButtonElement>(document, SEL.moreOptions).filter(visible)
  return buttons.find((b) => near(b) === "mine") ?? buttons.find((b) => near(b) === "none")
}

/** Opens a song's "…" menu; resolves with its Download item (not clicked). */
export async function openSongMenu(clipId: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const opener = (await waitFor(() => songMenuButton(clipId), 15_000)) as HTMLButtonElement | null
    if (!opener) throw new Error(`Couldn't find the song's menu for ${clipId} on this page.`)
    const before = new Set(within(document, SEL.popups).filter(visible))
    opener.scrollIntoView({ block: "center" })
    opener.click()
    // Until the page has finished starting up, the button opens nothing: try again.
    const menu = await waitFor(() => within<HTMLElement>(document, SEL.popups).find((p) => visible(p) && !before.has(p)), 2500)
    if (!menu) continue
    const item = await waitFor(() => openItem(TEXT.download, opener), 4000)
    if (item) return item
    const items = within<HTMLElement>(menu, SEL.menuItems).map(firstLine).filter(Boolean)
    escape()
    throw new Error(`The song's menu has no Download item (it has ${items.slice(0, 20).join(", ") || "nothing"}).`)
  }
  throw new Error("The song's menu didn't open.")
}

type DownloadFormat = keyof typeof DOWNLOAD.formats

const dialogs = () => within<HTMLElement>(document, '[role="dialog"], [role="alertdialog"]').filter(isOpen)

/** Whether a format is picked in Suno's download dialog: it shows a check mark. */
function formatOn(button: HTMLElement) {
  const state = button.getAttribute("aria-pressed") ?? button.getAttribute("aria-checked")
  if (state !== null) return state === "true"
  return !!button.querySelector("svg")
}

/** Suno's open download dialog: its format toggles and its Download button. */
export function downloadDialog() {
  for (const dialog of dialogs()) {
    const buttons = within<HTMLButtonElement>(dialog, "button")
    const formats = new Map<DownloadFormat, HTMLButtonElement>()
    for (const button of buttons) {
      const label = norm(firstLine(button))
      const key = (Object.keys(DOWNLOAD.formats) as DownloadFormat[]).find((k) => norm(DOWNLOAD.formats[k]) === label)
      if (key && !formats.has(key)) formats.set(key, button)
    }
    if (formats.size < 2) continue
    const others = buttons.filter((b) => ![...formats.values()].includes(b))
    const confirm =
      others.find((b) => DOWNLOAD.confirm.test(firstLine(b))) ??
      others.filter((b) => /download/i.test(firstLine(b)) && !DOWNLOAD.notConfirm.test(firstLine(b))).pop()
    return { dialog, formats, confirm }
  }
  return null
}

/** The older song menu's Download ▸ MP3 Audio / WAV Audio item. */
function menuFormatItem(format: "mp3" | "wav") {
  for (const menu of within<HTMLElement>(document, '[role="menu"]').filter(visible)) {
    const hit = within<HTMLElement>(menu, "span, div, button, [role='menuitem']").find(
      (el) => el.children.length <= 1 && visible(el) && DOWNLOAD.menu[format].test(firstLine(el)) && !/video/i.test(firstLine(el))
    )
    if (hit) return hit.closest<HTMLElement>(SEL.clickable) ?? hit
  }
  return null
}

/** Picks only `format` in Suno's download dialog and presses its Download button. */
async function downloadFromDialog(format: "mp3" | "wav") {
  const found = downloadDialog()
  const label = DOWNLOAD.formats[format]
  if (!found?.formats.has(format)) throw new Error(`Suno's download dialog has no ${label}.`)
  for (const [key, button] of found.formats) {
    if ((key === format) === formatOn(button)) continue
    button.click()
    await waitFor(() => formatOn(button) === (key === format), 2000, 50)
  }
  const picked = [...found.formats].filter(([, b]) => formatOn(b)).map(([key]) => DOWNLOAD.formats[key])
  if (picked.join() !== label) {
    throw new Error(`Couldn't pick only ${label} in Suno's download dialog (picked: ${picked.join(", ") || "none"}).`)
  }
  const confirm = await waitFor(() => {
    const button = downloadDialog()?.confirm
    return button && !button.disabled && button.getAttribute("aria-disabled") !== "true" ? button : null
  }, 3000)
  if (!confirm) throw new Error("Suno's download dialog has no Download button to press.")
  // "Unlock & Download" uses one of the month's downloads; "Download" means the song is unlocked already.
  const unlocked = /unlock/i.test(firstLine(confirm))
  confirm.click()
  const refused = await waitFor(visibleError, 4000, 250)
  if (refused) throw new Error(`Suno refused the download: ${refused}`)
  return { pickedFormat: true, dialog: true, unlocked }
}

/**
 * Downloads a song in `format` from its "…" menu, as a person would: Download
 * opens Suno's download dialog, where only that format is picked before its
 * Download is pressed. Older menus listed the formats in the menu itself.
 */
export async function clickDownload(clipId: string, format: "mp3" | "wav") {
  const item = await openSongMenu(clipId)
  item.click()
  const opened = await waitFor(() => (downloadDialog() ? "dialog" : menuFormatItem(format)), 10_000)
  if (opened === "dialog") return downloadFromDialog(format)
  if (opened) {
    opened.click()
    return { pickedFormat: true, dialog: false }
  }
  const other = dialogs()[0]
  if (other) throw new Error(`Suno showed "${text(other).replace(/\s+/g, " ").slice(0, 200)}" instead of its download formats.`)
  // Some accounts download straight from the menu item, with no format to pick.
  return { pickedFormat: false, dialog: false }
}
