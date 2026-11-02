import type { PlasmoCSConfig } from "plasmo"

import {
  copyForClaude,
  normalizeAccount,
  normalizeClip,
  normalizeWorkspace,
  type SunoClip,
  type SunoWorkspace
} from "../lib/suno/clip"
import {
  attachAudio,
  captchaVisible,
  clickCreate,
  clickDownload,
  fillForm,
  readForm,
  setCondition,
  uploadTermsDialog,
  visibleError,
  type SunoFormJob
} from "../lib/suno/form"
import { SEL } from "../lib/suno/selectors"
import { isSaverActive, watchSaverRules, type SaverRule } from "../lib/saverRules"
import { SUNO_PREFS_KEY, findChannel, readSunoPrefs, songSet, type SunoPrefs } from "../lib/sunoPrefs"

// Browse Hack on suno.com. For the background worker (lib/sunoBridge.ts), it
// reads songs, workspaces and credits through suno.com's own API with the
// page's sign-in, fills the Create form and clicks Create, takes a library
// track for a cover, and clicks a song's Download. For the user, it adds
// buttons to songs (Copy for Claude, Variations, Save to MediaMake) and a bar
// on the Create form (channel, Save as preset, Run ×N). contents/sunoPage.ts
// reports what the site's own Create request returned.

export const config: PlasmoCSConfig = {
  matches: ["https://suno.com/*"],
  run_at: "document_idle"
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// --- Suno's API, with the page's sign-in ------------------------------------

const NOT_SIGNED_IN = "Suno isn't signed in in this Chrome profile. Sign in at https://suno.com, then try again."

const sessionToken = () => {
  const cookie = document.cookie
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("__session="))
  return cookie ? decodeURIComponent(cookie.slice("__session=".length)) : undefined
}

