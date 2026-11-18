import type { PlasmoCSConfig } from "plasmo"

import { pageOf, type TripoGenerateJob } from "../lib/tripo/model"
import { blockerShown, captchaVisible, clickGenerate, closeDialogs, confirmExport, fillForm, openExport, readForm, waitFor } from "../lib/tripo/page"
import { SEL } from "../lib/tripo/selectors"

// Browse Hack on studio.tripo3d.ai. For the background worker
// (lib/tripoBridge.ts) it reads the account, the user's models, a model's
// record, the gallery search and a job's progress through contents/tripoPage.ts
// (which runs in Tripo's own page, with its sign-in); fills the create form and
// clicks Generate; opens a model's Export and clicks it. For the user it adds
// a "MediaMake" button to model pages and gallery cards: it saves the model's
// GLB (the viewer's copy, or Tripo's own Export where that's free or the user
// picks it) and its preview picture into MediaMake's library inbox with a
// source.json.

export const config: PlasmoCSConfig = {
  matches: ["https://studio.tripo3d.ai/*"],
  run_at: "document_idle"
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// --- Tripo's page (contents/tripoPage.ts) -----------------------------------------------

type Report = { type: "generate" | "export"; at: number; ok: boolean; status?: number; code?: number; message?: string; projectId?: string; operatorId?: string; ids?: string[]; operation?: string }
const reports: Report[] = []
const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()

window.addEventListener("message", (event) => {
  const data = event.data
  if (event.source !== window || data?.source !== "browse-hack-tripo") return
  if (data.type === "reply") {
    const w = waiting.get(data.id)
    if (!w) return
    waiting.delete(data.id)
    data.ok ? w.resolve(data.result) : w.reject(new Error(data.error || "Tripo's page didn't answer."))
  } else if (data.type === "generate" || data.type === "export") {
    reports.push({ ...data, at: Date.now() })
    if (reports.length > 20) reports.shift()
  }
})

function page<T = any>(op: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
  const id = crypto.randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(id)
      reject(new Error("Tripo's page didn't answer in time. Reload the tab and try again."))
    }, timeoutMs)
    waiting.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e))
    })
    window.postMessage({ source: "browse-hack-tripo-cs", id, op, params }, location.origin)
  })
}

const api = <T = any>(method: "GET" | "POST", path: string, extra: { query?: Record<string, unknown>; body?: unknown } = {}) =>
  page<T>("api", { method, path, ...extra })

const reads: Record<string, (params: any) => Promise<unknown>> = {
  account: async () => {
    const state = await page("state", {}, 10_000)
    if (!state?.ready) throw new Error("Tripo's page hasn't finished loading.")
    if (!state.info) return { state }
    // Fresh numbers: the stores hold what the page loaded with.
    const [payment, exportLimit] = await Promise.all([
      api("GET", "/v2/studio/user/profile/payment").catch(() => state.payment),
      api("GET", "/v2/studio/marketing/export-limit").catch(() => ({ export_limit: state.exportLimit }))
    ])
    return { state: { ...state, payment: payment ?? state.payment, exportLimit: exportLimit?.export_limit ?? state.exportLimit } }
  },
  myModels: async ({ offset, size }) =>
    api("GET", "/v2/studio/assets/v2", {
      query: { asset_type: "mine", type: "all", locale: "en", offset: Number(offset) || 0, size: Math.min(Math.max(Number(size) || 20, 1), 20) }
    }),
  model: async ({ id }) => api("GET", `/v2/studio/project/detail/v3/${String(id)}`, { query: { locale: "en" } }),
  search: async ({ query, pageToken, pageSize }) => page("search", { query, pageToken, pageSize }),
  progress: async ({ ids }) => api("POST", "/v2/studio/progress", { body: { ids: Array.isArray(ids) ? ids : [] } })
}

