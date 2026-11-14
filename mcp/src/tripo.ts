// Tripo (studio.tripo3d.ai) through Browse Hack, on this server's side. The
// extension does what happens on Tripo's pages (get-into-zone/lib/tripoBridge.ts):
// reads with the page's sign-in, Generate and Export one at a time in its own
// Tripo tab, and files each download into MediaMake's library inbox with a
// <file>.source.json. Here the tools check what the library already has, keep
// spending inside what the user agreed (approvedCredits: each Generate and each
// gallery Export costs Tripo credits), refuse when the account is short, and
// wait for a generate job to finish.
//
// Downloads: any model on Tripo, as the GLB its viewer shows or through Tripo's
// own Export where Tripo offers it ("auto" takes the Export when it's free).

import type { Bridge } from "./bridge.js"
import { canLookup, downloadsFolder, findMedia, inboxFolder, readLibrary, type Library } from "./library.js"
import { toSource } from "./sources.js"

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE = /^\/(?:3d-model|workspace\/generate)\/(?:[^/]*?-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i

/** A model's id from its id or a studio.tripo3d.ai model link (same rules as the extension's lib/tripo/model.ts). */
export function modelIdOf(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  const text = input.trim()
  if (UUID_ONLY.test(text)) return text.toLowerCase()
  try {
    const url = new URL(text)
    if (url.hostname !== "tripo3d.ai" && !url.hostname.endsWith(".tripo3d.ai")) return undefined
    return PAGE.exec(url.pathname)?.[1].toLowerCase()
  } catch {
    return undefined
  }
}

export const MAX_GENERATE = 4
const POLL_MS = () => Number(process.env.BROWSE_HACK_TRIPO_POLL_MS) || 15_000

export interface CreditCheck {
  ok: boolean
  total: number
  needsApproval?: boolean
  short?: number
  reason?: string
}

/**
 * Whether a batch may spend its credits: the account must have them, and the
 * user must have agreed to at least the total (approvedCredits).
 */
export function creditCheck(p: { balance?: number; pricePerModel: number; count: number; approvedCredits?: number }): CreditCheck {
  const total = p.pricePerModel * p.count
  const each = p.count > 1 ? ` (${p.count} × ${p.pricePerModel})` : ""
  if (p.balance !== undefined && p.balance < total) {
    return {
      ok: false,
      total,
      short: total - p.balance,
      reason: `This needs ${total} Tripo credits${each} and the account has ${p.balance}, so nothing was generated.`
    }
  }
  if (!(typeof p.approvedCredits === "number" && p.approvedCredits >= total)) {
    return {
      ok: false,
      total,
      needsApproval: true,
      reason:
        `This costs ${total} Tripo credits${each}; the account has ${p.balance ?? "an unknown number of"} credits. ` +
        `Nothing was generated: ask the user, then call again with approvedCredits: ${total}.`
    }
  }
  return { ok: true, total }
}

/** Tells the extension where the library's inbox is (relative to Downloads). */
async function syncLibrary(bridge: Bridge, lib: Library) {
  const inbox = inboxFolder(lib)
  if (inbox) await bridge.call("tripo.syncLibrary", { inboxFolder: inbox }, 30_000).catch(() => {})
}

export async function tripoStatus(bridge: Bridge) {
  const lib = readLibrary()
  await syncLibrary(bridge, lib)
  const status = (await bridge.call("tripo.status", {}, 180_000)) as Record<string, unknown>
  return { ...status, library: lib.inbox ? { inbox: lib.inbox, tripoFolder: `${lib.inbox}/tripo` } : undefined }
}

// --- Downloads ---------------------------------------------------------------------

export interface TripoDownloadParams {
  ids: string[]
  /** "auto" (default): Tripo's Export when free, else the viewer's GLB; "viewer"; "export". */
  via?: "auto" | "viewer" | "export"
  approvedCredits?: number
  folder?: string
  preview?: boolean
  force?: boolean
}

export async function downloadModels(bridge: Bridge, params: TripoDownloadParams) {
  const lib = readLibrary()
  await syncLibrary(bridge, lib)
  const folder = params.folder !== undefined ? downloadsFolder(params.folder, lib.home) : inboxFolder(lib, "tripo")
  let budget = Math.max(Number(params.approvedCredits) || 0, 0)
  const results: Record<string, unknown>[] = []
  for (const input of params.ids) {
    const id = modelIdOf(input)
    if (!id) {
      results.push({ input, error: "Not a Tripo model id or studio.tripo3d.ai model link." })
      continue
    }
    if (!params.force && canLookup(lib, "tripo")) {
      const have = await findMedia("tripo", id, lib)
      if (have) {
        results.push({ id, alreadyHave: have, note: "The media library already has it; pass force: true to download it again." })
        continue
      }
    }
    try {
      const info = (await bridge.call("tripo.model", { id, via: params.via }, 120_000)) as any
      const plan = info?.download ?? {}
      if (plan.no) {
        results.push({ id, title: info.title, notDownloadable: plan.no, needs: plan.needs, ...(plan.export ? { export: plan.export } : {}) })
        continue
      }
      const price = Number(plan.credits) || 0
      if (price > budget) {
        results.push({
          id,
          title: info.title,
          needsApproval: true,
          credits: price,
          note: `Tripo charges ${price} credits to export this gallery model. Ask the user, then pass approvedCredits.`
        })
        continue
      }
      const done = (await bridge.call(
        "tripo.download",
        { id, via: params.via, approvedCredits: price, folder, preview: params.preview },
        15 * 60_000
      )) as any
      if (done?.needsUser) {
        results.push({ id, ...done })
        break
      }
      budget -= Number(done?.price) || 0
      results.push(done)
    } catch (error) {
      results.push({ id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    results,
    ...(params.approvedCredits !== undefined ? { approvedCreditsLeft: budget } : {}),
    folder: folder ?? "the extension's inbox (_INBOX/tripo)"
  }
}

// --- Generating -----------------------------------------------------------------------

export interface TripoGenerateParams {
  prompt?: string
  image?: string
  model?: string
  tPose?: boolean
  texture?: boolean
  textureQuality?: "2K" | "4K" | "8K"
  pbr?: boolean
  removeLighting?: boolean
  topology?: "quad" | "triangle"
  privacy?: "public" | "private"
  count?: number
  approvedCredits?: number
  wait?: boolean
  waitMinutes?: number
  download?: boolean
}

const MIME: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }

/** The image for image to 3D, as base64 (Tripo takes JPG, PNG and WebP up to 20 MB). */
export async function imageFor(value: string) {
  const source = await toSource(value)
  if ("base64" in source) {
    if (!MIME[source.mimeType]) throw new Error("Tripo takes JPG, PNG or WebP images.")
    return { base64: source.base64, mimeType: source.mimeType, name: `image.${MIME[source.mimeType]}` }
  }
  if ("url" in source) {
    const response = await fetch(source.url)
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim()
    if (!response.ok || !MIME[type]) throw new Error(`${source.url}: not a JPG, PNG or WebP image (${response.status} ${type || "no type"}).`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > 20_000_000) throw new Error(`${source.url}: images must be under 20 MB.`)
    return { base64: bytes.toString("base64"), mimeType: type, name: `image.${MIME[type]}` }
  }
  throw new Error("image is an absolute path to a JPG, PNG or WebP file, or its URL.")
}

export async function generateJob(params: TripoGenerateParams) {
  if (!params.prompt?.trim() && !params.image) throw new Error("Give a prompt (text to 3D) or an image (image to 3D).")
  return {
    mode: params.image ? "image" : "text",
    prompt: params.prompt?.trim() || undefined,
    image: params.image ? await imageFor(params.image) : undefined,
    model: params.model,
    tPose: params.tPose,
    texture: params.texture,
    textureQuality: params.textureQuality,
    pbr: params.pbr,
    removeLighting: params.removeLighting,
    topology: params.topology,
    privacy: params.privacy
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Polls a job until its model is finished or failed, or the time is up. */
export async function waitForJob(bridge: Bridge, projectId: string, timeoutMs: number) {
  const end = Date.now() + timeoutMs
  let last: any
  for (;;) {
    last = await bridge.call("tripo.job", { id: projectId }, 120_000).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    if (last?.job?.done || last?.job?.failed) return last
    if (Date.now() + POLL_MS() > end) return { ...last, stillRunning: true }
    await sleep(POLL_MS())
  }
}

export async function generateModels(bridge: Bridge, params: TripoGenerateParams) {
  const count = params.count ?? 1
  if (!Number.isInteger(count) || count < 1 || count > MAX_GENERATE) throw new Error(`count is 1 to ${MAX_GENERATE}.`)
  const job = await generateJob(params)
  const lib = readLibrary()
  await syncLibrary(bridge, lib)

  // The price Tripo's own Generate button shows for these settings, and the balance.
  const prep = (await bridge.call("tripo.prepare", { job }, 240_000)) as any
  const price = Number(prep?.price)
  if (!Number.isFinite(price) || price <= 0) throw new Error("Couldn't read the price on Tripo's Generate button; nothing was generated.")
  const balance = typeof prep?.account?.credits === "number" ? prep.account.credits : undefined
  const check = creditCheck({ balance, pricePerModel: price, count, approvedCredits: params.approvedCredits })
  const summary = { pricePerModel: price, total: check.total, credits: balance, model: prep?.model, tPose: prep?.tPose, plan: prep?.account?.plan }
  if (!check.ok && !check.needsApproval) throw new Error(check.reason)
  if (!check.ok) return { generated: 0, needsApproval: true, ...summary, note: check.reason, warnings: prep?.warnings }

  const waitMs = Math.min(Math.max(params.waitMinutes ?? 20, 1), 60) * 60_000
  const jobs: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const started = (await bridge.call("tripo.generate", { job, maxPrice: price }, 300_000)) as any
    if (started?.needsUser) return { generated: jobs.length, ...summary, jobs, needsUser: started.needsUser, tabId: started.tabId, note: started.message }
    const projectId: string = started.job.projectId
    const entry: Record<string, unknown> = { projectId, pageUrl: started.pageUrl, price: started.job.price, warnings: started.warnings?.length ? started.warnings : undefined }
    jobs.push(entry)
    // Tripo runs one job at a time on the Free plan, so a batch waits for each.
    const waitThis = params.wait !== false || i < count - 1
    if (!waitThis) {
      entry.status = started.job.status
      continue
    }
    const done = await waitForJob(bridge, projectId, waitMs)
    entry.status = done?.job?.status ?? "unknown"
    entry.progress = done?.job?.progress
    if (done?.model) entry.model = done.model
    if (done?.stillRunning) {
      entry.note = "Still generating; tripo_job_status shows its progress."
      break
    }
    if (done?.job?.failed) {
      entry.note = `Tripo says the job ${done.job.status}${done.job.reason ? `: ${done.job.reason}` : ""}.`
      break
    }
    if (params.download && done?.job?.done) {
      entry.download = (await downloadModels(bridge, { ids: [projectId], approvedCredits: 0 })).results[0]
    }
  }
  return { generated: jobs.length, ...summary, jobs }
}
