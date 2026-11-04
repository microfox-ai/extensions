import type { PlasmoCSConfig } from "plasmo"

import {
  channelMatches,
  type YoutubeAbVariant,
  type YoutubeChannel,
  type YoutubeChannelCard,
  type YoutubeFillResult,
  type YoutubeUploadInfo
} from "../lib/youtubeUpload"

// YouTube Studio: lists the channels in the account menu, switches between
// them, and fills the upload dialog from info.json: Details, Monetisation, Ad
// suitability and Video elements (end screen, cards) on the way. It stops on the
// Visibility step and never clicks Save, Publish or Schedule.
//
// Content scripts can't read Studio's Polymer data, so everything here goes by
// the page's markup: element ids, radio names and the menus' test-id values.

export const config: PlasmoCSConfig = {
  matches: ["https://studio.youtube.com/*"],
  run_at: "document_idle"
}

type FileStart = { type: "file-start"; id: string; name: string; mime: string; total: number }
// Port messages are JSON, so chunks travel as base64 text.
type FileChunk = { type: "chunk"; id: string; index: number; base64: string }
type FillMsg = { type: "fill"; info: YoutubeUploadInfo; videoId: string; thumbnailId?: string; abThumbnailIds?: string[] }

const CATEGORY_PREFIX = "CREATOR_VIDEO_CATEGORY_"
const COMMENT_STATE = { on: "COMMENTS_ENABLEMENT_STATE_ON", off: "COMMENTS_ENABLEMENT_STATE_OFF" }
const COMMENT_MODERATION = {
  none: "COMMENTS_MODERATION_TYPE_ALLOW_ALL",
  basic: "COMMENTS_MODERATION_TYPE_AUTOMOD",
  strict: "COMMENTS_MODERATION_TYPE_AUTOMOD_HOLD_MORE",
  "hold-all": "COMMENTS_MODERATION_TYPE_HOLD_ALL"
}
const WHO_CAN_COMMENT = {
  anyone: "ALLOWED_COMMENTER_MODE_ANYONE",
  subscribers: "ALLOWED_COMMENTER_MODE_SUBSCRIBERS_MEMBERS_APPROVED_USERS"
}
const COMMENT_SORT = { top: "VIDEO_COMMENT_SORT_ORDER_TOP", newest: "VIDEO_COMMENT_SORT_ORDER_LATEST" }
const LICENSE = { standard: "VIDEO_LICENSE_STANDARD", "creative-commons": "VIDEO_LICENSE_CREATIVE_COMMONS" }
const REMIXING = {
  "video-and-audio": "REMIX_SOURCE_OPTION_OPT_IN",
  "audio-only": "REMIX_SOURCE_OPTION_VISUAL_OPT_OUT_AND_PERFORM_ACTIONS",
  off: "REMIX_SOURCE_OPTION_OPT_OUT_AND_MUTE_DERIVATIVES"
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === "giz-ytstudio-ping") {
    sendResponse({ ok: true, ...pageState() })
    return true
  }
  if (msg?.action === "giz-ytstudio-channels") {
    listChannels().then(
      (channels) => sendResponse({ ok: true, channels }),
      (error) => sendResponse({ ok: false, error: errorText(error) })
    )
    return true
  }
  if (msg?.action === "giz-ytstudio-switch") {
    switchChannel(String(msg.channel || "")).then(sendResponse, (error) =>
      sendResponse({ ok: false, error: errorText(error) })
    )
    return true
  }
  return false
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "giz-youtube-upload") return
  const bins = new Map<string, { name: string; mime: string; total: number; parts: Uint8Array[] }>()

  port.onMessage.addListener((msg: FileStart | FileChunk | FillMsg) => {
    if (msg.type === "file-start") {
      bins.set(msg.id, { name: msg.name, mime: msg.mime, total: msg.total, parts: [] })
      return
    }
    if (msg.type === "chunk") {
      const bin = bins.get(msg.id)
      if (bin && typeof msg.base64 === "string") bin.parts[msg.index] = base64ToBytes(msg.base64)
      return
    }
    if (msg.type === "fill") {
      const take = (id?: string) => {
        const bin = id ? bins.get(id) : undefined
        if (!bin || bin.parts.length !== bin.total || bin.parts.some((part) => !part)) return null
        return new File(bin.parts, bin.name, { type: bin.mime })
      }
      const video = take(msg.videoId)
      const thumbnail = take(msg.thumbnailId)
      const abThumbnails = (msg.abThumbnailIds || []).map((id) => take(id))
      bins.clear()
      void fillUpload(msg.info, video, thumbnail, abThumbnails).then(
        (result) => port.postMessage({ type: "result", result }),
        (error) =>
          port.postMessage({
            type: "result",
            result: { ok: false, message: errorText(error), warnings: [], filled: [] }
          })
      )
    }
  })
})

// --- Page helpers ---

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitFor<T>(get: () => T | null | undefined | false, ms = 5000): Promise<T | null> {
  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const value = get()
      if (value) return resolve(value)
      if (Date.now() - start > ms) return resolve(null)
      setTimeout(tick, 100)
    }
    tick()
  })
}

function shown(el: Element | null | undefined): el is HTMLElement {
  return !!el && !!(el as HTMLElement).offsetParent
}

function firstShown<T extends Element>(selector: string, root: ParentNode = document): T | null {
  return (Array.from(root.querySelectorAll<T>(selector)).find(shown) as T | undefined) ?? null
}

function text(el: Element | null | undefined): string {
  return ((el as HTMLElement | null)?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim()
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function pageState() {
  const channelId = location.pathname.match(/\/channel\/(UC[\w-]{22})/)?.[1] || ""
  const channelName = text(document.querySelector("#entity-name"))
  return {
    ready: !!document.querySelector("#avatar-btn") && !!channelName,
    channelId,
    channelName,
    uploadReady: !!filePicker() || !!dialog()?.querySelector("#title-textarea #textbox")
  }
}

function dismissWelcome() {
  const welcome = firstShown<HTMLElement>("ytcp-warm-welcome-dialog #dismiss-button")
  welcome?.click()
}

// --- Channels (avatar menu → Switch account) ---

function accountItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("ytd-account-item-renderer")).filter(shown)
}

function readChannel(item: HTMLElement): YoutubeChannel {
  const name = text(item.querySelector("#channel-title"))
  const lines = (item.innerText || "").split("\n").map((line) => line.trim()).filter(Boolean)
  const handleAt = lines.findIndex((line) => line.startsWith("@"))
  const selected = item.querySelector("#selected")
  return {
    name: name || lines[0] || "",
    handle: handleAt >= 0 ? lines[handleAt] : "",
    byline: lines.slice(handleAt >= 0 ? handleAt + 1 : 1).join(" · "),
    selected: !!selected && !selected.hasAttribute("hidden") && shown(selected)
  }
}