async function pingState() {
  const state = await page("state", {}, 3000).catch(() => null)
  return {
    ok: true,
    ready: document.readyState === "complete" && Boolean(state?.ready),
    url: location.href,
    page: pageOf(location.href),
    signedIn: state?.ready ? Boolean(state.info) : undefined,
    captcha: captchaVisible(),
    form: pageOf(location.href).kind === "generate" || pageOf(location.href).kind === "workspace" ? readForm() : undefined
  }
}

/** After Generate: Tripo's answer to the site's own request, the page moving to the new model, or what it showed instead. */
async function awaitGenerate(since: number, waitMs: number) {
  const startUrl = location.href
  const outcome = await waitFor(() => {
    const report = reports.find((r) => r.type === "generate" && r.at >= since)
    if (report) return { report }
    const now = pageOf(location.href)
    if (location.href !== startUrl && now.kind === "workspace" && now.id) return { projectId: now.id }
    if (captchaVisible()) return { captcha: true }
    const blocked = blockerShown()
    if (blocked) return { blocked }
    return undefined
  }, waitMs, 300)
  if (!outcome) return { timedOut: true }
  if ((outcome as any).report) {
    const report = (outcome as any).report as Report
    // The page moves to the new model a moment later; its link has the project id.
    const moved = await waitFor(() => {
      const now = pageOf(location.href)
      return now.kind === "workspace" ? now.id : undefined
    }, 8000, 300)
    return { report, projectId: moved ?? report.projectId, operatorId: report.operatorId, ids: report.ids }
  }
  return outcome
}

async function awaitExport(since: number, waitMs: number) {
  const outcome = await waitFor(() => {
    const report = reports.find((r) => r.type === "export" && r.at >= since)
    if (report) return { report }
    if (captchaVisible()) return { captcha: true }
    const blocked = blockerShown()
    if (blocked) return { blocked }
    return undefined
  }, waitMs, 300)
  return outcome ?? { timedOut: true }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (work: Promise<unknown> | unknown) => {
    Promise.resolve(work).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: errorText(error) })
    )
    return true
  }
  switch (msg?.action) {
    case "giz-tripo-ping":
      pingState().then(sendResponse)
      return true
    case "giz-tripo-read": {
      const read = reads[String(msg.op)]
      return reply(read ? read(msg.params ?? {}) : Promise.reject(new Error(`Unknown read ${msg.op}`)))
    }
    case "giz-tripo-fill":
      return reply(fillForm(msg.job as TripoGenerateJob))
    case "giz-tripo-submit":
      return reply(
        (async () => {
          const clicked: any = await clickGenerate(Number(msg.maxPrice) || 0)
          if (!clicked.clicked) return clicked
          const after = await awaitGenerate(clicked.at - 500, Number(msg.waitMs) || 45_000)
          return { ...after, price: clicked.form.price, model: clicked.form.model }
        })()
      )
    case "giz-tripo-export-open":
      return reply(openExport())
    case "giz-tripo-export":
      return reply(
        (async () => {
          const clicked: any = await confirmExport(Number(msg.maxPrice) || 0)
          if (!clicked.clicked) return clicked
          const after = await awaitExport(clicked.at - 500, Number(msg.waitMs) || 30_000)
          return { ...after, price: clicked.price }
        })()
      )
    case "giz-tripo-close":
      closeDialogs()
      sendResponse({ ok: true })
      return
  }
})

// --- The MediaMake button ---------------------------------------------------------------

type Route = "export" | "viewer"
type Check = {
  model: { id: string; title: string; owner: boolean; kind?: string; model?: string; ownerName?: string }
  verdict: { ok: boolean; route?: Route; price: number; why?: string; needs?: string; usesExport?: boolean; export?: { price: number; usesExport: boolean } }
  account: { plan: string; credits?: number; exports?: { left: number; total: number } }
  alreadyHave?: string
}

const ui = (op: string, params: Record<string, unknown> = {}) =>
  chrome.runtime.sendMessage({ action: "tripo-ui", op, ...params }).then((r: any) => {
    if (!r?.ok) throw new Error(r?.error || "Browse Hack didn't answer.")
    return r.result
  })

let host: HTMLElement | undefined
let panel: HTMLElement | undefined
let pill: HTMLButtonElement | undefined
let selected: string | undefined