async function api(path: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = sessionToken()
    if (!token) throw new Error(NOT_SIGNED_IN)
    const response = await fetch(`/a/api${path}`, {
      ...init,
      headers: {
        ...(init.body ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${token}`
      }
    })
    // The page renews its sign-in about once a minute; a stale one gets a second try.
    if (response.status === 401 && attempt === 0) {
      await sleep(4000)
      continue
    }
    if (response.status === 401) throw new Error(`${NOT_SIGNED_IN} (Suno answered 401.)`)
    if (!response.ok) throw new Error(`Suno answered ${response.status} for ${path.split("?")[0]}.`)
    return response.json()
  }
}

// The filters suno.com's own song lists send.
const FEED_FILTERS = {
  disliked: "False",
  trashed: "False",
  fromStudioProject: { presence: "False" },
  stem: { presence: "False" },
  stemComplement: "False"
}

const reads: Record<string, (params: any) => Promise<unknown>> = {
  account: async () => normalizeAccount(await api("/billing/info/")),

  workspaces: async () => {
    const all: SunoWorkspace[] = []
    for (let page = 1; page <= 20; page++) {
      const data = await api(`/project/me?page=${page}`)
      const list = Array.isArray(data?.projects) ? data.projects : []
      all.push(...list.map(normalizeWorkspace))
      if (!list.length || all.length >= Number(data?.num_total_results ?? 0)) break
    }
    return all
  },

  songs: async ({ workspaceId, search, cursor, limit }) => {
    const filters: Record<string, unknown> = { ...FEED_FILTERS }
    if (workspaceId) filters.workspace = { presence: "True", workspaceId: String(workspaceId) }
    if (search) filters.searchText = String(search)
    const data = await api("/feed/v3", {
      method: "POST",
      body: JSON.stringify({
        cursor: cursor ?? null,
        limit: Math.min(Math.max(Number(limit) || 20, 1), 50),
        filters
      })
    })
    return {
      songs: (Array.isArray(data?.clips) ? data.clips : []).map(normalizeClip),
      nextCursor: data?.next_cursor ?? null,
      hasMore: Boolean(data?.has_more)
    }
  },

  clips: async ({ ids }) => {
    const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean)
    const out: SunoClip[] = []
    for (let i = 0; i < list.length; i += 20) {
      const data = await api(`/feed/v2?ids=${list.slice(i, i + 20).join(",")}`)
      out.push(...(Array.isArray(data?.clips) ? data.clips : []).map(normalizeClip))
    }
    return out
  },

  song: async ({ id }) => normalizeClip(await api(`/clip/${encodeURIComponent(String(id))}`))
}

// --- What the site's own Create request returned (contents/sunoPage.ts) ------

interface GenerateEvent {
  at: number
  ok: boolean
  status: number
  clipIds: string[]
  batchId?: string
  detail?: string
}

const generateEvents: GenerateEvent[] = []

window.addEventListener("message", (event) => {
  const data = event.data
  if (event.source !== window || data?.source !== "browse-hack-suno" || data.type !== "generate") return
  generateEvents.push({
    at: Date.now(),
    ok: Boolean(data.ok),
    status: Number(data.status) || 0,
    clipIds: Array.isArray(data.clipIds) ? data.clipIds.map(String) : [],
    batchId: typeof data.batchId === "string" ? data.batchId : undefined,
    detail: typeof data.detail === "string" ? data.detail : undefined
  })
  if (generateEvents.length > 40) generateEvents.shift()
})

type Outcome =
  | { clipIds: string[]; batchId?: string; since: number }
  | { refused: string; status: number; since: number }
  | { captcha: true; since: number }
  | { error: string; since: number }
  | { timeout: true; since: number }

const outcomeOf = (event: GenerateEvent, since: number): Outcome =>
  event.ok
    ? { clipIds: event.clipIds, batchId: event.batchId, since }
    : { refused: event.detail || `Suno answered ${event.status}.`, status: event.status, since }

/** Waits for the answer to a Create clicked at `since`, noticing a captcha or an error message. */
async function awaitOutcome(since: number, waitMs: number, reportCaptcha = true): Promise<Outcome> {
  const start = Date.now()
  while (Date.now() - start < waitMs) {
    const event = generateEvents.find((e) => e.at >= since)
    if (event) return outcomeOf(event, since)
    if (reportCaptcha && captchaVisible()) return { captcha: true, since }
    if (Date.now() - start > 2500) {
      const error = visibleError()
      if (error) return { error, since }
    }
    await sleep(250)
  }
  return { timeout: true, since }
}

async function submit(waitMs = 45_000) {
  const before = readForm()
  const since = Date.now()
  clickCreate()
  const outcome = await awaitOutcome(since, waitMs)
  return { ...outcome, creditsBefore: before.credits }
}

// --- Messages from the background worker -------------------------------------

function pageKind() {
  const path = location.pathname
  if (path.startsWith("/create")) return "create"
  if (path.startsWith("/song/")) return "song"
  if (path.startsWith("/me") || path.startsWith("/library")) return "library"
  return "other"
}

function pageState() {
  const kind = pageKind()
  return {
    ready: document.readyState === "complete",
    page: kind,
    url: location.href,
    signedIn: Boolean(sessionToken()),
    form: kind === "create" ? readForm() : undefined
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (work: Promise<unknown>) => {
    work.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: errorText(error) })
    )
    return true
  }
  switch (msg?.action) {
    case "giz-suno-ping":
      sendResponse({ ok: true, ...pageState() })
      return
    case "giz-suno-read": {
      const read = reads[String(msg.op)]
      if (!read) {
        sendResponse({ ok: false, error: `Unknown Suno read: ${msg.op}` })
        return
      }
      return reply(read(msg.params ?? {}))
    }
    case "giz-suno-fill":
      return reply(fillForm((msg.job ?? {}) as SunoFormJob))
    case "giz-suno-submit":
      return reply(submit(Number(msg.waitMs) || 45_000))
    case "giz-suno-await":
      return reply(awaitOutcome(Number(msg.since) || 0, Number(msg.waitMs) || 60_000, msg.reportCaptcha !== false))
    case "giz-suno-download":
      return reply(clickDownload(String(msg.clipId), msg.format === "wav" ? "wav" : "mp3"))
    case "giz-suno-progress":
      toast(String(msg.text ?? ""), msg.kind)
      return
  }
})

// --- A library track handed over for a cover (lib/sunoBridge.ts streams it) ---

type FileStart = { type: "file-start"; id: string; name: string; mime: string; total: number }
type FileChunk = { type: "chunk"; id: string; index: number; base64: string }
type AttachMsg = { type: "attach"; id: string; condition?: string; allowTerms?: boolean; waitForUserMs?: number }

function base64ToBytes(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const checked = (el: HTMLElement) =>
  (el as HTMLInputElement).checked === true || el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "checked"

async function attachUploaded(file: File, msg: AttachMsg, tell: (note: string) => void) {
  await attachAudio(file)
  const start = Date.now()
  const limit = msg.waitForUserMs ?? 300_000
  let toldUser = false
  while (Date.now() - start < limit) {
    const terms = uploadTermsDialog()
    if (terms) {
      if (msg.allowTerms) {
        if (terms.checkbox && !checked(terms.checkbox)) terms.checkbox.click()
        await sleep(250)
        terms.confirm?.click()
        await sleep(800)
        continue
      }
      if (!toldUser) {
        toldUser = true
        tell(
          "Suno asks you to confirm you have the rights to this audio. Tick it in the Suno tab, or turn on " +
            "\"I own or license the audio I cover\" in Browse Hack's Suno tab."
        )
      }
    } else if (document.querySelector(SEL.conditionType)) {
      await sleep(1500)
      const error = visibleError()
      if (error) throw new Error(`Suno refused the upload: ${error}`)
      if (msg.condition && !(await setCondition(msg.condition))) {
        throw new Error(`Suno took the audio but its menu has no ${msg.condition}.`)
      }
      return { attached: true, name: file.name, condition: readForm().condition }
    } else {
      const error = Date.now() - start > 2000 ? visibleError() : undefined
      if (error) throw new Error(`Suno refused the upload: ${error}`)
    }
    await sleep(400)
  }
  throw new Error("Suno didn't finish taking the audio in time.")
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "giz-suno-upload") return
  const files = new Map<string, { name: string; mime: string; parts: Uint8Array[] }>()
  port.onMessage.addListener((msg: FileStart | FileChunk | AttachMsg) => {
    if (msg.type === "file-start") files.set(msg.id, { name: msg.name, mime: msg.mime, parts: [] })
    else if (msg.type === "chunk") {
      const bin = files.get(msg.id)
      if (bin && typeof msg.base64 === "string") bin.parts[msg.index] = base64ToBytes(msg.base64)
    } else if (msg.type === "attach") {
      const bin = files.get(msg.id)
      if (!bin) {
        port.postMessage({ type: "result", error: "No audio arrived in the Suno tab." })
        return
      }
      const file = new File(bin.parts, bin.name, { type: bin.mime })
      attachUploaded(file, msg, (note) => port.postMessage({ type: "needs-user", note })).then(
        (result) => port.postMessage({ type: "result", result }),
        (error) => port.postMessage({ type: "result", error: errorText(error) })
      )
    }
  })
})

// --- Buttons on suno.com -------------------------------------------------------

let saverRules: SaverRule[] = []
let saverWindowId: number | undefined
let prefs: SunoPrefs = readSunoPrefs(undefined)

const uiOn = () => isSaverActive(saverRules, "all", { url: location.href, windowId: saverWindowId })

chrome.storage.local.get(SUNO_PREFS_KEY).then((stored) => (prefs = readSunoPrefs(stored[SUNO_PREFS_KEY])))
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SUNO_PREFS_KEY]) prefs = readSunoPrefs(changes[SUNO_PREFS_KEY].newValue)
})
watchSaverRules((rules) => {
  saverRules = rules
  render()
})
chrome.runtime.sendMessage({ action: "getSaverContext" }, (response) => {
  if (chrome.runtime.lastError) return
  if (typeof response?.windowId === "number") saverWindowId = response.windowId
  render()
})

/** Asks the background worker for something on the user's behalf. */
const ask = (op: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "suno-ui", op, ...params }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else if (!response?.ok) reject(new Error(response?.error || "Browse Hack didn't answer."))
      else resolve(response.result)
    })
  })

const CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.tools { position: fixed; z-index: 2147483000; display: flex; gap: 4px; padding: 3px; border-radius: 10px;
  background: rgba(20,20,24,.92); border: 1px solid rgba(255,255,255,.12); box-shadow: 0 6px 18px rgba(0,0,0,.35); }
.tools[hidden], .panel[hidden], .bar[hidden] { display: none; }
button { cursor: pointer; border: 0; border-radius: 7px; padding: 5px 9px; font-size: 12px; font-weight: 600;
  color: #f4f4f5; background: rgba(255,255,255,.09); white-space: nowrap; }
button:hover { background: rgba(255,255,255,.18); }
button.primary { background: #f97316; color: #111; }
button.primary:hover { background: #fb923c; }
button[disabled] { opacity: .5; cursor: default; }
.mark { font-size: 10px; font-weight: 800; letter-spacing: .04em; color: #fdba74; padding: 5px 4px 5px 6px; }
.panel { position: fixed; z-index: 2147483001; width: 320px; padding: 14px; border-radius: 14px; color: #f4f4f5;
  background: #18181b; border: 1px solid rgba(255,255,255,.14); box-shadow: 0 16px 40px rgba(0,0,0,.5); font-size: 12px; }
.panel h3 { margin: 0 0 10px; font-size: 13px; }
.panel label { display: block; margin: 8px 0 3px; color: #a1a1aa; font-size: 11px; }
.panel select, .panel input, .panel textarea { width: 100%; padding: 6px 8px; border-radius: 8px; font-size: 12px;
  color: #f4f4f5; background: #27272a; border: 1px solid rgba(255,255,255,.12); }
.panel textarea { min-height: 54px; resize: vertical; }
.row { display: flex; gap: 8px; align-items: center; }
.row > * { flex: 1; }
.actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
.note { margin-top: 8px; color: #a1a1aa; font-size: 11px; line-height: 1.4; }
.bar { position: fixed; z-index: 2147483000; display: flex; gap: 6px; align-items: center; padding: 5px 6px; border-radius: 10px;
  background: rgba(20,20,24,.94); border: 1px solid rgba(255,255,255,.12); }
.bar select, .bar input { padding: 4px 6px; border-radius: 7px; font-size: 12px; color: #f4f4f5; background: #27272a;
  border: 1px solid rgba(255,255,255,.12); }
.bar input[type=number] { width: 46px; }
.toasts { position: fixed; z-index: 2147483002; right: 16px; bottom: 90px; display: flex; flex-direction: column; gap: 6px; }
.toast { max-width: 340px; padding: 9px 12px; border-radius: 10px; font-size: 12px; line-height: 1.4; color: #f4f4f5;
  background: #27272a; border: 1px solid rgba(255,255,255,.14); }
.toast.error { border-color: #ef4444; }
.toast.done { border-color: #22c55e; }
`

let shadow: ShadowRoot | null = null
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...children: (Node | string)[]) => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === "onclick" || k === "onchange" || k === "oninput") (node as any)[k] = v
    else if (v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : String(v))
  }
  node.append(...children)
  return node
}

function root() {
  if (shadow) return shadow
  const host = document.createElement("div")
  host.id = "browse-hack-suno"
  document.documentElement.appendChild(host)
  shadow = host.attachShadow({ mode: "open" })
  shadow.append(el("style", {}, CSS), el("div", { class: "tools", hidden: true }), el("div", { class: "panel", hidden: true }), el("div", { class: "bar", hidden: true }), el("div", { class: "toasts" }))
  return shadow
}

function toast(text: string, kind?: string) {
  if (!text) return
  const box = root().querySelector(".toasts")!
  const item = el("div", { class: `toast ${kind ?? ""}` }, text)
  box.append(item)
  setTimeout(() => item.remove(), kind === "error" ? 12_000 : 6000)
}

const channelLabel = (id?: string) => {
  const c = prefs.channels.find((ch) => ch.id === id)
  return c ? (c.folder && c.folder !== c.id ? `${c.id} (${c.folder})` : c.id) : id ?? ""
}

const songIdIn = (el: Element) =>
  el.querySelector<HTMLAnchorElement>(SEL.songLink)?.getAttribute("href")?.split("/")[2]?.split("?")[0]

// Song rows: Suno's clip rows, else one song link (several to the same song) in a box of row height.
function rowAt(target: Element | null): { row: HTMLElement; id: string } | null {
  const clipRow = target?.closest<HTMLElement>(SEL.clipRow)
  const clipId = clipRow && songIdIn(clipRow)
  if (clipRow && clipId) return { row: clipRow, id: clipId }
  let node = target as HTMLElement | null
  for (let i = 0; node && i < 10; i++, node = node.parentElement) {
    if (node === document.body) return null
    const ids = new Set(
      Array.from(node.querySelectorAll<HTMLAnchorElement>(SEL.songLink)).map((a) => a.getAttribute("href")!.split("/")[2]?.split("?")[0])
    )
    if (ids.size > 1) return null
    const height = node.getBoundingClientRect().height
    if (ids.size === 1 && height >= 44 && height <= 260) return { row: node, id: [...ids][0]! }
  }
  return null
}

let hovered: { row: HTMLElement; id: string } | null = null
let hideTimer: ReturnType<typeof setTimeout> | undefined
let toolsFor = ""

function showTools(target: { row: HTMLElement; id: string }, fixed?: { right: number; bottom: number }) {
  const tools = root().querySelector<HTMLElement>(".tools")!
  if (toolsFor !== target.id || !tools.childElementCount) {
    toolsFor = target.id
    tools.replaceChildren(
      el("span", { class: "mark" }, "MM"),
      el("button", { title: "Copy this song's prompt, lyrics and settings to ask Claude for more", onclick: () => copySong(target.id) }, "Copy for Claude"),
      el("button", { title: "Make covers or variations of this song", onclick: () => openVariations(target.id) }, "Variations ▾"),
      el("button", { title: "Download into MediaMake's media library (uses one Suno download)", onclick: () => saveSong(target.id) }, "Save")
    )
  }
  tools.hidden = false
  if (fixed) {
    tools.style.left = ""
    tools.style.top = ""
    tools.style.right = `${fixed.right}px`
    tools.style.bottom = `${fixed.bottom}px`
    return
  }
  // Left of the row's own Remix / More options buttons, centred on the row.
  const rect = target.row.getBoundingClientRect()
  const own = target.row.querySelector(SEL.moreOptions)?.closest("div")?.parentElement ?? target.row.querySelector(SEL.moreOptions)
  const rightEdge = own ? own.getBoundingClientRect().left - 8 : rect.right - 64
  tools.style.right = ""
  tools.style.bottom = ""
  tools.style.top = `${Math.max(4, rect.top + rect.height / 2 - tools.offsetHeight / 2)}px`
  tools.style.left = `${Math.max(4, rightEdge - tools.offsetWidth)}px`
}

function hideToolsSoon() {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (pageKind() === "song") return
    const tools = shadow?.querySelector<HTMLElement>(".tools")
    if (tools && !tools.matches(":hover")) tools.hidden = true
    hovered = null
  }, 350)
}