const accountMenuOpen = () => accountItems().length > 0 || !!firstShown("ytd-compact-link-renderer")

/** The avatar button toggles the menu; wait out its closing animation. */
async function closeAccountMenu() {
  if (!accountMenuOpen()) return
  document.querySelector<HTMLElement>("#avatar-btn")?.click()
  await waitFor(() => !accountMenuOpen(), 3000)
}

async function openAccountList(): Promise<HTMLElement[]> {
  dismissWelcome()
  const avatar = document.querySelector<HTMLElement>("#avatar-btn")
  if (!avatar) throw new Error("YouTube Studio's account button isn't on this page. Is the profile signed in to YouTube?")
  // Start from a closed menu so the click below opens it.
  await closeAccountMenu()
  avatar.click()
  const switcher = await waitFor(
    () =>
      firstShown<HTMLElement>("ytd-compact-link-renderer[has-secondary]") ||
      Array.from(document.querySelectorAll<HTMLElement>("ytd-compact-link-renderer")).find(
        (link) => shown(link) && /switch account/i.test(text(link))
      )
  )
  if (!switcher) throw new Error("Couldn't find Switch account in YouTube Studio's account menu.")
  ;(switcher.querySelector<HTMLElement>("tp-yt-paper-item") || switcher).click()
  const first = await waitFor(() => accountItems().length > 0, 8000)
  if (!first) throw new Error("YouTube Studio's channel list didn't open.")
  // The list fills in over a moment; wait until it stops growing.
  let count = 0
  for (let i = 0; i < 10 && accountItems().length !== count; i++) {
    count = accountItems().length
    await sleep(300)
  }
  return accountItems()
}

async function listChannels(): Promise<YoutubeChannel[]> {
  try {
    return (await openAccountList()).map(readChannel)
  } finally {
    await closeAccountMenu()
  }
}

async function switchChannel(wanted: string) {
  const items = await openAccountList()
  const channels = items.map(readChannel)
  const index = channels.findIndex((channel) => channelMatches(channel, wanted))
  if (index < 0) {
    await closeAccountMenu()
    return { ok: false, error: `No channel "${wanted}" in this profile's YouTube accounts.`, channels }
  }
  const channel = channels[index]
  if (channel.selected) {
    await closeAccountMenu()
    return { ok: true, already: true, channel }
  }
  // Studio reloads on the chosen channel's dashboard.
  ;(items[index].querySelector<HTMLElement>("tp-yt-paper-icon-item") || items[index]).click()
  return { ok: true, switched: true, channel }
}

// --- Upload dialog ---

function dialog(): HTMLElement | null {
  return document.querySelector<HTMLElement>("ytcp-uploads-dialog")
}

/** The "Select files" step; its file input itself is hidden. */
function filePicker(): HTMLInputElement | null {
  const picker = firstShown("ytcp-uploads-dialog ytcp-uploads-file-picker")
  return picker?.querySelector<HTMLInputElement>("input[type=file]") ?? null
}

function setFile(input: HTMLInputElement, file: File) {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event("change", { bubbles: true }))
}

/** Replaces a contenteditable box's text the way typing would, so Studio's model sees it. */
function setEditable(box: HTMLElement, value: string): boolean {
  box.focus()
  const range = document.createRange()
  range.selectNodeContents(box)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  if (value) document.execCommand("insertText", false, value)
  else document.execCommand("delete")
  box.blur()
  return box.innerText.replace(/\n+$/, "") === value
}

function radio(name: string): HTMLElement | null {
  return dialog()?.querySelector<HTMLElement>(`tp-yt-paper-radio-button[name="${name}"]`) ?? null
}

function chooseRadio(name: string): boolean {
  const button = radio(name)
  if (!button) return false
  if (button.getAttribute("aria-checked") !== "true") button.click()
  return button.getAttribute("aria-checked") === "true"
}

function checkboxState(box: Element): boolean | null {
  const role = box.matches("[role=checkbox]") ? box : box.querySelector("[role=checkbox]")
  const state = role?.getAttribute("aria-checked")
  return state === "true" ? true : state === "false" ? false : null
}

async function setCheckbox(box: HTMLElement | null, want: boolean): Promise<boolean> {
  if (!box) return false
  if (checkboxState(box) !== want) {
    ;(box.querySelector<HTMLElement>("[role=checkbox]") || box).click()
    await sleep(150)
  }
  return checkboxState(box) === want
}

function advancedCheckbox(test: RegExp): HTMLElement | null {
  const boxes = Array.from(
    dialog()?.querySelectorAll<HTMLElement>("ytcp-video-metadata-editor-advanced ytcp-checkbox-lit") || []
  )
  return (
    boxes.find((box) => test.test(box.querySelector("[role=checkbox]")?.getAttribute("aria-label") || text(box))) ||
    null
  )
}

function menuItem(testId: string): HTMLElement | null {
  return firstShown<HTMLElement>(`tp-yt-paper-item[test-id="${CSS.escape(testId)}"]`)
}

/** Opens a Studio dropdown and picks the item with this test-id (or this exact text). */
async function chooseFromDropdown(
  select: Element | null,
  match: { testId?: string; text?: string }
): Promise<boolean> {
  const trigger = select?.querySelector<HTMLElement>("ytcp-text-dropdown-trigger, ytcp-dropdown-trigger")
  if (!trigger) return false
  trigger.click()
  const item = await waitFor(() => {
    if (match.testId) {
      const byId = menuItem(match.testId)
      if (byId) return byId
    }
    if (!match.text) return null
    const want = match.text.toLowerCase()
    return Array.from(document.querySelectorAll<HTMLElement>("tp-yt-paper-item")).find(
      (el) => shown(el) && text(el).toLowerCase() === want
    )
  }, 3000)
  if (!item) {
    trigger.click()
    await sleep(200)
    return false
  }
  item.scrollIntoView({ block: "center" })
  item.click()
  await sleep(300)
  return true
}

async function chooseLanguage(language: string): Promise<boolean> {
  const input = dialog()?.querySelector("ytcp-form-language-input#language-input")
  if (!input) return false
  const code = /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(language) ? language : undefined
  return chooseFromDropdown(input, { testId: code, text: language })
}

/** Sort by has no id; it is the advanced select whose menu offers the sort orders. */
async function chooseCommentSort(testId: string): Promise<boolean> {
  const selects = Array.from(
    dialog()?.querySelectorAll<HTMLElement>("ytcp-video-metadata-editor-advanced ytcp-form-select:not([id])") || []
  ).filter((select) => shown(select) && !select.closest("ytcp-form-language-input"))
  for (const select of selects.reverse()) {
    if (await chooseFromDropdown(select, { testId })) return true
  }
  return false
}