const STYLE = `
:host{all:initial}
.pill{position:fixed;right:18px;bottom:88px;z-index:2147483646;font:600 13px/1 system-ui,sans-serif;background:#7c5cff;color:#fff;border:0;border-radius:999px;padding:10px 14px;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.35)}
.pill:hover{background:#6a48ff}
.panel{position:fixed;right:18px;bottom:134px;z-index:2147483647;width:320px;font:13px/1.45 system-ui,sans-serif;color:#eee;background:#17171c;border:1px solid #333;border-radius:12px;padding:14px;box-shadow:0 8px 28px rgba(0,0,0,.5)}
.panel h4{margin:0 0 6px;font-size:14px;color:#fff}
.muted{color:#9a9aa6;font-size:12px}
.row{margin-top:10px;display:flex;gap:8px;flex-wrap:wrap}
button.act{font:600 12px system-ui,sans-serif;border:0;border-radius:8px;padding:8px 10px;cursor:pointer;background:#f5d547;color:#111}
button.act.secondary{background:#2b2b33;color:#eee}
button.act:disabled{opacity:.5;cursor:default}
.why{margin-top:8px;color:#ffb4a8}
.ok{margin-top:8px;color:#9be3a8;word-break:break-all}
label{display:flex;gap:6px;align-items:flex-start;margin-top:10px;font-size:12px;color:#ccc}
input[type=text]{width:100%;box-sizing:border-box;margin-top:6px;background:#0f0f13;color:#eee;border:1px solid #333;border-radius:6px;padding:6px;font:12px system-ui}
.x{position:absolute;right:10px;top:8px;background:none;border:0;color:#999;font-size:16px;cursor:pointer}
`

function ensureHost() {
  if (host?.isConnected) return host.shadowRoot!
  host = document.createElement("div")
  host.id = "browse-hack-tripo"
  const root = host.attachShadow({ mode: "open" })
  const style = document.createElement("style")
  style.textContent = STYLE
  root.append(style)
  document.documentElement.append(host)
  return root
}

function showPill(show: boolean) {
  const root = ensureHost()
  if (!pill) {
    pill = document.createElement("button")
    pill.className = "pill"
    pill.textContent = "⬇ MediaMake"
    pill.title = "Browse Hack: save this model to MediaMake's library"
    pill.addEventListener("click", () => {
      const id = pageOf(location.href).id
      if (id) openPanel(id)
    })
    root.append(pill)
  }
  pill.style.display = show ? "" : "none"
}

function closePanel() {
  panel?.remove()
  panel = undefined
  selected = undefined
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string)[]) {
  const node = document.createElement(tag)
  Object.assign(node, props)
  node.append(...children)
  return node
}

async function openPanel(id: string) {
  const root = ensureHost()
  closePanel()
  selected = id
  panel = el("div", { className: "panel" }, el("button", { className: "x", textContent: "×", onclick: closePanel }), el("div", { className: "muted", textContent: "Checking what Tripo lets this account download…" }))
  root.append(panel)
  let check: Check
  try {
    check = await ui("check", { id })
  } catch (error) {
    if (selected === id) renderError(errorText(error))
    return
  }
  if (selected === id) renderCheck(check)
}

function renderError(text: string) {
  if (!panel) return
  panel.replaceChildren(el("button", { className: "x", textContent: "×", onclick: closePanel }), el("h4", { textContent: "Browse Hack" }), el("div", { className: "why", textContent: text }))
}

