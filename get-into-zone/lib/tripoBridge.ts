// Tripo (studio.tripo3d.ai) for the MCP server and for the buttons on Tripo's
// pages. Reads go through Tripo's own API in any studio.tripo3d.ai tab of this
// profile, with the page's sign-in (contents/tripoPage.ts). Generating and
// exporting happen one at a time in a background "worker" tab Browse Hack opens
// and reuses, so the user's own Tripo tabs are never navigated; a download the
// user starts from a model's page uses that page.
//
// Downloads (lib/tripo/model.ts, downloadVerdict): any model on Tripo, as the
// GLB its page loads for the viewer, or through Tripo's own Export where Tripo
// offers it to the account (its file is caught as Chrome saves it and filed
// into the library inbox). "auto" takes the Export when it's free, else the
// viewer's copy. Each file gets a <file>.source.json with the model's page,
// author, prompt, version, settings, how it was saved and the licence.
// Spending credits (Generate, a gallery model's Export) needs the price agreed
// by the caller.

import { addDownloadRouter, downloadFile } from "./downloads"
import { downloadFinished, inFolder, saveSourceSidecar } from "./libraryFiles"
import {
  downloadVerdict,
  extensionFor,
  fileBase,
  glbFileName,
  isMeshopt,
  licenseFor,
  modelIdOf,
  normalizeAccount,
  normalizeGalleryItem,
  normalizeJob,
  normalizeProject,
  pageOf,
  previewFileName,
  imageExtensionOf,
  imageExtensionOfBytes,
  readExportRules,
  readGenerateJob,
  sourceFieldsFor,
  TRIPO,
  type DownloadRoute,
  type DownloadVia,
  type ExportRules,
  type TripoAccount,
  type TripoModel,
  type Verdict
} from "./tripo/model"
import { WORKSPACE_URL } from "./tripo/selectors"
import { loadTripoPrefs, updateTripoPrefs, withJob, type TripoPrefs } from "./tripoPrefs"
import { openTab, waitForTabLoad } from "./tabs"

const WORKER_KEY = "tripoWorkerTab"
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const NOT_SIGNED_IN = "Tripo isn't signed in in this Chrome profile. Sign in at https://studio.tripo3d.ai, then try again."

type PageState = {
  ok?: boolean
  ready?: boolean
  url?: string
  page?: { kind: string; id?: string }
  signedIn?: boolean
  captcha?: boolean
  form?: { ready: boolean; price?: number; model?: string; mode?: string; tPose?: boolean; generateEnabled: boolean; captcha: boolean }
}

// --- Tabs -------------------------------------------------------------------------

async function ping(tabId: number): Promise<PageState | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: "giz-tripo-ping" })
  } catch {
    return null
  }
}

async function waitReady(tabId: number, test: (s: PageState) => boolean = (s) => !!s.ready, timeoutMs = 45_000) {
  const start = Date.now()
  let last: PageState | null = null
  while (Date.now() - start < timeoutMs) {
    last = await ping(tabId)
    if (last?.ok && last.ready && last.signedIn === false) throw new Error(NOT_SIGNED_IN)
    if (last?.ok && test(last)) return last
    await sleep(500)
  }
  throw new Error(`studio.tripo3d.ai didn't finish loading in tab ${tabId}${last?.url ? ` (${last.url})` : ""}.`)
}

async function liveTripoTab(id: unknown) {
  if (typeof id !== "number") return undefined
  const tab = await chrome.tabs.get(id).catch(() => undefined)
  return tab?.url?.startsWith(TRIPO) ? tab : undefined
}

/** Browse Hack's own studio.tripo3d.ai tab, opened in the background the first time. */
async function workerTab() {
  const tab = await liveTripoTab((await chrome.storage.session.get(WORKER_KEY))[WORKER_KEY])
  if (tab?.id) return tab.id
  const created = await openTab(WORKSPACE_URL, false, true)
  if (!created.id) throw new Error("Chrome didn't open a studio.tripo3d.ai tab.")
  await chrome.storage.session.set({ [WORKER_KEY]: created.id })
  await waitReady(created.id)
  return created.id
}

/** Any studio.tripo3d.ai tab to read through: the worker's, else one of the user's, else a new worker. */
async function readTab() {
  const stored = await liveTripoTab((await chrome.storage.session.get(WORKER_KEY))[WORKER_KEY])
  if (stored?.id && (await ping(stored.id))?.ready) return stored.id
  for (const tab of await chrome.tabs.query({ url: `${TRIPO}/*` })) {
    if (tab.id && (await ping(tab.id))?.ready) return tab.id
  }
  return workerTab()
}

