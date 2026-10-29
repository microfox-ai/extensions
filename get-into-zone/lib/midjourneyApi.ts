// Midjourney jobs through midjourney.com's own API: Editor jobs (outcrop and
// repaint) and Create-tab jobs with image prompts, style / omni references or
// an edit reference. Requests run inside a midjourney.com tab so the user's
// session applies. Endpoints, headers and payloads mirror what the site's own
// code sends (read from its bundle, Oct 2026).
//
// An Editor upload is a PNG with transparency where Midjourney should paint.
// Outcrop leaves the new margin empty. Repaint leaves holes where the user
// brushed; that brush step happens in a Chrome tab, not here.

import { openTab } from "./tabs"

const MJ_ORIGIN = "https://www.midjourney.com"
const CDN = "https://cdn.midjourney.com"
// Edit jobs run on the edit model; the site uses 8.2 unless 8.1 is asked for.
const EDIT_VERSION = "8.2"
const SUBMIT_GAP_MS = 3000
const POLL_MS = 5000
const FAILED = new Set(["error", "cancelled", "canceled"])

export type MjSource =
  | { url: string }
  | { jobId: string; index?: number }
  | { base64: string; mimeType?: string }
  // A style code, only valid as a style reference.
  | { code: string }

export type MjMode = "relaxed" | "fast" | "turbo"

type Placement = { x: number; y: number; width: number; height: number }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// --- Frame sizes ---------------------------------------------------------
// Port of the site's aspect-ratio sizing, so 16:9 is 1456×816 (--ar 91:51)
// like the Editor's buttons.

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)

function snapToBase(w: number, h: number, divisor = 16, base = 1024) {
  const ratio = Math.max(w, h) / Math.min(w, h)
  const long = (Math.floor(base * ratio) + (divisor >> 1)) & ~(divisor - 1)
  return w > h ? { width: long, height: base } : { width: base, height: long }
}

function closestSize(w: number, h: number, maxMegapixels = 1.22, divisor = 16, maxSize = 4096) {
  const limit = maxMegapixels * 1e6
  const ratioOf = h > w ? (a: number, b: number) => a / b : (a: number, b: number) => b / a
  const area = w * h
  const target = ratioOf(w, h)
  let best: { width: number; height: number } | undefined
  let bestScore = Infinity
  for (let i = 1; i <= maxSize / divisor; i++) {
    for (let j = 1; j <= maxSize / divisor; j++) {
      const width = i * divisor
      const height = j * divisor
      if (width * height > limit) continue
      const score =
        Math.abs(width * height - area) / 1e6 + Math.abs(ratioOf(width, height) - target) * 16
      if (score < bestScore) {
        bestScore = score
        best = { width, height }
      }
    }
  }
  return best!
}

export function frameSize(aspectRatio: string) {
  const match = /^\s*(\d+)\s*[:x]\s*(\d+)\s*$/.exec(aspectRatio)
  if (!match || !Number(match[1]) || !Number(match[2])) {
    throw new Error(`Aspect ratio must look like "16:9", got "${aspectRatio}".`)
  }
  const g = gcd(Number(match[1]), Number(match[2]))
  const w = Number(match[1]) / g
  const h = Number(match[2]) / g
  if (Math.max(w, h) / Math.min(w, h) > 4) {
    throw new Error("Aspect ratios wider than 4:1 or taller than 1:4 aren't supported.")
  }
  const snapped = snapToBase(w, h)
  let size = closestSize(snapped.width, snapped.height)
  if (
    (size.width === 1328 || size.width === 1312) &&
    (size.height === 912 || size.height === 896)
  ) {
    size = { width: 1312, height: 912 }
  }
  const d = gcd(size.width, size.height)
  return { ...size, ar: `${size.width / d}:${size.height / d}` }
}

// --- Images ----------------------------------------------------------------

const resultUrl = (jobId: string, index: number) => `${CDN}/${jobId}/0_${index}.png`

// A job's PNGs reach the CDN a few seconds after the job completes, and
// Cloudflare caches the 404 from a request made before then for minutes. A
// fresh query string skips that cached 404.
const READY_WAIT_MS = 40_000
const freshUrl = (url: string) => `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`

async function isImage(url: string) {
  try {
    const resp = await fetch(url, { method: "HEAD", cache: "no-store" })
    return resp.ok && Boolean(resp.headers.get("content-type")?.startsWith("image/"))
  } catch {
    return false
  }
}