async function addTags(tags: string[]): Promise<number> {
  const bar = dialog()?.querySelector<HTMLElement>("#tags-container")
  const input = bar?.querySelector<HTMLInputElement>("input#text-input")
  if (!bar || !input) return 0
  input.focus()
  input.value = tags.join(", ")
  input.dispatchEvent(new Event("input", { bubbles: true }))
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }))
  input.blur()
  await sleep(300)
  return bar.querySelectorAll("ytcp-chip, ytcp-chip-lit").length
}

/** What Studio says about a thumbnail it refused: an error under the thumbnails, or its toast. */
function thumbnailError(): string {
  const near = Array.from(
    dialog()?.querySelectorAll<HTMLElement>("ytcp-video-thumbnail-editor [class*=error], ytcp-video-thumbnail-editor #error-message") || []
  )
  const toasts = Array.from(document.querySelectorAll<HTMLElement>("tp-yt-paper-toast, ytcp-toast, ytcp-app-snackbar, #toast"))
  return [...new Set([...near, ...toasts].filter(shown).map(text).filter(Boolean))].join(" ")
}

/** Asks contents/youtubeStudioPage.ts, in Studio's own page, to act on this element; null if no answer comes. */
function askPage(type: string, target: Element, extra: Record<string, unknown> = {}): Promise<any> {
  const id = Math.random().toString(36).slice(2)
  target.setAttribute("data-browse-hack-target", id)
  return new Promise((resolve) => {
    const done = (answer: any) => {
      clearTimeout(timer)
      window.removeEventListener("message", onMessage)
      target.removeAttribute("data-browse-hack-target")
      resolve(answer)
    }
    const onMessage = (event: MessageEvent) => {
      const data = event.data
      if (event.source === window && data?.source === "browse-hack-ytstudio" && data.type === `${type}-done` && data.id === id) done(data)
    }
    const timer = setTimeout(() => done(null), 3000)
    window.addEventListener("message", onMessage)
    window.postMessage({ source: "browse-hack-ytstudio-cs", type, id, ...extra }, location.origin)
  })
}

/**
 * Gives one of Studio's thumbnail uploaders (the video's, or an A/B testing slot's) an image, and
 * waits for it to go up. Studio previews the file at once and uploads it after, so a failure can
 * come a few seconds after the preview. Null when it went up.
 */
async function uploadImage(uploader: HTMLElement, file: File): Promise<string | null> {
  const input = uploader.querySelector<HTMLInputElement>("input#file-loader")
  if (!input) return `There's no file input for the thumbnail ${file.name}.`
  const editor = uploader.closest<HTMLElement>("ytcp-video-custom-still-editor")
  let started = false
  let failed = false
  const onStart = () => (started = true)
  const onFail = () => (failed = true)
  uploader.addEventListener("upload-started", onStart)
  uploader.addEventListener("upload-reverted", onFail)
  editor?.addEventListener("custom-still-upload-error", onFail)
  try {
    // Set from the isolated world, the file previews but its upload fails; set from the page it goes up.
    const set = await askPage("set-file", input, { file })
    // No page script (a tab opened before Browse Hack was updated): set it from here.
    if (!set?.ok) setFile(input, file)
    await waitFor(() => started || failed, 8000)
    if (started && !failed) await waitFor(() => failed, 5000)
  } finally {
    uploader.removeEventListener("upload-started", onStart)
    uploader.removeEventListener("upload-reverted", onFail)
    editor?.removeEventListener("custom-still-upload-error", onFail)
  }
  if (failed) {
    const said = editor ? ((await askPage("read-errors", editor))?.errors as string[] | undefined)?.join(" ") : ""
    return `Studio refused the thumbnail ${file.name}: ${said || thumbnailError() || "it showed no reason"}.`
  }
  if (!started) {
    return (
      `Studio didn't take the thumbnail ${file.name}. Custom thumbnails need a phone-verified channel ` +
      "(youtube.com/verify while on this channel)."
    )
  }
  return null
}

/** The video's own thumbnail. Custom thumbnails need a phone-verified channel. */
async function setThumbnail(file: File): Promise<string | null> {
  const uploader = dialog()?.querySelector<HTMLElement>("ytcp-video-custom-still-editor ytcp-thumbnail-uploader") ||
    dialog()?.querySelector<HTMLElement>("ytcp-thumbnail-uploader")
  if (!uploader) return "There's no thumbnail upload on this page."
  return uploadImage(uploader, file)
}

async function choosePlaylists(names: string[], filled: string[], warnings: string[]) {
  const trigger = dialog()?.querySelector<HTMLElement>("ytcp-video-metadata-playlists ytcp-text-dropdown-trigger")
  if (!trigger) {
    warnings.push("There's no Playlists field on this page.")
    return
  }
  trigger.click()
  const list = await waitFor(() => firstShown<HTMLElement>("ytcp-playlist-dialog #playlists-list") ||
    firstShown<HTMLElement>("ytcp-playlist-dialog tp-yt-paper-dialog"), 5000)
  const pdialog = list?.closest("ytcp-playlist-dialog")
  if (!pdialog) {
    warnings.push("The playlist picker didn't open.")
    return
  }
  await sleep(500)
  const listRoot = pdialog.querySelector("#playlists-list") || pdialog
  const rows = Array.from(listRoot.querySelectorAll<HTMLElement>("ytcp-checkbox-lit")).filter(shown)
  const title = (box: HTMLElement) =>
    box.querySelector("[role=checkbox]")?.getAttribute("aria-label")?.trim() ||
    text(box.closest("li, ytcp-ve, label") || box.parentElement)
  const label = (box: HTMLElement) => title(box).toLowerCase()
  for (const name of names) {
    const want = name.trim().toLowerCase()
    const box = rows.find((row) => label(row) === want) || rows.find((row) => label(row).startsWith(want))
    if (!box) {
      const available = rows.map(title)
      warnings.push(
        `No playlist "${name}" on this channel` +
          (available.length ? ` (it has: ${available.join(", ")}).` : " (it has none).")
      )
      continue
    }
    if (await setCheckbox(box, true)) filled.push(`Playlist: ${name}`)
    else warnings.push(`Couldn't tick the playlist "${name}".`)
  }
  const done =
    Array.from(pdialog.querySelectorAll<HTMLElement>("ytcp-button")).find(
      (button) => shown(button) && (/done/.test(button.className) || /^done$/i.test(text(button)))
    ) || Array.from(pdialog.querySelectorAll<HTMLElement>("ytcp-button")).filter(shown).pop()
  done?.click()
  await sleep(400)
}

