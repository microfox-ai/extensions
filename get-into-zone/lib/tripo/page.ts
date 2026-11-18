// What a person does on Tripo's pages, step by step, for contents/tripo.ts:
// fill the create form (text or image, model, T-pose, Geometry & Texture,
// privacy), read the price on its Generate button and click it, and open a
// model's Export dialog, check it offers a GLB and its price, and click
// Export. Nothing here clicks while a captcha shows: that is the user's.
//
// Tripo's controls are Reka UI (Vue): its pickers open on pointer-down and
// pick on pointer-up, so press() sends the whole sequence a mouse would.

import { priceOf, type TripoGenerateJob } from "./model"
import { SEL, TEXT } from "./selectors"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const visible = (el: Element | null | undefined): el is HTMLElement => {
  if (!el || !(el instanceof HTMLElement)) return false
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return false
  const style = getComputedStyle(el)
  return style.visibility !== "hidden" && style.display !== "none"
}

const textOf = (el: Element) => (el as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? ""

const matches = (text: string, want: RegExp | string) => (typeof want === "string" ? text === want : want.test(text))

export function findAll(selector: string, want: RegExp | string, root: ParentNode = document) {
  return [...root.querySelectorAll(selector)].filter((el) => visible(el) && matches(textOf(el), want)) as HTMLElement[]
}

export const find = (selector: string, want: RegExp | string, root: ParentNode = document) => findAll(selector, want, root)[0]

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 8000, everyMs = 200): Promise<T | undefined> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > end) return undefined
    await sleep(everyMs)
  }
}

/** A mouse press: pointer and mouse down and up, then click. */
export function press(el: HTMLElement) {
  el.scrollIntoView({ block: "center", inline: "center" })
  const r = el.getBoundingClientRect()
  const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
  el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true, buttons: 1 }))
  el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }))
  el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }))
  el.dispatchEvent(new MouseEvent("mouseup", at))
  el.click()
}

export const captchaVisible = () => [...document.querySelectorAll(SEL.captchaFrames)].some(visible)

/** Text of whatever dialog is open on top (last in the page). */
export function topDialog() {
  const dialogs = [...document.querySelectorAll(SEL.dialog)].filter(visible) as HTMLElement[]
  return dialogs[dialogs.length - 1]
}

// --- The create form --------------------------------------------------------------

const promptBox = () => [...document.querySelectorAll(SEL.prompt)].find(visible) as HTMLTextAreaElement | undefined
const generateButton = () => findAll(SEL.button, TEXT.generate).find((b) => priceOf(textOf(b)) !== undefined) ?? find(SEL.button, TEXT.generate)
const modelPicker = () => findAll(SEL.combobox, TEXT.modelOption)[0]
const privacyPicker = () => findAll(SEL.combobox, TEXT.privacy)[0]
const tPoseToggle = () => find(SEL.button, TEXT.tPose)

export interface TripoForm {
  ready: boolean
  mode?: "text" | "image"
  model?: string
  tPose?: boolean
  privacy?: string
  price?: number
  generateEnabled: boolean
  captcha: boolean
}

export function readForm(): TripoForm {
  const gen = generateButton() as HTMLButtonElement | undefined
  const tPose = tPoseToggle()
  return {
    ready: Boolean(gen && modelPicker()),
    mode: promptBox() ? "text" : document.querySelector(SEL.fileInput) ? "image" : undefined,
    model: modelPicker() ? TEXT.modelOption.exec(textOf(modelPicker()!))?.[1] : undefined,
    tPose: tPose ? tPose.getAttribute("data-state") === "on" : undefined,
    privacy: privacyPicker() ? textOf(privacyPicker()!) : undefined,
    price: gen ? priceOf(textOf(gen)) : undefined,
    generateEnabled: Boolean(gen && !gen.disabled && gen.getAttribute("aria-disabled") !== "true"),
    captcha: captchaVisible()
  }
}