document.addEventListener(
  "mouseover",
  (event) => {
    if (!uiOn()) return
    const target = event.target as Element
    if (target === shadow?.host) {
      clearTimeout(hideTimer)
      return
    }
    const found = rowAt(target)
    if (found) {
      clearTimeout(hideTimer)
      if (hovered?.row !== found.row) {
        hovered = found
        showTools(found)
      }
    } else if (hovered) hideToolsSoon()
  },
  true
)

// The toolbar is placed on screen, not in the row, so it goes when the list scrolls.
document.addEventListener(
  "scroll",
  () => {
    if (pageKind() === "song" || !hovered) return
    const tools = shadow?.querySelector<HTMLElement>(".tools")
    if (tools) tools.hidden = true
    hovered = null
  },
  true
)

async function copySong(id: string) {
  try {
    const clip = normalizeClip(await api(`/clip/${id}`))
    const channel = findChannel(prefs, { workspaceId: clip.workspace?.id })?.id
    await navigator.clipboard.writeText(copyForClaude(clip, channel))
    toast("Copied. Paste it to Claude and say what to change.", "done")
  } catch (error) {
    toast(`Couldn't copy: ${errorText(error)}`, "error")
  }
}

async function saveSong(id: string) {
  try {
    const account = normalizeAccount(await api("/billing/info/"))
    const left = account.downloads?.left
    const clip = normalizeClip(await api(`/clip/${id}`))
    const channel = findChannel(prefs, { workspaceId: clip.workspace?.id })
    const where = channel ? `${prefs.inboxFolder}/suno/${channel.id}` : `${prefs.inboxFolder}/suno`
    const ok = window.confirm(
      `Save "${clip.title}" to MediaMake's library (${where})?\n\nIt uses one of your Suno downloads${
        left !== undefined ? ` (${left} left this month)` : ""
      }.`
    )
    if (!ok) return
    toast("Saving to MediaMake…")
    const result = await ask("save", { clipId: id, channel: channel?.id })
    toast(`Saved: ${result.path}`, "done")
  } catch (error) {
    toast(`Couldn't save: ${errorText(error)}`, "error")
  }
}