// The dialog's steps after Details, by the section Studio shows for each. Channels in the
// Partner Programme get Monetisation, and Ad suitability once monetisation is on.
const STEPS = [
  ["monetization", "ytcp-uploads-monetization"],
  ["ad-suitability", "ytcp-uploads-content-ratings"],
  ["video-elements", "ytcp-uploads-video-elements"],
  ["checks", "ytcp-uploads-checks"],
  ["visibility", "ytcp-uploads-review"]
] as const
type Step = "details" | (typeof STEPS)[number][0]
const STEP_NAMES: Record<Step, string> = {
  details: "Details",
  monetization: "Monetisation",
  "ad-suitability": "Ad suitability",
  "video-elements": "Video elements",
  checks: "Checks",
  visibility: "Visibility"
}

function currentStep(): Step | null {
  for (const [step, tag] of STEPS) if (shown(dialog()?.querySelector(tag))) return step
  return shown(dialog()?.querySelector("#title-textarea #textbox")) ? "details" : null
}

const enabled = (button: HTMLElement | null | undefined): button is HTMLElement =>
  shown(button) && !button.hasAttribute("disabled") && button.getAttribute("aria-disabled") !== "true"

/** Clicks a Studio button where a person's click lands: the <button> inside its ytcp-button. */
function press(button: HTMLElement) {
  ;(button.querySelector<HTMLElement>("button") || button).click()
}

/** Clicks Next and waits for the step after this one; null when Studio stays put. */
async function nextStep(): Promise<Step | null> {
  const from = currentStep()
  const button = await waitFor(() => {
    const next = dialog()?.querySelector<HTMLElement>("#next-button")
    return enabled(next) ? next : null
  }, 10_000)
  if (!button) return null
  press(button)
  return waitFor(() => {
    const step = currentStep()
    return step && step !== from ? step : null
  }, 6000)
}

const norm = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase()

/** The item named exactly this, else the first whose name starts with it. */
function findByName<T extends HTMLElement>(items: T[], name: string, label: (item: T) => string): T | undefined {
  const want = norm(name)
  return items.find((item) => norm(label(item)) === want) || items.find((item) => norm(label(item)).startsWith(want))
}

function shownIn<T extends HTMLElement>(selector: string, root: ParentNode = document): T[] {
  return Array.from(root.querySelectorAll<T>(selector)).filter(shown)
}

/** Closes the small picker dialog holding this element with its Close or Cancel button. */
async function closePicker(inside: Element | null | undefined) {
  const box = inside?.closest("ytcp-dialog, tp-yt-paper-dialog")
  const close = shownIn<HTMLElement>("ytcp-icon-button, ytcp-button, button", box || document).find((button) =>
    /^(close|cancel)$/i.test(button.getAttribute("aria-label") || text(button))
  )
  if (close) press(close)
  await sleep(400)
}

async function setMonetization(info: YoutubeUploadInfo, filled: string[], warnings: string[]) {
  const on = info.monetization ?? true
  if (info.monetization === null) warnings.push('monetization isn\'t in info.json; turned it On (set "monetization": false for Off).')
  const field = dialog()?.querySelector<HTMLElement>("ytcp-uploads-monetization ytcp-video-monetization")
  const opener = field?.querySelector<HTMLElement>(".clickable") || field?.querySelector<HTMLElement>("ytcp-icon-button")
  if (!opener) {
    warnings.push("There's no monetisation setting on this page.")
    return
  }
  opener.click()
  const name = on ? "ON" : "OFF"
  const choice = await waitFor(
    () => firstShown<HTMLElement>(`ytcp-video-monetization-edit-dialog tp-yt-paper-radio-button[name="${name}"]`),
    5000
  )
  if (!choice) {
    warnings.push("Studio's monetisation dialog didn't open; set it under Monetisation.")
    return
  }
  if (choice.getAttribute("aria-checked") !== "true") choice.click()
  await sleep(200)
  const done = choice.closest("ytcp-video-monetization-edit-dialog")?.querySelector<HTMLElement>("ytcp-button#save-button")
  if (choice.getAttribute("aria-checked") !== "true" || !done) {
    warnings.push(`Couldn't turn monetisation ${on ? "on" : "off"}; set it under Monetisation.`)
    return
  }
  press(done)
  await waitFor(() => !shown(choice), 3000)
  filled.push(`Monetisation: ${on ? "on" : "off"}`)
}

async function answerAdSuitability(info: YoutubeUploadInfo, filled: string[], warnings: string[]) {
  if (info.adSuitability === "skip") {
    warnings.push("Ad suitability is left for you (adSuitability is skip): answer it, click Submit rating, then Next.")
    return
  }
  const section = dialog()?.querySelector<HTMLElement>("ytcp-uploads-content-ratings")
  const none = section?.querySelector<HTMLElement>("ytcp-checkbox-lit.all-none-checkbox")
  const submit = () => section?.querySelector<HTMLElement>("ytcp-button#submit-questionnaire-button")
  // A draft opened again shows its rating instead of the questions.
  if (!shown(none) || !shown(submit())) return
  if (info.adSuitability === null) warnings.push('adSuitability isn\'t in info.json; answered None of the above (set "skip" to answer it yourself).')
  if (!(await setCheckbox(none, true))) {
    warnings.push("Couldn't tick None of the above under Ad suitability.")
    return
  }
  // Studio works out its overall rating ("Safe for ads") first; a Submit pressed before that is ignored.
  await sleep(2500)
  for (let attempt = 0; attempt < 2 && enabled(submit()); attempt++) {
    const button = await waitFor(() => (enabled(submit()) ? submit() : null), 5000)
    if (!button) break
    press(button)
    if (await waitFor(() => !enabled(submit()), 8000)) break
  }
  if (enabled(submit())) {
    warnings.push("Studio didn't take the Ad suitability rating: click Submit rating, then Next.")
    return
  }
  filled.push("Ad suitability: None of the above")
}

// The end screen and cards editors open over the upload dialog, each in a ytve-modal-host.
const END_SCREEN_EDITOR = "ytve-endscreen-editor-options-panel"
const CARDS_EDITOR = "ytve-info-cards-editor-options-panel"

function editorWith(panel: string): HTMLElement | null {
  return firstShown<HTMLElement>(panel)?.closest<HTMLElement>("ytve-modal-host") ?? null
}

function editorErrors(host: HTMLElement): string {
  return [...new Set(shownIn<HTMLElement>("[class*=error], #error-message", host).map(text).filter(Boolean))].join(" ")
}

/** Saves an open editor and waits for it to close. Without changes to save, Discard closes it. */
async function closeEditor(panel: string, save: boolean, what: string, warnings: string[]): Promise<boolean> {
  const host = editorWith(panel)
  if (!host) return !save
  const button = host.querySelector<HTMLElement>(save ? "ytcp-button#save-button" : "ytcp-button#discard-button")
  if (save && !(await waitFor(() => enabled(button), 5000))) {
    const errors = editorErrors(host)
    warnings.push(`Couldn't save the ${what}: Studio's Save stayed off${errors ? ` (${errors})` : ""}. Finish it in the editor.`)
    return false
  }
  if (button) press(button)
  if (!(await waitFor(() => !editorWith(panel), 15_000))) {
    warnings.push(`The ${what} editor didn't close${save ? " after Save" : ""}; check it.`)
    return false
  }
  return true
}