/** A URL that serves the job's image, once Midjourney has it on the CDN. */
async function readyResultUrl(jobId: string, index: number, deadline = Date.now() + READY_WAIT_MS) {
  for (;;) {
    const url = freshUrl(resultUrl(jobId, index))
    if (await isImage(url)) return url
    if (Date.now() > deadline) {
      throw new Error(`Image ${index} of job ${jobId} isn't on Midjourney's CDN yet; try again in a minute.`)
    }
    await sleep(2000)
  }
}

function base64ToBlob(base64: string, mimeType = "image/png") {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: mimeType })
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

async function loadSource(source: MjSource): Promise<Blob> {
  if ("base64" in source) return base64ToBlob(source.base64, source.mimeType)
  if ("code" in source) throw new Error("A style code can only be a style reference.")
  const url = "url" in source ? source.url : await readyResultUrl(source.jobId, source.index ?? 0)
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Couldn't load the image (${resp.status}): ${url.split("?")[0]}`)
  const blob = await resp.blob()
  if (!blob.type.startsWith("image/")) throw new Error(`Not an image: ${url.split("?")[0]}`)
  return blob
}

const ANCHORS = [
  "center", "left", "right", "top", "bottom",
  "top-left", "top-right", "bottom-left", "bottom-right"
] as const
export type Anchor = (typeof ANCHORS)[number]

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

// The Editor's outcrop canvas: the full frame, transparent where Midjourney
// should paint, with the source fitted inside (never stretched).
async function composite(
  blob: Blob,
  frame: { width: number; height: number },
  options: { anchor?: Anchor; scale?: number; offset?: { x?: number; y?: number } }
) {
  const bitmap = await createImageBitmap(blob)
  const { width: W, height: H } = frame
  const scale = clamp(options.scale ?? 1, 0.05, 1)
  const fit = Math.min(W / bitmap.width, H / bitmap.height) * scale
  const width = Math.min(W, Math.round(bitmap.width * fit))
  const height = Math.min(H, Math.round(bitmap.height * fit))
  // Less than one 16px tile of new space (e.g. 16:9 into 91:51) isn't worth a job.
  if (W - width < 16 && H - height < 16) {
    throw new Error(
      "Nothing to extend: the image already fills that frame. Pick another aspect ratio or a scale below 1."
    )
  }
  const anchor = options.anchor && ANCHORS.includes(options.anchor) ? options.anchor : "center"
  const baseX = anchor.includes("left") ? 0 : anchor.includes("right") ? W - width : (W - width) / 2
  const baseY = anchor.includes("top") ? 0 : anchor.includes("bottom") ? H - height : (H - height) / 2
  const placement: Placement = {
    x: clamp(Math.round(baseX + (options.offset?.x ?? 0)), 0, W - width),
    y: clamp(Math.round(baseY + (options.offset?.y ?? 0)), 0, H - height),
    width,
    height
  }

  const canvas = new OffscreenCanvas(W, H)
  const ctx = canvas.getContext("2d")!
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(bitmap, placement.x, placement.y, width, height)
  bitmap.close()
  return { png: await canvas.convertToBlob({ type: "image/png" }), placement }
}

// --- In-page calls ---------------------------------------------------------
// These run in the midjourney.com tab (MAIN world) and must stay
// self-contained: they are serialized into the page.

async function uploadInPage(base64: string, mimeType: string, fileName: string, editor: boolean) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const form = new FormData()
  form.append("file", new File([bytes], fileName, { type: mimeType }))
  if (!editor) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    form.append("optimistic_id", Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(""))
  }
  const resp = await fetch(
    editor ? "/api/storage-upload-file?source=editor" : "/api/storage-upload-file",
    { method: "POST", body: form, credentials: "include", headers: { "X-CSRF-Protection": "1" } }
  )
  const text = await resp.text()
  if (!resp.ok) return { ok: false as const, status: resp.status, error: text.slice(0, 300) }
  return { ok: true as const, bucketPathname: String(JSON.parse(text).bucketPathname) }
}