const VARIATION_TYPES = [
  { id: "cover", label: "Cover in a new style" },
  { id: "instrumental", label: "Instrumental cover" },
  { id: "extend", label: "Extend it" },
  { id: "reuse", label: "Same lyrics, new style (new song)" },
  { id: "again", label: "Same prompt again" }
]

async function openVariations(id: string) {
  const panel = root().querySelector<HTMLElement>(".panel")!
  panel.hidden = false
  panel.style.right = "24px"
  panel.style.top = "90px"
  panel.replaceChildren(el("h3", {}, "Variations"), el("div", { class: "note" }, "Loading the song…"))
  try {
    const [clip, workspaces] = await Promise.all([normalizeClip(await api(`/clip/${id}`)), reads.workspaces({}) as Promise<SunoWorkspace[]>])
    const channel = findChannel(prefs, { workspaceId: clip.workspace?.id })
    const presets: { name: string; styles: string }[] = channel
      ? await ask("presets", { channel: channel.id }).catch(() => [])
      : []

    const type = el("select", {}, ...VARIATION_TYPES.map((t) => el("option", { value: t.id }, t.label))) as HTMLSelectElement
    const style = el("textarea", { placeholder: "New style (leave empty to keep the song's style)" }) as HTMLTextAreaElement
    const preset = el(
      "select",
      { onchange: () => (style.value = preset.value) },
      el("option", { value: "" }, presets.length ? "Pick a saved style…" : "No saved styles for this channel"),
      ...presets.map((p) => el("option", { value: p.styles }, p.name))
    ) as HTMLSelectElement
    const runs = el("input", { type: "number", min: "1", max: "10", value: "1" }) as HTMLInputElement
    const workspace = el(
      "select",
      {},
      ...workspaces.map((w) => el("option", { value: w.id, selected: w.id === clip.workspace?.id }, w.name))
    ) as HTMLSelectElement
    const channelSelect = el(
      "select",
      {},
      el("option", { value: "" }, prefs.channels.length ? "No channel" : "No channels yet (Claude adds them)"),
      ...prefs.channels.map((c) => el("option", { value: c.id, selected: c.id === channel?.id }, channelLabel(c.id)))
    ) as HTMLSelectElement
    const set = el("input", { value: songSet(clip.title) }) as HTMLInputElement
    const go = el("button", { class: "primary" }, "Make them") as HTMLButtonElement
    go.onclick = async () => {
      go.disabled = true
      try {
        const count = Math.min(Math.max(Number(runs.value) || 1, 1), 10)
        const result = await ask("variations", {
          clipId: id,
          type: type.value,
          styles: style.value.trim() || undefined,
          runs: count,
          workspaceId: workspace.value || undefined,
          channel: channelSelect.value || undefined,
          set: set.value.trim() || undefined
        })
        toast(result?.note ?? `Started ${count} run${count > 1 ? "s" : ""} (two songs each) in a Browse Hack Suno tab.`, "done")
        panel.hidden = true
      } catch (error) {
        toast(errorText(error), "error")
      } finally {
        go.disabled = false
      }
    }
    panel.replaceChildren(
      el("h3", {}, `Variations of "${clip.title}"`),
      el("label", {}, "What to make"),
      type,
      el("label", {}, "Style"),
      preset,
      style,
      el("div", { class: "row" }, el("div", {}, el("label", {}, "Runs (2 songs each)"), runs), el("div", {}, el("label", {}, "Suno workspace"), workspace)),
      el("div", { class: "row" }, el("div", {}, el("label", {}, "MediaMake channel"), channelSelect), el("div", {}, el("label", {}, "Song folder"), set)),
      el("div", { class: "note" }, `Each run costs credits, like pressing Create. Takes are recorded under the channel; Save the ones you keep.`),
      el("div", { class: "actions" }, el("button", { onclick: () => (panel.hidden = true) }, "Cancel"), go)
    )
  } catch (error) {
    panel.replaceChildren(el("h3", {}, "Variations"), el("div", { class: "note" }, errorText(error)), el("div", { class: "actions" }, el("button", { onclick: () => (panel.hidden = true) }, "Close")))
  }
}