async function send<T = any>(tabId: number, msg: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  const reply: any = await Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    sleep(timeoutMs).then(() => ({ ok: false, error: `The Tripo tab took too long (${msg.action}).` }))
  ])
  if (!reply?.ok) throw new Error(reply?.error || "The Tripo tab didn't answer. Reload it and try again.")
  return reply.result as T
}

const read = async <T = any>(op: string, params: Record<string, unknown> = {}) =>
  send<T>(await readTab(), { action: "giz-tripo-read", op, params }, 60_000)

async function goTo(tabId: number, url: string, test: (s: PageState) => boolean = (s) => !!s.ready) {
  await chrome.tabs.update(tabId, { url })
  await sleep(800)
  await waitForTabLoad(tabId, 45_000).catch(() => {})
  return waitReady(tabId, test)
}

async function focus(tabId: number) {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined)
  if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
}

// Generating and exporting happen one at a time.
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => {})
  return run
}

// --- What the account is and may do -----------------------------------------------

interface Context {
  account: TripoAccount
  rules: ExportRules
  prefs: TripoPrefs
}

async function context(): Promise<Context> {
  const { state } = await read<{ state: any }>("account")
  const account = normalizeAccount(state.info, state.payment, state.exportLimit)
  if (!account.signedIn) throw new Error(NOT_SIGNED_IN)
  return { account, rules: readExportRules(state.algorithmConfig), prefs: await loadTripoPrefs() }
}

function needId(input: unknown) {
  const id = modelIdOf(input)
  if (!id) throw new Error(`"${input}" isn't a Tripo model id or a studio.tripo3d.ai model link.`)
  return id
}

async function modelRecord(id: string) {
  const raw = await read("model", { id })
  const model = normalizeProject(raw)
  if (!model) throw new Error(`Tripo has no model ${id} that this account can see.`)
  return { raw, model }
}

const accountSummary = (a: TripoAccount) => ({
  name: a.name,
  plan: a.plan,
  credits: a.credits,
  expiringCredits: a.expiringCredits,
  expiringOn: a.expiringOn,
  exports: a.exports
})

const modelSummary = (m: TripoModel, verdict?: Verdict) => ({
  id: m.id,
  title: m.title,
  pageUrl: m.pageUrl,
  owner: m.owner,
  author: m.ownerName,
  kind: m.kind,
  model: m.model,
  modelVersion: m.modelVersion,
  modelVersions: m.modelVersions.length > 1 ? m.modelVersions : undefined,
  lastStep: m.lastStep,
  status: m.status,
  prompt: m.prompt,
  generation: m.generation,
  visibility: m.visibility,
  createdAt: m.createdAt,
  ...(verdict
    ? {
        download: verdict.ok
          ? {
              route: verdict.route,
              credits: verdict.price,
              usesMonthlyExport: verdict.usesExport || undefined,
              // Tripo's own Export as the other way, when it's offered: the full-quality file.
              export: verdict.route === "viewer" && verdict.export ? { credits: verdict.export.price, usesMonthlyExport: verdict.export.usesExport || undefined } : undefined,
              exportNo: verdict.exportNo
            }
          : { no: verdict.why, needs: verdict.needs, export: verdict.export ? { credits: verdict.export.price, usesMonthlyExport: verdict.export.usesExport || undefined } : undefined }
      }
    : {})
})

async function check(idInput: unknown) {
  const id = needId(idInput)
  const ctx = await context()
  const { model } = await modelRecord(id)
  const verdict = downloadVerdict(model, ctx.account, ctx.rules)
  return {
    model: { id: model.id, title: model.title, owner: model.owner, kind: model.kind, model: model.model, ownerName: model.ownerName },
    verdict,
    account: accountSummary(ctx.account)
  }
}

// --- Downloads ------------------------------------------------------------------------

type Intent = { modelId: string; folder: string; base: string; until: number; started: (id: number) => void }
const intents: Intent[] = []