// The body comes as JSON text: executeScript drops null fields from object
// arguments, and Midjourney rejects a body without them.
async function submitInPage(bodyJson: string) {
  const body = JSON.parse(bodyJson)
  const account = await fetch("/api/user-account", {
    credentials: "include",
    headers: { "X-CSRF-Protection": "1" }
  })
  if (!account.ok) return { ok: false as const, status: account.status, error: "" }
  const mjId = (await account.json())?.user?.mjId
  if (!mjId) return { ok: false as const, status: 401, error: "" }
  const resp = await fetch("/api/submit-jobs", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Protection": "1" },
    body: JSON.stringify({ ...body, channelId: `singleplayer_${mjId}` })
  })
  const text = await resp.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    // Keep the text for the error.
  }
  if (!resp.ok) {
    return { ok: false as const, status: resp.status, error: String(data?.error ?? text.slice(0, 300)) }
  }
  return { ok: true as const, data }
}

async function jobStatusInPage(jobIds: string[]) {
  const resp = await fetch("/api/job-status", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", "X-CSRF-Protection": "1" },
    // The endpoint rejects requests without the site's source tag.
    body: JSON.stringify({ jobIds, _frontend_source: "useJobSubmitter_fetchJobStatus" })
  })
  if (!resp.ok) return null
  const jobs = await resp.json()
  return (Array.isArray(jobs) ? jobs : []).map((j: any) => ({
    id: j.id,
    status: j.current_status,
    percentage: j.percentage_complete,
    fullCommand: typeof j.full_command === "string" ? j.full_command : undefined,
    jobType: typeof j.job_type === "string" ? j.job_type : undefined,
    eventType: typeof j.event_type === "string" ? j.event_type : undefined,
    batchSize: Number(j.batch_size) || undefined,
    parentId: typeof j.parent_id === "string" ? j.parent_id : undefined,
    parentGrid: typeof j.parent_grid === "number" ? j.parent_grid : undefined
  }))
}

async function midjourneyTab() {
  const [tab] = await chrome.tabs.query({
    url: `${MJ_ORIGIN}/*`,
    status: "complete",
    discarded: false
  })
  return tab ?? (await openTab(`${MJ_ORIGIN}/imagine`, false))
}

async function runInPage<A extends any[], R>(func: (...args: A) => Promise<R>, args: A): Promise<R> {
  const tab = await midjourneyTab()
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id! },
    world: "MAIN",
    func: func as any,
    args
  })
  return injection?.result as R
}

const UPLOAD_ERRORS: Record<number, string> = {
  401: "Sign in to midjourney.com in this browser first.",
  402: "Uploading images needs a Midjourney subscription.",
  403: "Midjourney's moderation rejected this image.",
  429: "Midjourney is rate-limiting uploads; try again in a minute."
}

// Batches send the same reference image with many prompts; it's uploaded once.
const uploaded = new Map<string, string>()
const UPLOAD_CACHE_SIZE = 500

async function upload(blob: Blob, editor: boolean) {
  if (blob.size > 20_000_000) throw new Error("Images must be under 20 MB.")
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))
  const cacheKey = `${editor ? "e" : "u"}:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`
  const cached = uploaded.get(cacheKey)
  if (cached) return cached

  const mimeType = blob.type || "image/png"
  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png"
  const result = await runInPage(uploadInPage, [
    await blobToBase64(blob),
    mimeType,
    `image.${ext}`,
    editor
  ])
  if (!result?.ok) {
    throw new Error(UPLOAD_ERRORS[result?.status ?? 0] ?? `Upload failed (${result?.status}): ${result?.error}`)
  }
  const url = `${CDN}/${editor ? "e" : "u"}/${result.bucketPathname.replace(/^\//, "")}`
  if (uploaded.size >= UPLOAD_CACHE_SIZE) uploaded.delete(uploaded.keys().next().value!)
  uploaded.set(cacheKey, url)
  return url
}

let lastSubmit = 0

async function submit(body: Record<string, unknown>) {
  const wait = lastSubmit + SUBMIT_GAP_MS - Date.now()
  if (wait > 0) await sleep(wait)
  lastSubmit = Date.now()
  const result = await runInPage(submitInPage, [JSON.stringify(body)])
  if (!result?.ok) {
    throw new Error(
      result?.status === 401
        ? UPLOAD_ERRORS[401]
        : `Midjourney rejected the job (${result?.status}): ${result?.error}`
    )
  }
  const { success = [], failure = [] } = result.data ?? {}
  // Moderation and other refusals come back here, passed on as they are.
  if (success.length === 0) {
    throw new Error(`Midjourney didn't start the job: ${JSON.stringify(failure)}`)
  }
  const job = success[0]
  return {
    jobId: String(job.job_id),
    jobType: job.job_type as string | undefined,
    width: job.meta?.width as number | undefined,
    height: job.meta?.height as number | undefined,
    batchSize: Number(job.meta?.batch_size) || 4,
    failure
  }
}