// The Create form's bar: channel, Save as preset, Run ×N.
let running = false

async function runTimes(count: number, channel?: string) {
  running = true
  render()
  try {
    for (let i = 1; i <= count; i++) {
      toast(`Run ${i} of ${count}: pressing Create…`)
      const since = Date.now()
      clickCreate()
      let outcome = await awaitOutcome(since, 60_000)
      if ("captcha" in outcome) {
        toast("Suno wants a quick check. Clear it, and the runs carry on.", "error")
        outcome = await awaitOutcome(since, 300_000, false)
      }
      if (!("clipIds" in outcome)) {
        const why = "refused" in outcome ? outcome.refused : "error" in outcome ? outcome.error : "Suno didn't answer"
        toast(`Run ${i} stopped: ${why}`, "error")
        break
      }
      if (channel) ask("record", { clipIds: outcome.clipIds, channel }).catch(() => {})
      if (i < count) await sleep(6000)
    }
    toast("Runs finished.", "done")
  } catch (error) {
    toast(errorText(error), "error")
  } finally {
    running = false
    render()
  }
}

function renderBar() {
  const bar = root().querySelector<HTMLElement>(".bar")!
  const create = document.querySelector<HTMLElement>(SEL.createButton)
  if (pageKind() !== "create" || !create || !uiOn()) {
    bar.hidden = true
    return
  }
  const rect = create.getBoundingClientRect()
  if (!bar.childElementCount) {
    const channel = el(
      "select",
      { title: "MediaMake channel these songs belong to" },
      el("option", { value: "" }, "Channel…"),
      ...prefs.channels.map((c) => el("option", { value: c.id }, channelLabel(c.id)))
    ) as HTMLSelectElement
    const count = el("input", { type: "number", min: "1", max: "20", value: "2", title: "How many times to press Create" }) as HTMLInputElement
    const run = el("button", { class: "primary", title: "Press Create this many times with this form" }, "Run ×N") as HTMLButtonElement
    run.onclick = () => {
      const n = Math.min(Math.max(Number(count.value) || 1, 1), 20)
      if (window.confirm(`Press Create ${n} times with this form? Each one costs credits and makes two songs.`)) {
        runTimes(n, channel.value || undefined)
      }
    }
    const save = el("button", { title: "Save these styles and settings as a preset for the channel" }, "Save as preset") as HTMLButtonElement
    save.onclick = async () => {
      if (!channel.value) return toast("Pick the channel first.", "error")
      const form = readForm()
      const name = window.prompt("Name this preset", (form.styles ?? "").split(",")[0]?.slice(0, 40) ?? "")
      if (!name) return
      try {
        await ask("savePreset", {
          channel: channel.value,
          preset: { name, styles: form.styles ?? "", excludeStyles: form.excludeStyles ?? "", model: form.model, settings: form.sliders }
        })
        toast(`Saved the preset "${name}".`, "done")
      } catch (error) {
        toast(errorText(error), "error")
      }
    }
    bar.replaceChildren(el("span", { class: "mark" }, "MM"), channel, save, count, run)
  }
  bar.querySelectorAll<HTMLButtonElement>("button").forEach((b) => (b.disabled = running))
  bar.hidden = false
  bar.style.left = `${Math.round(rect.left)}px`
  bar.style.top = `${Math.round(rect.top - 46)}px`
}

function render() {
  if (!document.body) return
  if (!uiOn()) {
    shadow?.querySelectorAll<HTMLElement>(".tools, .panel, .bar").forEach((node) => (node.hidden = true))
    return
  }
  renderBar()
  const id = location.pathname.match(/^\/song\/([0-9a-f-]{36})/i)?.[1]
  if (id) showTools({ row: document.body, id }, { right: 24, bottom: 96 })
}

setInterval(render, 1000)