/** Points the end screen's playlist element (the imported one) at this playlist. */
async function setEndScreenPlaylist(name: string, filled: string[], warnings: string[]) {
  const host = editorWith(END_SCREEN_EDITOR)
  // Timeline rows shorten their labels to fit ("Playlist: ..."); the selected element's panel has the full name.
  const row = shownIn<HTMLElement>("ytve-endscreen-row #element", host || document).find((el) => /^playlist:/i.test(text(el)))
  if (!row) {
    warnings.push(`The imported end screen has no playlist element to point at "${name}".`)
    return
  }
  row.click()
  const select = await waitFor(() => firstShown<HTMLElement>(`${END_SCREEN_EDITOR} #playlist-select`), 3000)
  const trigger = select?.querySelector<HTMLElement>("ytcp-dropdown-trigger") || select
  const playlistOf = (el: HTMLElement) => text(el).replace(/^playlist:\s*/i, "")
  if (!select || !trigger) {
    warnings.push(`Couldn't open the end screen's playlist element to set "${name}".`)
    return
  }
  if (findByName([select], name, playlistOf)) {
    filled.push(`End screen playlist: ${playlistOf(select)}`)
    return
  }
  trigger.click()
  const options = await waitFor(() => {
    const list = shownIn<HTMLElement>("ytcp-playlist-pick-dialog ytcp-entity-card")
    return list.length ? list : null
  }, 5000)
  const option = options && findByName(options, name, text)
  if (!option) {
    warnings.push(
      `No playlist "${name}" for the end screen` +
        (options ? ` (it has: ${options.map(text).join("; ")}).` : " (the playlist picker didn't open).")
    )
    await closePicker(options?.[0])
    return
  }
  option.click()
  const changed = await waitFor(() => {
    const now = firstShown<HTMLElement>(`${END_SCREEN_EDITOR} #playlist-select`)
    return now && findByName([now], name, playlistOf)
  }, 5000)
  if (changed) filled.push(`End screen playlist: ${playlistOf(changed)}`)
  else warnings.push(`The end screen's playlist didn't change to "${name}"; check it.`)
}

async function importEndScreen(spec: NonNullable<YoutubeUploadInfo["endScreen"]>, filled: string[], warnings: string[]) {
  const button = dialog()?.querySelector<HTMLElement>("ytcp-button#import-from-video-button")
  if (!enabled(button)) {
    warnings.push("There's no end screen Import from video on this page; add the end screen by hand.")
    return
  }
  press(button)
  const titleOf = (card: HTMLElement) => (card.getAttribute("aria-label") || text(card)).replace(/, (not )?selected$/i, "")
  const listed = () => shownIn<HTMLElement>("ytcp-video-pick-dialog-contents ytcp-entity-card")
  let cards = await waitFor(() => (listed().length ? listed() : null), 10_000)
  let card = cards && findByName(cards, spec.importFrom, titleOf)
  const search =
    cards &&
    firstShown<HTMLInputElement>(
      "input:not([type]), input[type=text], input[type=search]",
      cards[0].closest("ytcp-video-pick-dialog-contents") || document
    )
  if (cards && !card && search) {
    // Only the latest videos are listed until you search.
    typeText(search, spec.importFrom)
    card = (await waitFor(() => findByName(listed(), spec.importFrom, titleOf), 6000)) || undefined
    cards = listed()
  }
  if (!card) {
    warnings.push(
      `No video "${spec.importFrom}" to import the end screen from` +
        (cards?.length ? ` (Studio lists: ${cards.slice(0, 8).map(titleOf).join("; ")}).` : ".")
    )
    await closePicker(cards?.[0])
    await closeEditor(END_SCREEN_EDITOR, false, "end screen", warnings)
    return
  }
  const from = titleOf(card)
  card.scrollIntoView({ block: "center" })
  card.click()
  // The end screen editor opens with the imported elements on its timeline.
  const rows = await waitFor(() => {
    const list = shownIn("ytve-endscreen-row", editorWith(END_SCREEN_EDITOR) || document)
    return list.length ? list : null
  }, 15_000)
  if (!rows) {
    warnings.push(`Studio didn't import the end screen from "${from}"; add it by hand.`)
    await closeEditor(END_SCREEN_EDITOR, false, "end screen", warnings)
    return
  }
  if (spec.playlist) await setEndScreenPlaylist(spec.playlist, filled, warnings)
  if (await closeEditor(END_SCREEN_EDITOR, true, "end screen", warnings)) {
    filled.push(`End screen: imported from "${from}" (${rows.length} elements)`)
  }
}

/** Types into an input or textarea the way a person would, so Studio's model sees it. */
function typeText(box: HTMLInputElement | HTMLTextAreaElement, value: string): boolean {
  box.focus()
  box.select()
  document.execCommand("insertText", false, value)
  if (box.value !== value) {
    box.value = value
    box.dispatchEvent(new Event("input", { bubbles: true, composed: true }))
  }
  box.dispatchEvent(new Event("change", { bubbles: true }))
  box.blur()
  return box.value === value
}

async function addChannelCard(host: HTMLElement, card: YoutubeChannelCard, warnings: string[]): Promise<boolean> {
  // The editor sometimes opens on "Oops, something went wrong"; Retry brings it back.
  const retry = firstShown<HTMLElement>("ytcp-button#error-retry-button", host)
  if (retry) {
    retry.click()
    await sleep(1500)
  }
  // An empty editor offers the card types as icons; with a card there already, + Card opens them as a menu.
  const channelType = () =>
    firstShown<HTMLElement>('ytcp-icon-button[aria-label*="linking to a channel" i]', host) ||
    shownIn<HTMLElement>("tp-yt-paper-item").find((item) => /^channel$/i.test(text(item)))
  if (!(await waitFor(channelType, 4000))) {
    host.querySelector<HTMLElement>("ytcp-button#add-card-button")?.click()
    await waitFor(channelType, 3000)
  }
  const add = channelType()
  if (!add) {
    warnings.push(`Couldn't find the channel card type to add ${card.channel}.`)
    return false
  }
  add.click()
  const search = await waitFor(() => firstShown<HTMLInputElement>("input#search-any"), 5000)
  if (!search) {
    warnings.push(`The channel search for the card didn't open (${card.channel}).`)
    return false
  }
  const handle = card.channel.startsWith("@") ? norm(card.channel) : ""
  const name = norm(handle ? handle.slice(1).replace(/[-_.]+/g, " ") : card.channel)
  typeText(search, handle ? handle.slice(1) : card.channel)
  const picker = search.closest("tp-yt-paper-dialog") || document
  const results = () => shownIn<HTMLElement>("ytcp-entity-card", picker)
  const result = await waitFor(
    () => results().find((item) => (handle && norm(text(item)).includes(handle)) || norm(text(item)).includes(name)),
    8000
  )
  if (!result) {
    const found = results().map((item) => text(item).slice(0, 40))
    warnings.push(`No channel "${card.channel}" in the card's search` + (found.length ? ` (it found: ${found.join("; ")}).` : "."))
    await closePicker(search)
    return false
  }
  result.click()
  const last = (selector: string) => shownIn<HTMLTextAreaElement>(selector, host).pop()
  const message = await waitFor(() => last("ytve-lightweight-textarea#custom-message textarea"), 5000)
  const teaser = last("ytve-lightweight-textarea#teaser-text textarea")
  if (!message || !teaser) {
    warnings.push(`The channel card for ${card.channel} didn't open its message fields.`)
    return false
  }
  const ok = typeText(message, card.message) && typeText(teaser, card.teaser)
  if (!ok) warnings.push(`The channel card's message or teaser didn't stick (${card.channel}); check it.`)
  return ok
}