// --- Prompt flags ------------------------------------------------------------

const hasFlag = (flags: string, name: string) => new RegExp(`(^|\\s)--${name}(\\s|$)`).test(flags)

// Drops a flag and its values, e.g. "--ar 16:9" or "--sref url1 url2".
const dropFlag = (flags: string, name: string) =>
  flags.replace(new RegExp(`(^|\\s)--${name}(?=\\s|$)((\\s+(?!--)\\S+)*)`, "g"), " ")

const joinPrompt = (...parts: (string | undefined | false)[]) =>
  parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

// The text before any "--" parameters, and those parameters merged into extraFlags.
export function splitPrompt(prompt: unknown, extraFlags = "") {
  const raw = typeof prompt === "string" ? prompt.trim() : ""
  const at = raw.search(/(^|\s)--\w/)
  const text = (at < 0 ? raw : raw.slice(0, at)).trim()
  if (!text) throw new Error("A text prompt is required.")
  return { text, flags: joinPrompt(at < 0 ? "" : raw.slice(at), extraFlags) }
}

const jobOptions = (params: { mode?: MjMode; private?: boolean }) => ({
  f: {
    mode: ["relaxed", "fast", "turbo"].includes(params.mode ?? "") ? params.mode : "relaxed",
    private: Boolean(params.private)
  }
})

// --- Jobs --------------------------------------------------------------------

export interface JobResult {
  jobId: string
  jobType?: string
  status: string
  percentage?: number
  width?: number
  height?: number
  imageUrls: string[]
  prompt?: string
  failure?: unknown[]
  /** Outcrop only: where the source sits in the new frame. */
  placement?: Placement
}

export async function waitForJob(jobId: string, batchSize = 4, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const jobs = await runInPage(jobStatusInPage, [[jobId]])
    const job = jobs?.find((j) => j.id === jobId)
    // Upscales make one image, grids four.
    const imageUrls = Array.from({ length: job?.batchSize ?? batchSize }, (_, i) => resultUrl(jobId, i))
    if (job && FAILED.has(job.status)) return { jobId, status: job.status, imageUrls: [] }
    if (job?.status === "completed" || (!job && (await isImage(freshUrl(imageUrls[0]))))) {
      return { jobId, status: "completed", imageUrls }
    }
    if (Date.now() > deadline) {
      return { jobId, status: job?.status ?? "unknown", percentage: job?.percentage, imageUrls: [] }
    }
    await sleep(POLL_MS)
  }
}

/** The status of several jobs in one request (batches poll every job in flight at once). */
export async function jobStatuses(params: { jobIds: string[] }) {
  const ids = (params.jobIds ?? []).map(String).slice(0, 50)
  const jobs = await runInPage(jobStatusInPage, [ids])
  if (!jobs) {
    throw new Error("Couldn't read the jobs from Midjourney. Sign in to midjourney.com in this browser first.")
  }
  return jobs.map(({ id, status, percentage }) => ({ id, status, percentage }))
}

async function finish(
  job: Awaited<ReturnType<typeof submit>>,
  prompt: string,
  params: { wait?: boolean; timeoutMs?: number }
): Promise<JobResult> {
  const { batchSize, failure, ...info } = job
  const base = { ...info, prompt, ...(failure.length ? { failure } : {}) }
  if (params.wait === false) return { ...base, status: "submitted", imageUrls: [] }
  return { ...base, ...(await waitForJob(job.jobId, batchSize, params.timeoutMs)) }
}

export interface OutcropParams {
  source: MjSource
  prompt: string
  aspectRatio: string
  anchor?: Anchor
  scale?: number
  offset?: { x?: number; y?: number }
  mode?: MjMode
  private?: boolean
  extraFlags?: string
  wait?: boolean
  timeoutMs?: number
}