const fromTripo = (item: chrome.downloads.DownloadItem) =>
  [item.url, item.finalUrl, item.referrer].some((u) => /^(blob:)?https:\/\/([\w-]+\.)*tripo3d\.(ai|com)\//.test(u ?? ""))

/** The next file Tripo's Export saves goes into the inbox under this name. */
function expectExport(modelId: string, folder: string, base: string, timeoutMs = 180_000) {
  let intent!: Intent
  let timer: ReturnType<typeof setTimeout> | undefined
  const started = new Promise<number>((resolve, reject) => {
    intent = { modelId, folder, base, until: Date.now() + timeoutMs, started: resolve }
    timer = setTimeout(() => reject(new Error(`Tripo didn't start the download within ${timeoutMs / 1000} seconds.`)), timeoutMs)
  })
  started.catch(() => {})
  intents.push(intent)
  return {
    started,
    cancel: () => {
      clearTimeout(timer)
      const i = intents.indexOf(intent)
      if (i >= 0) intents.splice(i, 1)
    }
  }
}

/** Files Tripo's own Export saves while Browse Hack expects one. Called from the one onDeterminingFilename listener (downloads.ts). */
function routeTripoDownload(item: chrome.downloads.DownloadItem, suggest: (s?: chrome.downloads.DownloadFilenameSuggestion) => void) {
  if (item.byExtensionId === chrome.runtime.id || !fromTripo(item)) return false
  const intent = intents.find((i) => i.until > Date.now())
  if (!intent) return false
  intents.splice(intents.indexOf(intent), 1)
  suggest({ filename: inFolder(intent.folder, `${intent.base}${extensionFor(item.filename, item.mime)}`), conflictAction: "uniquify" })
  intent.started(item.id)
  return true
}

export function initTripoDownloads() {
  addDownloadRouter(routeTripoDownload)
}

const coverUrl = (raw: any): string | undefined =>
  raw?.cover_image_object?.[0]?.sizes?.find((s: any) => s?.name === "large")?.url ??
  raw?.cover_image_object?.[0]?.url ??
  (Array.isArray(raw?.cover_image) ? raw.cover_image[0] : undefined) ??
  raw?.operator?.cover_image_object?.[0]?.url

/** The preview's real type: its first bytes, else its link. */
async function pictureExtension(url: string) {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-31" } })
    if (response.ok) return imageExtensionOfBytes(new Uint8Array(await response.arrayBuffer()).slice(0, 32)) ?? imageExtensionOf(url)
  } catch {}
  return imageExtensionOf(url)
}

async function saveFile(url: string, folder: string, name: string) {
  const requested = inFolder(folder, name)
  const id = await downloadFile({ url, filename: requested, conflictAction: "uniquify", saveAs: false })
  const saved = await Promise.race([
    downloadFinished(id),
    sleep(600_000).then(() => {
      throw new Error("The download took longer than 10 minutes.")
    })
  ])
  return { requested, saved }
}

export interface DownloadParams {
  id: string
  /** "auto" (default): Tripo's Export when it's free, else the viewer's copy, else a paid Export. */
  via?: DownloadVia
  /** Credits the user agreed Tripo may charge for this one (a gallery model's Export). */
  approvedCredits?: number
  /** Relative to Downloads; default <inbox>/tripo. */
  folder?: string
  preview?: boolean
  /** The page the user pressed the button on (a tab Browse Hack may use for the Export). */
  tabId?: number
  pageUrl?: string
}

function readVia(value: unknown): DownloadVia {
  if (value === undefined || value === null || value === "" || value === "auto") return "auto"
  if (value === "viewer" || value === "export") return value
  throw new Error(`via is "auto", "viewer" or "export"; got "${value}".`)
}