/** The text or image tab of the input card: text is the last of the four (pencil), image the first. */
async function inputMode(mode: "text" | "image") {
  const tabs = [...document.querySelectorAll(SEL.inputTabs)].filter(visible) as HTMLElement[]
  if (tabs.length < 2) throw new Error("Couldn't find Tripo's input tabs (image / text) on the create form.")
  if (mode === "text" && promptBox()) return
  press(mode === "text" ? tabs[tabs.length - 1] : tabs[0])
  const ok = await waitFor(() => (mode === "text" ? promptBox() : !promptBox() && document.querySelector(SEL.fileInput)), 5000)
  if (!ok) throw new Error(`Tripo's form didn't switch to ${mode} to 3D.`)
}

function setText(box: HTMLTextAreaElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set
  box.focus()
  setter?.call(box, text)
  box.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }))
  box.dispatchEvent(new Event("change", { bubbles: true }))
}

async function setImage(image: NonNullable<TripoGenerateJob["image"]>) {
  const input = document.querySelector(SEL.fileInput) as HTMLInputElement | null
  if (!input) throw new Error("Couldn't find Tripo's image upload.")
  const bytes = Uint8Array.from(atob(image.base64), (c) => c.charCodeAt(0))
  const ext = image.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png"
  const file = new File([bytes], image.name || `image.${ext}`, { type: image.mimeType })
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new Event("change", { bubbles: true }))
  // The card shows the picture once Tripo has it.
  await sleep(1500)
}