function renderCheck(check: Check) {
  if (!panel) return
  const { model, verdict, account } = check
  const status = el("div")
  const who = model.owner ? (model.kind === "preset" ? "Tripo demo model" : "Your model") : `By ${model.ownerName ?? "another Tripo user"}`
  const exportHow = (price: number, usesExport?: boolean) =>
    `Tripo's own Export${price ? `: ${price} credits` : ""}${usesExport && account.exports ? `, one of your ${account.exports.left} exports left this month` : ""}`
  const children: (Node | string)[] = [
    el("button", { className: "x", textContent: "×", onclick: closePanel }),
    el("h4", { textContent: model.title }),
    el("div", { className: "muted", textContent: `${who}${model.model ? ` · Tripo ${model.model}` : ""} · ${account.plan} plan${account.credits !== undefined ? ` · ${account.credits} credits` : ""}` })
  ]
  if (check.alreadyHave) children.push(el("div", { className: "ok", textContent: `Already in the library inbox: ${check.alreadyHave}` }))
  if (verdict.ok && verdict.route) {
    children.push(
      el("div", {
        className: "muted",
        textContent: verdict.route === "viewer" ? "Saves the GLB Tripo's viewer shows (meshopt-compressed), at no cost." : `Through ${exportHow(verdict.price, verdict.usesExport)}.`
      })
    )
    const row = el("div", { className: "row" })
    row.append(saveButton(model.id, verdict.route, verdict.price, verdict.price ? `Export and save (${verdict.price} credits)` : "Save GLB to MediaMake", status))
    // Tripo's Export as the other way, when it's offered: the full-quality file.
    if (verdict.route === "viewer" && verdict.export) {
      const price = verdict.export.price
      row.append(saveButton(model.id, "export", price, `Export with Tripo${price ? ` (${price} credits)` : ""}`, status, true))
      children.push(row, el("div", { className: "muted", textContent: `Or the full-quality file through ${exportHow(price, verdict.export.usesExport)}.` }))
    } else {
      children.push(row)
    }
  } else {
    children.push(el("div", { className: "why", textContent: verdict.why ?? "Browse Hack can't download this model." }))
  }
  children.push(status)
  panel.replaceChildren(...children)
}

/** A save button; one that spends credits asks for a second click first. */
function saveButton(id: string, via: Route, price: number, label: string, status: HTMLElement, secondary = false) {
  const button = el("button", { className: secondary ? "act secondary" : "act", textContent: label })
  let armed = !price
  button.onclick = async () => {
    if (!armed) {
      armed = true
      button.textContent = `Click again to spend ${price} credits`
      return
    }
    button.disabled = true
    status.replaceChildren(el("div", { className: "muted", textContent: "Saving…" }))
    try {
      const done: any = await ui("download", { id, via, approvedCredits: price, pageUrl: location.href })
      status.replaceChildren(el("div", { className: "ok", textContent: `Saved ${done.file}${done.preview ? " and its preview" : ""}, with source.json.` }))
    } catch (error) {
      button.disabled = false
      status.replaceChildren(el("div", { className: "why", textContent: errorText(error) }))
    }
  }
  return button
}

// A small button on each gallery card.
function decorateCards() {
  for (const link of document.querySelectorAll<HTMLAnchorElement>(SEL.modelLink)) {
    if (link.dataset.bhTripo) continue
    const id = pageOf(new URL(link.getAttribute("href")!, location.origin).href).id
    if (!id || !link.querySelector("img")) continue
    link.dataset.bhTripo = "1"
    const button = document.createElement("button")
    button.textContent = "⬇"
    button.title = "Browse Hack: save to MediaMake"
    Object.assign(button.style, {
      position: "absolute",
      top: "8px",
      right: "8px",
      zIndex: "5",
      width: "28px",
      height: "28px",
      borderRadius: "50%",
      border: "0",
      background: "rgba(124,92,255,.9)",
      color: "#fff",
      cursor: "pointer",
      font: "600 14px system-ui"
    })
    button.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      openPanel(id)
    })
    if (getComputedStyle(link).position === "static") link.style.position = "relative"
    link.append(button)
  }
}

let scheduled = false
function refresh() {
  if (scheduled) return
  scheduled = true
  setTimeout(() => {
    scheduled = false
    const now = pageOf(location.href)
    showPill(Boolean(now.id))
    if (selected && now.id && selected !== now.id && panel) closePanel()
    decorateCards()
  }, 400)
}

new MutationObserver(refresh).observe(document.documentElement, { childList: true, subtree: true })
refresh()