export function downloadModel(p: DownloadParams) {
  return exclusive(async () => {
    const id = needId(p.id)
    const ctx = await context()
    const { raw, model } = await modelRecord(id)
    const verdict = downloadVerdict(model, ctx.account, ctx.rules, readVia(p.via))
    if (!verdict.ok) throw new Error(verdict.why)
    const approved = Number(p.approvedCredits) || 0
    if (verdict.price > approved) {
      throw new Error(
        `Tripo charges ${verdict.price} credits to export "${model.title}" (the account has ${ctx.account.credits ?? "?"}). ` +
          "Ask the user, then pass approvedCredits."
      )
    }
    const folder = p.folder || inFolder(ctx.prefs.inboxFolder, "tripo")
    const pageUrl = p.pageUrl && modelIdOf(p.pageUrl) === id ? p.pageUrl : model.pageUrl
    const warnings: string[] = []
    let route: DownloadRoute = verdict.route!
    let file: { requested: string; saved: string }
    let price = 0
    let meshopt = false

    if (route === "viewer") {
      const url: string | undefined = raw?.model_url || raw?.operator?.model_url
      if (!url) throw new Error("Tripo's viewer has no GLB for this model.")
      meshopt = isMeshopt(url)
      file = await saveFile(url, folder, glbFileName(model, meshopt))
    } else {
      const done = await exportInTab(model, folder, approved, p.tabId)
      if ("needsUser" in done) return done
      file = done.file
      price = done.price
    }

    const license = licenseFor(model, ctx.account, route, verdict.exportNo)
    const sidecar = await saveSourceSidecar(
      file.requested,
      file.saved,
      sourceFieldsFor(model, { route, license, pageUrl, price: price || undefined, meshopt: meshopt || undefined })
    ).catch((error) => {
      warnings.push(`The source.json wasn't written: ${message(error)}`)
      return undefined
    })

    let preview: string | undefined
    const cover = coverUrl(raw)
    if (p.preview !== false && cover) {
      try {
        const saved = await saveFile(cover, folder, previewFileName(model, await pictureExtension(cover)))
        await saveSourceSidecar(saved.requested, saved.saved, sourceFieldsFor(model, { route, license, pageUrl, preview: true }))
        preview = saved.saved
      } catch (error) {
        warnings.push(`The preview picture wasn't saved: ${message(error)}`)
      }
    }
    return {
      id: model.id,
      title: model.title,
      route,
      file: file.saved,
      sidecar,
      preview,
      price,
      license,
      model: model.model,
      ...(warnings.length ? { warnings } : {})
    }
  })
}

/** Tripo's own Export: open it on the model's page, check its price, click it, and catch the file. */
async function exportInTab(model: TripoModel, folder: string, approved: number, userTabId?: number) {
  let tabId: number
  const userTab = typeof userTabId === "number" ? await chrome.tabs.get(userTabId).catch(() => undefined) : undefined
  if (userTab?.id && modelIdOf(userTab.url ?? "") === model.id) {
    tabId = userTab.id
  } else {
    tabId = await workerTab()
    await goTo(tabId, model.pageUrl, (s) => !!s.ready && s.page?.id === model.id)
  }
  const opened: any = await send(tabId, { action: "giz-tripo-export-open" }, 40_000)
  if (opened.captcha) {
    await focus(tabId)
    return { needsUser: "captcha" as const, tabId, message: "Tripo is showing a check (captcha) in the tab. The user clears it there; then run this again." }
  }
  if (opened.blocked) throw new Error(`Tripo didn't open its Export: ${opened.blocked.text}`)
  if (opened.price !== undefined && opened.price > approved) {
    await send(tabId, { action: "giz-tripo-close" }).catch(() => {})
    throw new Error(`Tripo's Export costs ${opened.price} credits here, more than the ${approved} agreed. Ask the user, then pass approvedCredits.`)
  }
  const expected = expectExport(model.id, folder, fileBase(model))
  try {
    const done: any = await send(tabId, { action: "giz-tripo-export", maxPrice: approved, waitMs: 30_000 }, 60_000)
    if (done.refused) throw new Error(done.refused)
    if (done.captcha) {
      await focus(tabId)
      return { needsUser: "captcha" as const, tabId, message: "Tripo is showing a check (captcha) in the tab. The user clears it there; then run this again." }
    }
    if (done.blocked) throw new Error(`Tripo didn't export it: ${done.blocked.text}`)
    if (done.report && !done.report.ok) throw new Error(`Tripo refused the export${done.report.message ? `: ${done.report.message}` : ""}.`)
    const downloadId = await expected.started
    const saved = await Promise.race([
      downloadFinished(downloadId),
      sleep(600_000).then(() => {
        throw new Error("The download took longer than 10 minutes.")
      })
    ])
    const item = (await chrome.downloads.search({ id: downloadId }))[0]
    const requested = inFolder(folder, `${fileBase(model)}${extensionFor(item?.filename ?? saved, item?.mime)}`)
    return { file: { requested, saved }, price: Number(done.price) || 0 }
  } finally {
    expected.cancel()
  }
}

// --- Generating -----------------------------------------------------------------------

async function freshForm() {
  const tabId = await workerTab()
  await goTo(tabId, WORKSPACE_URL, (s) => !!s.ready && !!s.form?.ready)
  return tabId
}