type EditorParams = {
  mode?: MjMode
  private?: boolean
  extraFlags?: string
  wait?: boolean
  timeoutMs?: number
}

/** Uploads an Editor PNG (transparent where Midjourney should paint) and submits it. */
export async function submitEditorEdit(
  png: Blob,
  frameAr: string,
  prompt: string,
  params: EditorParams
): Promise<JobResult> {
  const { text, flags: allFlags } = splitPrompt(prompt, params.extraFlags)
  const editUrl = await upload(png, true)
  const flags = dropFlag(dropFlag(allFlags, "ar"), "edit")
  const fullPrompt = joinPrompt(
    text,
    `--ar ${frameAr}`,
    flags,
    `--edit ${editUrl}`,
    !hasFlag(flags, "v") && `--v ${EDIT_VERSION}`
  )
  const job = await submit({
    ...jobOptions(params),
    metadata: {
      isMobile: null,
      imagePrompts: 0,
      imageReferences: 0,
      characterReferences: 0,
      depthReferences: 0,
      lightboxOpen: null
    },
    t: "edit_diffusion",
    prompt: fullPrompt,
    editorPageRequest: true,
    parentJob: null,
    imageWasEdited: true
  })
  return finish(job, fullPrompt, params)
}

/**
 * The image scaled to the Editor frame for its own aspect ratio, fully opaque.
 * Repaint punches holes in this after the user brushes.
 */
export async function prepareEditorImage(source: MjSource) {
  const bitmap = await createImageBitmap(await loadSource(source))
  try {
    const frame = frameSize(`${bitmap.width}:${bitmap.height}`)
    const canvas = new OffscreenCanvas(frame.width, frame.height)
    const ctx = canvas.getContext("2d")!
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(bitmap, 0, 0, frame.width, frame.height)
    return { png: await canvas.convertToBlob({ type: "image/png" }), ...frame }
  } finally {
    bitmap.close()
  }
}

/** Extends an image to a new aspect ratio, like the Editor's Move + aspect ratio + Submit edit. */
export async function outcrop(params: OutcropParams): Promise<JobResult> {
  splitPrompt(params.prompt, params.extraFlags)
  const frame = frameSize(params.aspectRatio || "16:9")
  const { png, placement } = await composite(await loadSource(params.source), frame, params)
  const result = await submitEditorEdit(png, frame.ar, params.prompt, params)
  return { ...result, placement }
}

export interface GenerateParams {
  prompt: string
  imagePrompts?: MjSource[]
  styleReferences?: MjSource[]
  omniReferences?: MjSource[]
  editImage?: MjSource
  mode?: MjMode
  private?: boolean
  extraFlags?: string
  wait?: boolean
  timeoutMs?: number
}

/**
 * A Create-tab job. Image prompts guide the content, style references the
 * look (--sref), omni references a subject (--oref), and editImage restyles
 * that image (--edit, like dropping it in the prompt bar as an edit image).
 */
export async function generate(params: GenerateParams): Promise<JobResult> {
  const { text, flags: allFlags } = splitPrompt(params.prompt, params.extraFlags)
  const uploadAll = (sources: MjSource[] = []) =>
    Promise.all(
      sources.map(async (s) => ("code" in s ? s.code : upload(await loadSource(s), false)))
    )
  const [imagePrompts, styleRefs, omniRefs, editUrls] = await Promise.all([
    uploadAll(params.imagePrompts),
    uploadAll(params.styleReferences),
    uploadAll(params.omniReferences),
    uploadAll(params.editImage ? [params.editImage] : [])
  ])
  if (imagePrompts.some((url) => !url.startsWith("http"))) {
    throw new Error("Image prompts must be images, not style codes.")
  }

  let flags = allFlags
  if (styleRefs.length) flags = dropFlag(flags, "sref")
  if (omniRefs.length) flags = dropFlag(flags, "oref")
  if (editUrls.length) flags = dropFlag(flags, "edit")
  const isEdit = editUrls.length > 0
  const prompt = joinPrompt(
    ...imagePrompts,
    text,
    flags,
    styleRefs.length > 0 && `--sref ${styleRefs.join(" ")}`,
    omniRefs.length > 0 && `--oref ${omniRefs.join(" ")}`,
    isEdit && `--edit ${editUrls[0]}`,
    isEdit && !hasFlag(flags, "v") && `--v ${EDIT_VERSION}`
  )
  const job = await submit({
    ...jobOptions(params),
    metadata: {
      isMobile: null,
      imagePrompts: imagePrompts.length,
      imageReferences: styleRefs.length,
      characterReferences: omniRefs.length,
      depthReferences: 0,
      lightboxOpen: null
    },
    t: isEdit ? "edit_diffusion" : "imagine",
    prompt,
    ...(isEdit ? { editorPageRequest: null, parentJob: null, imageWasEdited: null } : {})
  })
  return finish(job, prompt, params)
}