async function addCards(cards: YoutubeChannelCard[], filled: string[], warnings: string[]) {
  const button = dialog()?.querySelector<HTMLElement>("ytcp-button#cards-button")
  if (!enabled(button)) {
    warnings.push("There's no Cards Add button on this page; add the cards by hand.")
    return
  }
  press(button)
  const host = await waitFor(() => editorWith(CARDS_EDITOR), 10_000)
  if (!host) {
    warnings.push("Studio's cards editor didn't open; add the cards by hand.")
    return
  }
  const added: YoutubeChannelCard[] = []
  for (const card of cards) if (await addChannelCard(host, card, warnings)) added.push(card)
  if (await closeEditor(CARDS_EDITOR, added.length > 0, "cards", warnings)) {
    for (const card of added) filled.push(`Card: ${card.channel} "${card.message}"`)
  }
}

// Details → A/B testing (beside the title) opens ytcp-creator-experiment-create-dialog. Its chips
// pick what's tested; each of its three slots has a thumbnail uploader and a title box.
const AB_MODES = {
  titles: ["chip-0", /^title only$/i],
  thumbnails: ["chip-1", /^thumbnail only$/i],
  both: ["chip-2", /^title and thumbnail$/i]
} as const

async function setAbTest(variants: YoutubeAbVariant[], files: (File | null)[], filled: string[], warnings: string[]) {
  const titles = variants.every((variant) => variant.title)
  const thumbnails = variants.every((variant) => variant.thumbnail)
  if (thumbnails && variants.some((_, index) => !files[index])) {
    warnings.push("The A/B test's thumbnails didn't all arrive; set the test by hand under A/B testing.")
    return
  }
  const opener =
    dialog()?.querySelector<HTMLElement>("ytcp-button#ab-test-button") ||
    dialog()?.querySelector<HTMLElement>('ytcp-thumbnails-experiment-editor [aria-label="A/B testing"]')
  if (!enabled(opener)) {
    warnings.push("There's no A/B testing on this upload form; set the test on the video's page in Studio.")
    return
  }
  press(opener)
  const create = () => document.querySelector<HTMLElement>("ytcp-creator-experiment-create-dialog")
  const chips = () => shownIn<HTMLElement>("ytcp-static-chip-bar ytcp-chip", create() || document)
  const keep = () => firstShown<HTMLElement>("ytcp-creator-experiment-delete-confirmation-dialog ytcp-button#cancel-button")
  await waitFor(() => keep() || chips().length, 8000)
  const cancel = keep()
  if (cancel) {
    // "Start a new experiment? This deletes your current experiment."
    press(cancel)
    warnings.push("This video already has an A/B test; it was left as it is.")
    return
  }
  const host = create()
  if (!host || !chips().length) {
    warnings.push("Studio's A/B testing didn't open; set the test by hand.")
    return
  }
  const [chipId, label] = titles && thumbnails ? AB_MODES.both : thumbnails ? AB_MODES.thumbnails : AB_MODES.titles
  const chip = chips().find((item) => label.test(text(item))) || chips().find((item) => item.id === chipId)
  if (chip && chip.getAttribute("aria-checked") !== "true") chip.click()
  if (!chip || !(await waitFor(() => chip.getAttribute("aria-checked") === "true", 3000))) {
    warnings.push("Couldn't pick what the A/B test compares; set the test by hand.")
    await closePicker(chips()[0])
    return
  }
  await sleep(500)
  const giveUp = async (problem: string) => {
    warnings.push(`${problem} The A/B test wasn't set; set it by hand.`)
    await closePicker(chips()[0])
  }
  for (const [index, variant] of variants.entries()) {
    if (variant.title) {
      const box = shownIn<HTMLElement>("ytcp-social-suggestion-input #textbox", host)[index]
      if (!box || !setEditable(box, variant.title)) return giveUp(`Title ${index + 1} of the A/B test didn't stick.`)
    }
    const file = files[index]
    if (variant.thumbnail && file) {
      const uploader = Array.from(host.querySelectorAll<HTMLElement>("ytcp-thumbnail-uploader"))[index]
      const problem = uploader ? await uploadImage(uploader, file) : `There's no thumbnail slot ${index + 1} in A/B testing.`
      if (problem) return giveUp(problem)
    }
  }
  const setTest = () => host.querySelector<HTMLElement>("ytcp-button#set-test-button")
  if (!(await waitFor(() => enabled(setTest()), 8000))) {
    const errors = editorErrors(host)
    return giveUp(`Studio's Set test stayed off${errors ? ` (${errors})` : ""}.`)
  }
  press(setTest()!)
  if (!(await waitFor(() => !chips().length, 10_000))) {
    warnings.push("The A/B testing dialog didn't close after Set test; check it.")
    return
  }
  const what = titles && thumbnails ? "thumbnails with their titles" : thumbnails ? "thumbnails" : "titles"
  filled.push(`A/B test: ${variants.length} ${what}`)
}

function formatLike(sample: string, date: Date): string {
  const lang = document.documentElement.lang || navigator.language
  const formatted = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short", year: "numeric" }).format(date)
  // Studio shows "3 Nov 2026"; Intl may add a comma ("3 Nov, 2026") in some locales.
  return /,/.test(sample) ? formatted : formatted.replace(/,/g, "")
}