/** Fills Tripo's form and reads the price on its Generate button, without clicking it. */
export function prepare(jobInput: unknown) {
  const job = readGenerateJob(jobInput)
  return exclusive(async () => {
    const ctx = await context()
    const tabId = await freshForm()
    const fill: any = await send(tabId, { action: "giz-tripo-fill", job }, 120_000)
    return { price: fill.form.price, model: fill.form.model, tPose: fill.form.tPose, warnings: fill.warnings, account: accountSummary(ctx.account), tabId }
  })
}

export function generate(p: { job: unknown; maxPrice: number; waitForUserMs?: number }) {
  const job = readGenerateJob(p.job)
  const maxPrice = Number(p.maxPrice) || 0
  return exclusive(async () => {
    const ctx = await context()
    const tabId = await freshForm()
    const fill: any = await send(tabId, { action: "giz-tripo-fill", job }, 120_000)
    const price: number | undefined = fill.form.price
    if (price === undefined) throw new Error("Couldn't read the price on Tripo's Generate button; nothing was generated.")
    if (price > maxPrice) throw new Error(`Generating this costs ${price} credits, more than the ${maxPrice} agreed; nothing was generated.`)
    if (ctx.account.credits !== undefined && ctx.account.credits < price) {
      throw new Error(`Generating this costs ${price} credits and the account has ${ctx.account.credits}; nothing was generated.`)
    }
    let out: any = await send(tabId, { action: "giz-tripo-submit", maxPrice, waitMs: 45_000 }, 75_000)
    if (out.captcha) {
      await focus(tabId)
      return { needsUser: "captcha", tabId, message: "Tripo is showing a check (captcha) in its tab. The user clears it there; then run this again (nothing was generated)." }
    }
    if (out.refused) throw new Error(out.refused)
    if (out.blocked) throw new Error(`Tripo didn't start it: ${out.blocked.text}`)
    if (out.report && !out.report.ok) throw new Error(`Tripo refused it${out.report.message ? `: ${out.report.message}` : ""}.`)
    let projectId: string | undefined = out.projectId
    if (!projectId) {
      // A Generate that answered late: the newest of the account's models, made since the click.
      const mine: any = await read("myModels", { offset: 0, size: 3 }).catch(() => null)
      const newest = normalizeProject(mine?.projects?.[0])
      if (newest?.createdAt && Date.parse(newest.createdAt) > Date.now() - 120_000) projectId = newest.id
    }
    if (!projectId) throw new Error(`Tripo didn't confirm the Generate in time. Check the Browse Hack Tripo tab (tab ${tabId}) and tripo_status.`)
    const { model } = await modelRecord(projectId).catch(() => ({ model: undefined as TripoModel | undefined }))
    const record = {
      projectId,
      operatorId: model?.operatorId ?? out.operatorId,
      mode: job.mode,
      prompt: job.prompt,
      model: out.model ?? fill.form.model,
      price,
      creditsBefore: ctx.account.credits,
      startedAt: new Date().toISOString(),
      status: model?.status ?? "queued"
    }
    await updateTripoPrefs((prefs) => ({ jobs: withJob(prefs.jobs, record) }))
    return { job: record, pageUrl: `${TRIPO}/workspace/generate/${projectId}`, warnings: fill.warnings, tabId }
  })
}

/** A generate job's progress, by project id; the model once it's done. */
export async function jobStatus(idInput: unknown) {
  const projectId = needId(idInput)
  const { model } = await modelRecord(projectId)
  let job = model.operatorId ? normalizeJob((await read<any[]>("progress", { ids: [model.operatorId] }).catch(() => []))?.[0]) : undefined
  if (!job && model.status) job = { operatorId: model.operatorId ?? "", status: model.status, progress: model.status === "success" ? 100 : 0, done: model.status === "success", failed: false }
  if (job) {
    await updateTripoPrefs((prefs) => ({
      jobs: withJob(prefs.jobs, { projectId, operatorId: model.operatorId, startedAt: prefs.jobs.find((j) => j.projectId === projectId)?.startedAt ?? new Date().toISOString(), status: job!.status, ...(job!.done || job!.failed ? { finishedAt: new Date().toISOString() } : {}) })
    }))
  }
  return { projectId, job, model: job?.done ? modelSummary(model) : undefined, pageUrl: `${TRIPO}/workspace/generate/${projectId}` }
}

// --- The MCP server's methods ------------------------------------------------------------