// --- Actions on a finished image ----------------------------------------------
// The buttons under a result: Vary, Upscale, Pan and Zoom Out. Vary and
// Upscale are server jobs on the parent image. For --v 8.1 and 8.2 the site
// builds Pan and Zoom Out in the browser as Editor jobs (the image in a bigger
// frame, transparent around it), the same job as outcrop. Older versions have
// server pan and outpaint jobs.

export interface ActionParams {
  /** A job id, mj:<jobId>#<index>, or a cdn.midjourney.com image URL. */
  jobId: string
  index?: number
  mode?: MjMode
  private?: boolean
  wait?: boolean
  timeoutMs?: number
}

export type PanDirection = "left" | "right" | "up" | "down"

type JobInfo = NonNullable<Awaited<ReturnType<typeof jobStatusInPage>>>[number]

const JOB_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
// The site's pan directions.
const PAN_DIRECTIONS: Record<PanDirection, number> = { down: 0, right: 1, up: 2, left: 3 }
// Where the original stays in an Editor pan: opposite the new content.
const PAN_ANCHORS: Record<PanDirection, Anchor> = {
  left: "right",
  right: "left",
  up: "bottom",
  down: "top"
}
// What the site sends when no images are attached to the prompt.
const ACTION_METADATA = {
  isMobile: null,
  imagePrompts: null,
  imageReferences: null,
  characterReferences: null,
  depthReferences: null,
  lightboxOpen: null
}
const VERSION_FLAGS = ["v", "version", "niji"]
// Flags a new grid from a parent shouldn't inherit.
const ONE_OFF_FLAGS = ["r", "repeat", "fast", "relax", "turbo"]
// The site clears these too before an Editor pan or zoom.
const EDITOR_DROP_FLAGS = ["ar", "aspect", "edit", "seed", "sameseed", "stop", "q", "quality", "tile", "draft", "hd"]

function parseJobRef(params: ActionParams) {
  const raw = String(params.jobId ?? "").trim()
  const jobId = JOB_ID.exec(raw)?.[0]?.toLowerCase()
  if (!jobId) throw new Error(`"${raw}" isn't a Midjourney job id.`)
  const inRef = /(?:#|\/0_)(\d)(?:\.\w+)?(?:\?.*)?$/.exec(raw)
  return { jobId, index: params.index ?? (inRef ? Number(inRef[1]) : 0) }
}

async function finishedJob(jobId: string, index: number) {
  const jobs = await runInPage(jobStatusInPage, [[jobId]])
  if (!jobs) {
    throw new Error("Couldn't read the job from Midjourney. Sign in to midjourney.com in this browser first.")
  }
  const job = jobs.find((j) => j.id === jobId)
  if (!job) throw new Error(`Midjourney has no job ${jobId}.`)
  if (job.status !== "completed") {
    throw new Error(`Job ${jobId} is ${job.status ?? "not finished"}. Wait until it completes.`)
  }
  const count = job.batchSize ?? 4
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`Job ${jobId} has ${count} image${count === 1 ? "" : "s"}; there is no index ${index}.`)
  }
  return job
}

// "8.2", "7", "niji 6", … from the prompt's flags, else from the job type
// (e.g. "v8-2_diffusion", "v7_1024_outpaint_strong_anime").
function jobVersion(job: JobInfo) {
  const command = job.fullCommand ?? ""
  const niji = /(?:^|\s)--niji\s+(\d+)/.exec(command)
  if (niji) return `niji ${niji[1]}`
  const flag = /(?:^|\s)--(?:v|version)\s+([\d.]+)/.exec(command)
  if (flag) return flag[1]
  const type = /^v(\d+)(?:[-r](\d+))?_/.exec(job.jobType ?? "")
  if (!type) return undefined
  if (/anime|niji/.test(job.jobType!)) return `niji ${type[1]}`
  return type[2] ? `${type[1]}.${type[2]}` : type[1]
}