async function setScheduleDate(date: string): Promise<boolean> {
  const trigger = dialog()?.querySelector<HTMLElement>("#datepicker-trigger")
  if (!trigger) return false
  const [y, m, d] = date.split("-").map(Number)
  const day = new Date(y, m - 1, d)
  trigger.click()
  const picker = await waitFor(() => firstShown<HTMLElement>("ytcp-date-picker"), 3000)
  const input = picker && firstShown<HTMLInputElement>("input", picker)
  const form = picker?.querySelector("form")
  if (!picker || !input || !form) return false
  // The picker writes the current date into its box as it opens; type after that.
  await sleep(600)
  const value = formatLike(input.value, day)
  const matches = () => text(trigger).replace(/,/g, "") === value.replace(/,/g, "")
  for (let attempt = 0; attempt < 2 && !matches(); attempt++) {
    input.value = value
    input.dispatchEvent(new Event("input", { bubbles: true }))
    // Typing a date and pressing Enter submits this form.
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await sleep(500)
  }
  // The trigger toggles the picker; Escape would close the whole upload dialog.
  if (shown(picker)) {
    trigger.click()
    await waitFor(() => !shown(picker), 2000)
  }
  return matches()
}

async function setScheduleTime(time: string): Promise<boolean> {
  const input = dialog()?.querySelector<HTMLInputElement>("#time-of-day-container input")
  if (!input) return false
  const [h, min] = time.split(":").map(Number)
  const twelveHour = /\s?[ap]\.?\s?m\.?$/i.test(input.value)
  let value = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`
  if (twelveHour) {
    const upper = /[AP]M/.test(input.value)
    const suffix = h < 12 ? "am" : "pm"
    value = `${h % 12 || 12}:${String(min).padStart(2, "0")} ${upper ? suffix.toUpperCase() : suffix}`
  }
  input.value = value
  input.dispatchEvent(new Event("input", { bubbles: true }))
  // Studio reads the time when the field loses focus; this works without window focus.
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }))
  await sleep(400)
  return input.value === value
}

async function setVisibility(info: YoutubeUploadInfo, filled: string[], warnings: string[]) {
  const visibility = info.visibility
  if (!visibility) return
  if (visibility !== "scheduled") {
    const name = visibility.toUpperCase()
    if (chooseRadio(name)) filled.push(`Visibility: ${visibility}`)
    else warnings.push(`Couldn't choose ${visibility} visibility.`)
    if (visibility === "public" && info.premiere !== null) {
      const box = dialog()?.querySelector<HTMLElement>("#enable-premiere-checkbox") ?? null
      if (await setCheckbox(box, info.premiere)) filled.push(`Instant Premiere: ${info.premiere ? "on" : "off"}`)
      else warnings.push("Couldn't set Set as instant Premiere.")
    }
    return
  }
  if (!shown(dialog()?.querySelector("#datepicker-trigger"))) {
    ;(
      dialog()?.querySelector<HTMLElement>("#second-container-expand-button") ||
      dialog()?.querySelector<HTMLElement>("ytcp-video-visibility-select #second-container")
    )?.click()
    await waitFor(() => shown(dialog()?.querySelector("#datepicker-trigger")) || null, 3000)
  }
  if (!info.scheduleAt) return
  const dateOk = await setScheduleDate(info.scheduleAt.date)
  const timeOk = await setScheduleTime(info.scheduleAt.time)
  if (dateOk && timeOk) filled.push(`Schedule: ${info.scheduleAt.date} ${info.scheduleAt.time} (Studio's time zone)`)
  else {
    warnings.push(
      `Couldn't set the schedule to ${info.scheduleAt.date} ${info.scheduleAt.time}` +
        `${dateOk ? "" : " (date)"}${timeOk ? "" : " (time)"}; set it under Visibility → Schedule.`
    )
  }
  if (info.premiere !== null) {
    const box = dialog()?.querySelector<HTMLElement>("#schedule-type-checkbox") ?? null
    if (await setCheckbox(box, info.premiere)) filled.push(`Premiere: ${info.premiere ? "on" : "off"}`)
    else warnings.push("Couldn't set Set as Premiere.")
  }
}

function dialogErrors(): string[] {
  return Array.from(
    dialog()?.querySelectorAll<HTMLElement>(".error-short, #error-message, .error-details, ytcp-uploads-dialog-error") || []
  )
    .filter(shown)
    .map(text)
    .filter(Boolean)
}

