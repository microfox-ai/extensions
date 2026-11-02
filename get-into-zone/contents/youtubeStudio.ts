import type { PlasmoCSConfig } from "plasmo"

import {
  channelMatches,
  type YoutubeChannel,
  type YoutubeFillResult,
  type YoutubeUploadInfo
} from "../lib/youtubeUpload"

// YouTube Studio: lists the channels in the account menu, switches between
// them, and fills the upload dialog from info.json. It stops on the Visibility
// step and never clicks Save, Publish or Schedule.
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
type FillMsg = { type: "fill"; info: YoutubeUploadInfo; videoId: string; thumbnailId?: string }

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
      bins.clear()
      void fillUpload(msg.info, video, thumbnail).then(
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

/** Custom thumbnails need a phone-verified channel; Studio drops the file quietly otherwise. */
async function setThumbnail(file: File): Promise<string | null> {
  const uploader = dialog()?.querySelector<HTMLElement>("ytcp-thumbnail-uploader")
  const input = uploader?.querySelector<HTMLInputElement>("input#file-loader")
  if (!uploader || !input) return "There's no thumbnail upload on this page."
  let started = false
  let failed = ""
  const onStart = () => (started = true)
  const onError = (event: Event) => (failed = text(event.target as Element) || "Studio rejected the thumbnail.")
  uploader.addEventListener("upload-started", onStart)
  const editor = uploader.closest("ytcp-video-custom-still-editor")
  editor?.addEventListener("custom-still-upload-error", onError)
  // A local preview of the picked file also means Studio took it.
  const preview = () =>
    Array.from(editor?.querySelectorAll<HTMLImageElement>("img") || []).some(
      (img) => shown(img) && /^(blob|data):/.test(img.src)
    )
  try {
    setFile(input, file)
    await waitFor(() => started || failed || preview(), 6000)
    started ||= preview()
  } finally {
    uploader.removeEventListener("upload-started", onStart)
    editor?.removeEventListener("custom-still-upload-error", onError)
  }
  if (failed) return `Thumbnail ${file.name}: ${failed}`
  if (!started) {
    return (
      `Studio didn't take the thumbnail ${file.name}. Custom thumbnails need a phone-verified channel ` +
      "(youtube.com/verify while on this channel); add it by hand under Thumbnail → Upload file."
    )
  }
  return null
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

const STEP_SECTIONS = ["ytcp-uploads-details", "ytcp-uploads-video-elements", "ytcp-uploads-checks", "ytcp-uploads-review"]

async function goToStep(step: number): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    if (shown(dialog()?.querySelector(STEP_SECTIONS[step]))) return true
    const next = dialog()?.querySelector<HTMLElement>("#next-button")
    if (!shown(next) || next.hasAttribute("disabled") || next.getAttribute("aria-disabled") === "true") return false
    next.click()
    await waitFor(() => shown(dialog()?.querySelector(STEP_SECTIONS[step])) || null, 2500)
  }
  return shown(dialog()?.querySelector(STEP_SECTIONS[step]))
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
    dialog()?.querySelector<HTMLElement>("#second-container-expand-button")?.click()
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
  thumbnail: File | null
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

  if (thumbnail) {
    const problem = await setThumbnail(thumbnail)
    if (problem) warnings.push(problem)
    else filled.push(`Thumbnail: ${thumbnail.name}`)
  }

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

  // Video elements and Checks are left as they are.
  if (await goToStep(3)) {
    await setVisibility(info, filled, warnings)
  } else {
    const errors = dialogErrors()
    warnings.push(
      "Stayed on Details: Studio wouldn't go on to Visibility" + (errors.length ? ` (${errors.join(" ")})` : "") + "."
    )
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