export const tripoCommands: Record<string, (params: any) => Promise<unknown>> = {
  "tripo.status": async () => {
    const tabId = await readTab()
    const page = await ping(tabId)
    const prefs = await loadTripoPrefs()
    let ctx: Context | undefined
    let signInError: string | undefined
    try {
      ctx = await context()
    } catch (error) {
      signInError = message(error)
    }
    const open = prefs.jobs.filter((j) => j.projectId && !j.finishedAt && Date.parse(j.startedAt) > Date.now() - 6 * 3600_000).slice(-3)
    const jobs = []
    for (const j of open) jobs.push(await jobStatus(j.projectId).catch((error) => ({ projectId: j.projectId, error: message(error) })))
    return {
      signedIn: Boolean(ctx),
      ...(signInError ? { note: signInError } : {}),
      account: ctx ? accountSummary(ctx.account) : undefined,
      exportRules: ctx
        ? {
            membersOnlyVersions: ctx.rules.membersOnlyVersions,
            planExportsMembersOnlyVersions: ctx.rules.restrictedPlans[ctx.account.planType] === true,
            galleryExportCredits: ctx.rules.galleryExportPrice
          }
        : undefined,
      currentJobs: jobs,
      recentJobs: prefs.jobs.slice(-5),
      tab: { id: tabId, url: page?.url, captcha: page?.captcha || undefined },
      createForm: page?.form ? { ready: page.form.ready, price: page.form.price, model: page.form.model } : undefined,
      inboxFolder: `${prefs.inboxFolder}/tripo`
    }
  },
  "tripo.myModels": async ({ offset, limit }) => {
    const ctx = await context()
    const data: any = await read("myModels", { offset: Number(offset) || 0, size: Math.min(Number(limit) || 20, 20) })
    const models = (Array.isArray(data?.projects) ? data.projects : [])
      .map(normalizeProject)
      .filter(Boolean)
      .map((m: TripoModel) => modelSummary(m, downloadVerdict(m, ctx.account, ctx.rules)))
    const next = (Number(offset) || 0) + models.length
    return { total: data?.total, models, nextOffset: next < Number(data?.total ?? 0) ? next : undefined, account: accountSummary(ctx.account) }
  },
  "tripo.search": async ({ query, pageToken, limit }) => {
    const data: any = await read("search", { query: String(query ?? ""), pageToken, pageSize: Number(limit) || 20 })
    return {
      models: (Array.isArray(data?.items) ? data.items : []).map(normalizeGalleryItem).filter(Boolean),
      nextPageToken: data?.nextPageToken || undefined
    }
  },
  "tripo.model": async ({ id, via }) => {
    const ctx = await context()
    const { model } = await modelRecord(needId(id))
    return modelSummary(model, downloadVerdict(model, ctx.account, ctx.rules, readVia(via)))
  },
  "tripo.download": async (params) => downloadModel(params as DownloadParams),
  "tripo.prepare": async ({ job }) => prepare(job),
  "tripo.generate": async (params) => generate(params as any),
  "tripo.job": async ({ id }) => jobStatus(id),
  /** The MCP server passes on the library's inbox (~/.mediamake/config.json). */
  "tripo.syncLibrary": async ({ inboxFolder }) => {
    const prefs = await updateTripoPrefs((p) => ({ inboxFolder: typeof inboxFolder === "string" && inboxFolder ? inboxFolder : p.inboxFolder }))
    return { inboxFolder: prefs.inboxFolder }
  }
}

// --- The buttons on Tripo's pages ---------------------------------------------------------

export function handleTripoUi(request: any, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) {
  const reply = (work: Promise<unknown>) => {
    work.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: message(error) })
    )
    return true
  }
  // Only Browse Hack's own panel on a Tripo page asks here.
  if (!sender.tab?.url?.startsWith(TRIPO) || sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: "Only the Browse Hack panel on a Tripo page can do this." })
    return false
  }
  switch (request.op) {
    case "check":
      return reply(check(request.id))
    case "download":
      return reply(
        downloadModel({
          id: String(request.id),
          via: readVia(request.via),
          approvedCredits: Number(request.approvedCredits) || 0,
          tabId: sender.tab.id,
          pageUrl: typeof request.pageUrl === "string" && pageOf(request.pageUrl).id ? request.pageUrl : undefined
        }).then((done: any) => {
          if (done?.needsUser) throw new Error(done.message)
          return done
        })
      )
  }
  sendResponse({ ok: false, error: `Unknown request: ${request.op}` })
  return false
}