const versionFlag = (version: string) =>
  version.startsWith("niji ") ? `--niji ${version.slice(5)}` : `--v ${version}`

/** The parent's prompt (or the one given) with one-off flags dropped and its version pinned. */
function actionPrompt(raw: string, version: string, fallbackText: string, drop: string[]) {
  const at = raw.search(/(^|\s)--\w/)
  const text = (at < 0 ? raw : raw.slice(0, at)).trim()
  let flags = at < 0 ? "" : raw.slice(at)
  for (const name of [...VERSION_FLAGS, ...ONE_OFF_FLAGS, ...drop]) flags = dropFlag(flags, name)
  return joinPrompt(text || fallbackText, flags, versionFlag(version))
}

function upscaleType(version: string | undefined, kind: "subtle" | "creative") {
  switch (version) {
    case "8.2":
      return `v8r2_2x_${kind}`
    case "8.1":
      return `v8r1_2x_${kind}`
    case "7":
    case "niji 7":
      return `v7_2x_${kind}`
    case "6.1":
      return `v6r1_2x_${kind}`
    case "6":
    case "niji 6":
      return `v6_2x_${kind}`
    case "5":
    case "5.1":
    case "5.2":
    case "niji 5":
      return kind === "subtle" ? "v5_2x" : "v5_4x"
  }
  throw new Error(
    version
      ? `Midjourney has no web upscaler for ${versionFlag(version)} images.`
      : "Couldn't tell which Midjourney version made this image, so there's no upscaler to pick."
  )
}

/** Vary (Subtle) or Vary (Strong): four new takes on one image. */
export async function vary(params: ActionParams & { strong?: boolean }): Promise<JobResult> {
  const { jobId, index } = parseJobRef(params)
  const parent = await finishedJob(jobId, index)
  const job = await submit({
    ...jobOptions(params),
    metadata: ACTION_METADATA,
    t: "vary",
    strong: Boolean(params.strong),
    v8_1_hd: null,
    v8_2_hd: null,
    id: jobId,
    index
  })
  return finish(job, parent.fullCommand ?? "", params)
}

/** Upscale (Subtle) or Upscale (Creative): one image at twice the size. */
export async function upscale(
  params: ActionParams & { kind?: "subtle" | "creative" }
): Promise<JobResult> {
  const ref = parseJobRef(params)
  const parent = await finishedJob(ref.jobId, ref.index)
  let { jobId, index } = ref
  // The site's own U buttons on older grids make "virtual" upscales; those
  // upscale from the grid they came from.
  if (parent.eventType?.endsWith("_virtual") && parent.parentId) {
    jobId = parent.parentId
    index = parent.parentGrid ?? index
  } else if (parent.eventType?.startsWith("diffusion_upsample")) {
    throw new Error("That image is already an upscale.")
  }
  if (/_hd_/.test(parent.jobType ?? "")) throw new Error("--hd images are already full size and can't be upscaled.")
  if (/draft/.test(parent.jobType ?? "")) throw new Error("Draft images can't be upscaled. Vary or rerun it without --draft first.")
  const job = await submit({
    ...jobOptions(params),
    metadata: ACTION_METADATA,
    t: "upscale",
    type: upscaleType(jobVersion(parent), params.kind === "creative" ? "creative" : "subtle"),
    id: jobId,
    index
  })
  return finish(job, parent.fullCommand ?? "", params)
}

