import type { PlasmoCSConfig } from "plasmo"

// Runs in studio.tripo3d.ai's own page (not the extension's isolated world),
// where Tripo's app and its sign-in live. contents/tripo.ts asks it, by
// window messages, for what the site itself knows or fetches: the signed-in
// account, plan, credits and export rules (the app's Pinia stores), a few of
// api.tripo3d.ai's reads (which go with the page's cookies), and the gallery
// search (through the app's own client, which adds its sign-in header). Only
// those answers leave the page: no cookie, token or email is read or passed
// on. It also reports how Tripo answered the site's own Generate and Export
// requests (ok, or the message), so a refusal is known at once.

export const config: PlasmoCSConfig = {
  matches: ["https://studio.tripo3d.ai/*"],
  world: "MAIN",
  run_at: "document_start"
}

const SOURCE = "browse-hack-tripo"
const API = "https://api.tripo3d.ai"
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

// The reads Browse Hack makes, and nothing else.
const READS: { method: "GET" | "POST"; path: RegExp }[] = [
  { method: "GET", path: /^\/v2\/studio\/user\/profile\/payment$/ },
  { method: "GET", path: /^\/v2\/studio\/marketing\/export-limit$/ },
  { method: "GET", path: /^\/v2\/studio\/assets\/v2$/ },
  { method: "GET", path: new RegExp(`^/v2/studio/project/detail/v3/${UUID}$`, "i") },
  { method: "POST", path: /^\/v2\/studio\/progress$/ }
]

const nuxtApp = (): any => (document.querySelector("#__nuxt") as any)?.__vue_app__?.config?.globalProperties?.$nuxt

function stores(): Record<string, any> | undefined {
  return nuxtApp()?.$pinia?.state?.value
}

/** The account and Tripo's rules as the app holds them; no email, no token. */
function state() {
  const s = stores()
  if (!s) return { ready: false }
  const user = s["feature-user"] ?? {}
  const config = s["config-store"] ?? {}
  const algo = config.algorithmConfig ?? {}
  const info = user.info ?? {}
  return {
    ready: true,
    info: info.userId ? { userId: String(info.userId), nickName: info.nickName } : null,
    payment: user.payment ? { member: user.payment.member, subscription: user.payment.subscription, wallet: user.payment.wallet } : null,
    exportLimit: config.exportLimit ?? null,
    algorithmConfig: {
      credits: algo.credits ?? null,
      exportRules: algo.exportRules ?? null,
      permissions: algo.permissions?.ExportRestrictedModel ? { ExportRestrictedModel: algo.permissions.ExportRestrictedModel } : null
    }
  }
}

async function api(params: { method?: string; path?: string; query?: Record<string, unknown>; body?: unknown }) {
  const method = params.method === "POST" ? "POST" : "GET"
  const path = String(params.path ?? "")
  if (!READS.some((r) => r.method === method && r.path.test(path))) throw new Error(`Browse Hack doesn't read ${method} ${path} on Tripo.`)
  const url = new URL(path, API)
  for (const [k, v] of Object.entries(params.query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  const response = await fetch(url.href, {
    method,
    credentials: "include",
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? JSON.stringify(params.body ?? {}) : undefined
  })
  const json: any = await response.json().catch(() => null)
  if (response.status === 401 || json?.code === 401) throw new Error("Tripo isn't signed in in this Chrome profile. Sign in at https://studio.tripo3d.ai, then try again.")
  if (!response.ok || (json && json.code !== 0)) {
    throw new Error(`Tripo answered ${response.status}${json?.message ? `: ${json.message}` : ""} (${path.replace(new RegExp(UUID, "i"), "<id>")}).`)
  }
  return json?.data
}

async function search(params: { query?: string; pageToken?: string; pageSize?: number }) {
  const app = nuxtApp()
  if (typeof app?.$micro !== "function") throw new Error("Tripo's page hasn't finished loading.")
  return app.$micro(
    "/tripo.community.api.search.SearchService/SearchItems",
    {
      appId: "tripo",
      scope: 1,
      search: {
        filter: { itemTypes: ["project_3d"] },
        pageSize: Math.min(Math.max(Number(params.pageSize) || 20, 1), 50),
        pageToken: params.pageToken || undefined,
        query: String(params.query ?? ""),
        sort: 1
      }
    },
    { headers: { "X-Micro-Service": "tripo.community.api.search" } }
  )
}

const OPS: Record<string, (params: any) => unknown> = { state, api, search }

window.addEventListener("message", (event) => {
  const data = event.data
  if (event.source !== window || data?.source !== "browse-hack-tripo-cs" || typeof data.op !== "string") return
  // The app's stores are Vue proxies, which postMessage can't copy: send plain JSON.
  const reply = (ok: boolean, result?: unknown, error?: string) => {
    try {
      const plain = result === undefined ? undefined : JSON.parse(JSON.stringify(result))
      window.postMessage({ source: SOURCE, type: "reply", id: data.id, ok, result: plain, error }, location.origin)
    } catch (e) {
      window.postMessage({ source: SOURCE, type: "reply", id: data.id, ok: false, error: `Tripo's answer couldn't be read: ${e instanceof Error ? e.message : e}` }, location.origin)
    }
  }
  const op = OPS[data.op]
  if (!op) return reply(false, undefined, `Unknown op ${data.op}`)
  Promise.resolve()
    .then(() => op(data.params ?? {}))
    .then(
      (result) => reply(true, result),
      (error) => reply(false, undefined, error instanceof Error ? error.message : String(error))
    )
})

// --- How Tripo answered the site's own Generate and Export -------------------------

const GENERATE = /\/v2\/studio\/operation\/(text_to_model|image_to_model|multiview_to_model|batch_image_to_model)$/
const EXPORT = /\/v2\/studio\/operation\/(export|export-public-model|export-lite|download_with_name|export-batch)$/
const idsIn = (value: unknown) => [...new Set((JSON.stringify(value ?? null).match(new RegExp(UUID, "gi")) ?? []).map((s) => s.toLowerCase()))]

const pickIds = (data: any) => ({
  projectId: typeof data?.project_id === "string" ? data.project_id : typeof data?.project?.id === "string" ? data.project.id : undefined,
  operatorId: typeof data?.operator_id === "string" ? data.operator_id : typeof data?.task_id === "string" ? data.task_id : undefined
})

function report(kind: "generate" | "export", path: string, status: number, body: any) {
  const data = body?.data
  window.postMessage(
    {
      source: SOURCE,
      type: kind,
      operation: path.split("/").pop(),
      ok: status >= 200 && status < 300 && (body?.code === undefined || body.code === 0),
      status,
      code: body?.code,
      message: typeof body?.message === "string" ? body.message.slice(0, 300) : undefined,
      ...(kind === "generate" ? { ...pickIds(data), ids: idsIn(data).slice(0, 6) } : {})
    },
    location.origin
  )
}

const originalFetch = window.fetch
window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
  const response = await originalFetch.call(this, input, init)
  try {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const path = new URL(href, location.href).pathname
    const kind = GENERATE.test(path) ? "generate" : EXPORT.test(path) ? "export" : undefined
    if (kind) {
      response
        .clone()
        .json()
        .then(
          (body) => report(kind, path, response.status, body),
          () => report(kind, path, response.status, null)
        )
    }
  } catch {}
  return response
}