async function pick(picker: HTMLElement, want: RegExp, what: string) {
  press(picker)
  const option = await waitFor(() => findAll(SEL.option, want)[0], 4000)
  if (!option) {
    const shown = [...document.querySelectorAll(SEL.option)].map(textOf).filter(Boolean)
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    throw new Error(`Tripo's ${what} picker has no "${want.source}"${shown.length ? `; it offers ${shown.join(", ")}` : ""}.`)
  }
  // Reka ignores the first pointer-up after the picker opened unless the
  // pointer moved since (so the opening click can't pick): move onto the option first.
  const r = option.getBoundingClientRect()
  option.dispatchEvent(
    new PointerEvent("pointermove", { bubbles: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerType: "mouse", isPrimary: true })
  )
  press(option)
  await sleep(400)
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

async function setModel(model: string) {
  const picker = modelPicker()
  if (!picker) throw new Error("Couldn't find Tripo's AI Model picker.")
  const now = TEXT.modelOption.exec(textOf(picker))?.[1]
  if (now?.toUpperCase() === model.toUpperCase()) return
  await pick(picker, new RegExp(`^\\s*${escapeRe(model)}\\b`, "i"), "AI Model")
  const after = TEXT.modelOption.exec(textOf(modelPicker() ?? picker))?.[1]
  if (after?.toUpperCase() !== model.toUpperCase()) throw new Error(`Tripo's form shows ${after ?? "no model"}, not ${model}.`)
}

async function setTPose(on: boolean) {
  const toggle = tPoseToggle()
  if (!toggle) throw new Error("Couldn't find Tripo's T-Pose toggle (it's in text mode).")
  if ((toggle.getAttribute("data-state") === "on") === on) return
  press(toggle)
  const ok = await waitFor(() => (tPoseToggle()?.getAttribute("data-state") === "on") === on, 3000)
  if (!ok) throw new Error(`Tripo's T-Pose toggle didn't turn ${on ? "on" : "off"}.`)
}

async function setPrivacy(privacy: "public" | "private") {
  const picker = privacyPicker()
  if (!picker) throw new Error("Couldn't find Tripo's Privacy picker.")
  if (textOf(picker).toLowerCase() === privacy) return
  await pick(picker, new RegExp(`^${privacy}$`, "i"), "Privacy")
  if (textOf(privacyPicker() ?? picker).toLowerCase() !== privacy) {
    throw new Error(`Tripo kept the model ${textOf(privacyPicker() ?? picker)}: private models are for paying members.`)
  }
}

/** The control in the same row as a label in the Geometry & Texture dialog. */
function rowControl(dialog: HTMLElement, label: string, selector: string) {
  const labels = [...dialog.querySelectorAll("span, div, p, label")].filter(
    (el) => visible(el) && el.childElementCount <= 2 && textOf(el) === label
  )
  for (const el of labels) {
    let row: HTMLElement | null = el as HTMLElement
    for (let i = 0; i < 4 && row; i++, row = row.parentElement) {
      const control = [...row.querySelectorAll(selector)].find(visible) as HTMLElement | undefined
      if (control) return control
    }
  }
  return undefined
}

async function setSwitch(dialog: HTMLElement, label: string, on: boolean, warnings: string[]) {
  const sw = rowControl(dialog, label, SEL.switch)
  if (!sw) return warnings.push(`Couldn't find "${label}" in Geometry & Texture; left as it was.`)
  if ((sw.getAttribute("aria-checked") === "true") === on) return
  press(sw)
  await sleep(300)
  if ((sw.getAttribute("aria-checked") === "true") !== on) warnings.push(`"${label}" didn't turn ${on ? "on" : "off"}.`)
}

async function setChoice(dialog: HTMLElement, label: string, choice: string, warnings: string[]) {
  const button = findAll(SEL.button, new RegExp(`^${escapeRe(choice)}$`, "i"), dialog)[0]
  if (!button) return warnings.push(`Couldn't find ${label} "${choice}" in Geometry & Texture; left as it was.`)
  if (button.getAttribute("data-state") === "on") return
  press(button)
  await sleep(300)
  if (button.getAttribute("data-state") !== "on") warnings.push(`${label} "${choice}" didn't stay on (it may be for members only).`)
}

async function setGeometry(job: TripoGenerateJob, warnings: string[]) {
  const wanted = [job.texture, job.textureQuality, job.pbr, job.removeLighting, job.topology].some((v) => v !== undefined)
  if (!wanted) return
  const opener = find("button, div, span", TEXT.geometry)
  if (!opener) return warnings.push("Couldn't find Geometry & Texture; its settings were left as they were.")
  press(opener)
  const dialog = await waitFor(() => {
    const d = topDialog()
    return d && /geometry\s*&\s*texture/i.test(textOf(d)) ? d : undefined
  }, 4000)
  if (!dialog) return warnings.push("Geometry & Texture didn't open; its settings were left as they were.")
  if (job.texture !== undefined) await setSwitch(dialog, TEXT.texture, job.texture, warnings)
  if (job.textureQuality) await setChoice(dialog, TEXT.textureQuality, job.textureQuality, warnings)
  if (job.pbr !== undefined) await setSwitch(dialog, TEXT.pbr, job.pbr, warnings)
  if (job.removeLighting !== undefined) await setSwitch(dialog, TEXT.removeLighting, job.removeLighting, warnings)
  if (job.topology) await setChoice(dialog, TEXT.topology, job.topology === "quad" ? TEXT.quad : TEXT.triangle, warnings)
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
  await sleep(500)
}

export interface FillResult {
  form: TripoForm
  warnings: string[]
}

/** Fills the create form for one model; clicks nothing that spends credits. */
export async function fillForm(job: TripoGenerateJob): Promise<FillResult> {
  if (captchaVisible()) throw new Error("Tripo is showing a check (captcha). The user clears it in the tab.")
  const ready = await waitFor(() => readForm().ready, 20_000)
  if (!ready) throw new Error("Tripo's create form didn't load (no Generate button or AI Model picker).")
  const warnings: string[] = []
  await inputMode(job.mode)
  if (job.mode === "text") {
    const box = promptBox()
    if (!box) throw new Error("Couldn't find Tripo's prompt box.")
    setText(box, job.prompt ?? "")
    await sleep(200)
    if (promptBox()?.value !== job.prompt) throw new Error("Tripo's prompt box didn't take the prompt.")
    if (job.tPose !== undefined) await setTPose(job.tPose)
  } else {
    await setImage(job.image!)
    if (job.tPose) warnings.push("T-pose is a text-mode setting on Tripo; it wasn't set for image to 3D.")
  }
  if (job.model) await setModel(job.model)
  if (job.privacy) await setPrivacy(job.privacy)
  await setGeometry(job, warnings)
  await sleep(300)
  return { form: readForm(), warnings }
}

/** Clicks Generate once its price is what the caller agreed to; says what Tripo showed instead when it can't. */
export async function clickGenerate(maxPrice: number) {
  const form = readForm()
  if (form.captcha) return { captcha: true as const, form }
  if (form.price === undefined) throw new Error("Couldn't read the price on Tripo's Generate button.")
  if (form.price > maxPrice) return { refused: `Generate now costs ${form.price} credits, more than the ${maxPrice} agreed.`, form }
  const button = generateButton()
  if (!button || !form.generateEnabled) throw new Error("Tripo's Generate button is disabled.")
  press(button)
  return { clicked: true as const, form, at: Date.now() }
}

/** What Tripo shows after Generate or Export instead of starting: an upgrade dialog, a credits or busy message. */
export function blockerShown() {
  const dialog = topDialog()
  const texts = [dialog ? textOf(dialog) : "", ...[...document.querySelectorAll('[role="alert"], [role="status"], .toast, [class*="toast"], [class*="message"]')].filter(visible).map(textOf)]
  for (const text of texts) {
    if (!text) continue
    if (TEXT.notEnoughCredits.test(text)) return { kind: "credits" as const, text: text.slice(0, 200) }
    if (TEXT.busy.test(text)) return { kind: "busy" as const, text: text.slice(0, 200) }
    if (dialog && text === textOf(dialog) && TEXT.upgrade.test(text) && !TEXT.exportDialog.test(text)) return { kind: "upgrade" as const, text: text.slice(0, 200) }
  }
  return undefined
}

// --- A model's Export ------------------------------------------------------------

const exportDialog = () => {
  const d = topDialog()
  return d && TEXT.exportDialog.test(textOf(d)) && d.querySelector(SEL.combobox) ? d : undefined
}

/** Opens the viewer's Export dialog and reads it: format, price, whether Tripo marks it for members. */
export async function openExport() {
  if (captchaVisible()) return { captcha: true as const }
  const button = await waitFor(() => findAll(SEL.button, /^export$/i).find((b) => !b.closest(SEL.dialog)), 15_000)
  if (!button) throw new Error("Couldn't find the Export button under Tripo's viewer.")
  if (!exportDialog()) press(button)
  const dialog = await waitFor(exportDialog, 6000)
  if (!dialog) {
    const blocked = blockerShown()
    if (blocked) return { blocked }
    throw new Error("Tripo's Export dialog didn't open.")
  }
  const format = [...dialog.querySelectorAll(SEL.combobox)].map(textOf)[0]
  const confirm = findAll(SEL.button, TEXT.export, dialog).pop()
  return {
    format,
    price: confirm ? priceOf(textOf(confirm)) ?? 0 : undefined,
    // A crown or "members" mark on the confirm button.
    membersMark: Boolean(confirm?.querySelector('[class*="crown" i], svg[class*="vip" i], img[src*="crown" i]')),
    ready: Boolean(confirm)
  }
}

/** Picks GLB in the open Export dialog (it is Tripo's default) and clicks its Export when the price is agreed. */
export async function confirmExport(maxPrice: number) {
  const dialog = exportDialog()
  if (!dialog) throw new Error("Tripo's Export dialog isn't open.")
  const formatPicker = dialog.querySelector(SEL.combobox) as HTMLElement | null
  if (formatPicker && !TEXT.glb.test(textOf(formatPicker))) await pick(formatPicker, /^glb$/i, "Format")
  const confirm = findAll(SEL.button, TEXT.export, dialog).pop()
  if (!confirm) throw new Error("Tripo's Export dialog has no Export button.")
  const price = priceOf(textOf(confirm)) ?? 0
  if (price > maxPrice) return { refused: `Tripo's Export costs ${price} credits here, more than the ${maxPrice} agreed.`, price }
  if (captchaVisible()) return { captcha: true as const, price }
  press(confirm)
  return { clicked: true as const, price, at: Date.now() }
}

export function closeDialogs() {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
}