async function extend(
  params: ActionParams & { prompt?: string },
  how: { pan: PanDirection } | { zoom: number }
): Promise<JobResult> {
  const { jobId, index } = parseJobRef(params)
  const parent = await finishedJob(jobId, index)
  const version = jobVersion(parent)
  const what = "pan" in how ? "pan" : "zoom out"
  const fallbackText = "pan" in how ? `pan ${how.pan}` : "zoom out"
  const raw = params.prompt?.trim() || parent.fullCommand || ""

  if (version === "8.1" || version === "8.2") {
    const blob = await loadSource({ jobId, index })
    const bitmap = await createImageBitmap(blob)
    const { width, height } = bitmap
    bitmap.close()
    const grow = "pan" in how ? 1.5 : how.zoom
    const wider = "zoom" in how || how.pan === "left" || how.pan === "right"
    const taller = "zoom" in how || how.pan === "up" || how.pan === "down"
    const frame = frameSize(
      `${Math.round(wider ? width * grow : width)}:${Math.round(taller ? height * grow : height)}`
    )
    const { png, placement } = await composite(blob, frame, {
      anchor: "pan" in how ? PAN_ANCHORS[how.pan] : "center",
      scale: "zoom" in how ? 1 / how.zoom : 1
    })
    const prompt = actionPrompt(raw, version, fallbackText, EDITOR_DROP_FLAGS)
    const result = await submitEditorEdit(png, frame.ar, prompt, params)
    return { ...result, placement }
  }

  const serverVersions = ["5", "5.1", "5.2", "niji 5", "6", "6.1", "niji 6", "7", "niji 7"]
  if (!version || !serverVersions.includes(version)) {
    throw new Error(
      `Midjourney can't ${what} ${version ? `${versionFlag(version)} images` : "this image"}. Use midjourney_outcrop instead.`
    )
  }
  const newPrompt = actionPrompt(raw, version, fallbackText, [])
  const job = await submit({
    ...jobOptions(params),
    metadata: ACTION_METADATA,
    ...("pan" in how
      ? { t: "pan", newPrompt, direction: PAN_DIRECTIONS[how.pan], fraction: 0.5, stitch: true }
      : // The site's zoom factor: the original's size in the new frame, in percent.
        { t: "outpaint", newPrompt, zoomFactor: Math.round(50 + (100 - (how.zoom - 1) * 100) / 2) }),
    id: jobId,
    index
  })
  return finish(job, newPrompt, params)
}

/** Pan: extends one image by half its width or height in one direction. */
export function pan(params: ActionParams & { direction: PanDirection; prompt?: string }) {
  if (!(params.direction in PAN_DIRECTIONS)) {
    throw new Error('Pan direction must be "left", "right", "up" or "down".')
  }
  return extend(params, { pan: params.direction })
}

/** Zoom Out: shrinks one image inside a frame of the same shape and fills around it. */
export function zoomOut(params: ActionParams & { zoom?: number; prompt?: string }) {
  const zoom = clamp(Number(params.zoom) || 1.5, 1.1, 2)
  return extend(params, { zoom })
}

// Resolves with the saved file's path once a download finishes.
function downloadFinished(downloadId: number) {
  return new Promise<string>((resolve, reject) => {
    const settle = (item?: chrome.downloads.DownloadItem) => {
      if (item?.state === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged)
        resolve(item.filename)
      } else if (item?.state === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged)
        reject(new Error(`Download failed: ${item.error ?? "interrupted"}`))
      }
    }
    const check = () => chrome.downloads.search({ id: downloadId }).then(([item]) => settle(item))
    const onChanged = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id === downloadId && delta.state) check()
    }
    chrome.downloads.onChanged.addListener(onChanged)
    check()
  })
}

/**
 * Saves a job's images to the Downloads folder, as <jobId>_<index>.png or,
 * with a name, <name>-<index>.png (replacing an earlier copy, so a retried
 * download doesn't leave "(1)" files). Each one is saved only once the CDN
 * serves it, and one at a time: starting a download right after one that
 * failed has stopped the extension's service worker.
 */
export async function downloadImages(params: {
  jobId: string
  indexes?: number[]
  folder?: string
  name?: string
}) {
  let indexes = params.indexes ?? []
  if (!indexes.length) {
    const [job] = (await runInPage(jobStatusInPage, [[params.jobId]])) ?? []
    indexes = Array.from({ length: job?.batchSize ?? 4 }, (_, i) => i)
  }
  const folder = (params.folder || "midjourney").replace(/^\/+|\/+$/g, "")
  const name = params.name?.replace(/[\\/:*?"<>|]+/g, "-").trim()
  const deadline = Date.now() + READY_WAIT_MS
  const files = []
  for (const index of indexes) {
    const downloadId = await chrome.downloads.download({
      url: await readyResultUrl(params.jobId, index, deadline),
      filename: name ? `${folder}/${name}-${index}.png` : `${folder}/${params.jobId}_${index}.png`,
      conflictAction: name ? "overwrite" : "uniquify",
      saveAs: false
    })
    files.push(await downloadFinished(downloadId))
  }
  return { files }
}