async function fillUpload(
  info: YoutubeUploadInfo,
  video: File | null,
  thumbnail: File | null,
  abThumbnails: (File | null)[]
): Promise<YoutubeFillResult> {
  const filled: string[] = []
  const warnings: string[] = []
  if (!video) return { ok: false, message: "The video file didn't arrive in full.", warnings, filled }

  dismissWelcome()
  const picker = await waitFor(filePicker, 15_000)
  if (!picker) {
    return { ok: false, message: "YouTube Studio's upload dialog didn't open on this tab.", warnings, filled }
  }
  setFile(picker, video)
  const opened = await waitFor(
    () => firstShown<HTMLElement>("ytcp-uploads-dialog #title-textarea #textbox") || (dialogErrors().length ? "error" : null),
    60_000
  )
  const titleBox = opened === "error" ? null : opened
  if (!titleBox) {
    const errors = dialogErrors()
    return {
      ok: false,
      message: errors.length ? `YouTube didn't take the video: ${errors.join(" ")}` : "YouTube didn't open the Details form for the video.",
      warnings,
      filled
    }
  }
  filled.push(`Video: ${video.name}`)
  await sleep(800)

  if (setEditable(titleBox, info.title)) filled.push("Title")
  else warnings.push("The title didn't stick; check it.")

  if (info.description !== null) {
    const box = firstShown<HTMLElement>("ytcp-uploads-dialog #description-textarea #textbox")
    if (box && setEditable(box, info.description)) filled.push("Description")
    else warnings.push("The description didn't stick; check it.")
  }

  let thumbnailProblem = thumbnail ? await setThumbnail(thumbnail) : null
  if (thumbnail && !thumbnailProblem) filled.push(`Thumbnail: ${thumbnail.name}`)

  if (info.playlists.length) await choosePlaylists(info.playlists, filled, warnings)

  if (chooseRadio(info.madeForKids ? "VIDEO_MADE_FOR_KIDS_MFK" : "VIDEO_MADE_FOR_KIDS_NOT_MFK")) {
    filled.push(`Made for Kids: ${info.madeForKids ? "yes" : "no"}`)
  } else warnings.push("Couldn't answer Made for Kids.")
  if (info.ageRestricted !== null) {
    if (chooseRadio(info.ageRestricted ? "VIDEO_AGE_RESTRICTION_SELF" : "VIDEO_AGE_RESTRICTION_NONE")) {
      filled.push(`Age restriction: ${info.ageRestricted ? "18+" : "none"}`)
    } else warnings.push("Couldn't set the age restriction.")
  }

  // Everything below lives under Show more.
  const advanced = () => dialog()?.querySelector("ytcp-video-metadata-editor-advanced")
  if (!shown(advanced())) {
    dialog()?.querySelector<HTMLElement>("#toggle-button")?.click()
    await waitFor(() => shown(advanced()) || null, 3000)
  }

  const yesNo = (value: boolean) => (value ? "yes" : "no")
  if (info.paidPromotion !== null) {
    if (chooseRadio(info.paidPromotion ? "VIDEO_PAID_PRODUCT_PLACEMENT_NOTIFY" : "VIDEO_PAID_PRODUCT_PLACEMENT_NO")) {
      filled.push(`Paid promotion: ${yesNo(info.paidPromotion)}`)
    } else warnings.push("Couldn't answer Paid promotion.")
  }
  if (info.alteredContent !== null) {
    if (chooseRadio(info.alteredContent ? "VIDEO_HAS_ALTERED_CONTENT_YES" : "VIDEO_HAS_ALTERED_CONTENT_NO")) {
      filled.push(`AI use (altered or synthetic content): ${yesNo(info.alteredContent)}`)
    } else warnings.push("Couldn't answer AI use.")
  }

  const flags: [boolean | null, string, () => HTMLElement | null][] = [
    [info.automaticChapters, "Automatic chapters", () => advancedCheckbox(/chapter/i)],
    [info.featuredPlaces, "Automatic places", () =>
      dialog()?.querySelector<HTMLElement>("#has-autoplaces-mentioned-checkbox") ?? advancedCheckbox(/places/i)],
    [info.automaticConcepts, "Automatic concepts", () => advancedCheckbox(/concept/i)],
    [info.allowEmbedding, "Allow embedding", () =>
      dialog()?.querySelector<HTMLElement>("#allow-embed ytcp-checkbox-lit") ?? advancedCheckbox(/embed/i)],
    [info.notifySubscribers, "Notify subscribers", () =>
      dialog()?.querySelector<HTMLElement>("#notify-subscribers") ?? advancedCheckbox(/subscri/i)],
    [info.showLikes, "Show likes", () =>
      dialog()?.querySelector<HTMLElement>(".allow-ratings ytcp-checkbox-lit") ?? advancedCheckbox(/like/i)]
  ]
  for (const [want, label, find] of flags) {
    if (want === null) continue
    if (await setCheckbox(find(), want)) filled.push(`${label}: ${want ? "on" : "off"}`)
    else warnings.push(`Couldn't set ${label}.`)
  }

  if (info.tags?.length) {
    const count = await addTags(info.tags)
    if (count >= info.tags.length) filled.push(`Tags: ${info.tags.length}`)
    else warnings.push(`Only ${count} of ${info.tags.length} tags went in; check Tags.`)
  }
  if (info.language) {
    if (await chooseLanguage(info.language)) filled.push(`Language: ${info.language}`)
    else warnings.push(`Studio has no video language "${info.language}".`)
  }
  if (info.license) {
    const select = dialog()?.querySelector("ytcp-form-select#license") ?? null
    if (await chooseFromDropdown(select, { testId: LICENSE[info.license] })) filled.push(`Licence: ${info.license}`)
    else warnings.push("Couldn't set the licence.")
  }
  if (info.shortsRemixing) {
    if (chooseRadio(REMIXING[info.shortsRemixing])) filled.push(`Shorts remixing: ${info.shortsRemixing}`)
    else warnings.push("Couldn't set Shorts remixing.")
  }
  if (info.category) {
    const select = dialog()?.querySelector("ytcp-form-select#category") ?? null
    if (await chooseFromDropdown(select, { testId: CATEGORY_PREFIX + info.category })) {
      filled.push(`Category: ${text(select).replace(/^category\s*/i, "") || info.category}`)
    } else warnings.push(`Couldn't set the category ${info.category}.`)
  }
  const selects: [string | null, string, string, Record<string, string>][] = [
    [info.comments, "Comments", "enablement-state-select", COMMENT_STATE],
    [info.commentModeration, "Comment moderation", "moderation-type-select", COMMENT_MODERATION],
    [info.whoCanComment, "Who can comment", "allowed-commenter-mode-select", WHO_CAN_COMMENT]
  ]
  for (const [value, label, id, ids] of selects) {
    if (!value) continue
    const select = dialog()?.querySelector(`ytcp-select#${id}`) ?? null
    if (shown(select) && (await chooseFromDropdown(select, { testId: ids[value] }))) filled.push(`${label}: ${value}`)
    else warnings.push(`Couldn't set ${label} (comments may be off).`)
  }
  if (info.commentSort) {
    if (await chooseCommentSort(COMMENT_SORT[info.commentSort])) filled.push(`Comment sort: ${info.commentSort}`)
    else warnings.push("Couldn't set Sort by for comments.")
  }

  if (thumbnail && thumbnailProblem) {
    // One more try once the video's upload is under way.
    thumbnailProblem = await setThumbnail(thumbnail)
    if (thumbnailProblem) warnings.push(`${thumbnailProblem} Add it by hand under Thumbnail → Upload file.`)
    else filled.push(`Thumbnail: ${thumbnail.name} (second try)`)
  }
  if (info.abTest) await setAbTest(info.abTest, abThumbnails, filled, warnings)

  // On to Visibility, one step at a time; Checks is left as it is.
  let step: Step | null = "details"
  const seen = new Set<Step>()
  while (step && step !== "visibility" && !seen.has(step)) {
    seen.add(step)
    if (step === "monetization") await setMonetization(info, filled, warnings)
    if (step === "ad-suitability") await answerAdSuitability(info, filled, warnings)
    if (step === "video-elements") {
      if (info.endScreen) await importEndScreen(info.endScreen, filled, warnings)
      if (info.cards.length) await addCards(info.cards, filled, warnings)
    }
    const from: Step = step
    step = await nextStep()
    if (!step) {
      const errors = dialogErrors()
      warnings.push(
        `Stayed on ${STEP_NAMES[from]}: Studio wouldn't go on to the next step` + (errors.length ? ` (${errors.join(" ")})` : "") + "."
      )
    }
  }
  if (step === "visibility") await setVisibility(info, filled, warnings)
  else if (step) warnings.push(`Studio went back to ${STEP_NAMES[step]}; check that step and go on from there.`)
  if ((info.endScreen || info.cards.length) && !seen.has("video-elements")) {
    warnings.push("The end screen and cards weren't added: the form didn't reach Video elements.")
  }

  const link = dialog()?.querySelector<HTMLAnchorElement>('a[href*="youtu.be/"], a[href*="youtube.com/shorts/"]')
  const progress = text(dialog()?.querySelector("ytcp-video-upload-progress, .progress-label"))
  if (progress) filled.push(`Upload: ${progress}`)
  return {
    ok: true,
    message: "Filled. Nothing was saved or published: review the tab and click Save, Publish or Schedule.",
    warnings,
    filled,
    videoUrl: link?.href
  }
}
