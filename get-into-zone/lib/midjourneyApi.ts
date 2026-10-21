// Midjourney jobs through midjourney.com's own API: outcrop (Editor), and
// Create-tab jobs with image prompts, style / omni references or an edit
// reference. Requests run inside a midjourney.com tab so the user's session
// applies. Endpoints, headers and payloads mirror what the site's own code
// sends (read from its bundle, Oct 2026).

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
  const url = "url" in source ? source.url : resultUrl(source.jobId, source.index ?? 0)
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
    percentage: j.percentage_complete
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

async function upload(blob: Blob, editor: boolean) {
  if (blob.size > 20_000_000) throw new Error("Images must be under 20 MB.")
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
  return `${CDN}/${editor ? "e" : "u"}/${result.bucketPathname.replace(/^\//, "")}`
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
  flags.replace(new RegExp(`(^|\\s)--${name}((\\s+(?!--)\\S+)*)`, "g"), " ")

const joinPrompt = (...parts: (string | undefined | false)[]) =>
  parts
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

// The text before any "--" parameters, and those parameters merged into extraFlags.
function splitPrompt(prompt: unknown, extraFlags = "") {
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

async function imageExists(url: string) {
  try {
    return (await fetch(url, { method: "HEAD" })).ok
  } catch {
    return false
  }
}

export async function waitForJob(jobId: string, batchSize = 4, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs
  const imageUrls = Array.from({ length: batchSize }, (_, i) => resultUrl(jobId, i))
  for (;;) {
    const jobs = await runInPage(jobStatusInPage, [[jobId]])
    const job = jobs?.find((j) => j.id === jobId)
    if (job && FAILED.has(job.status)) return { jobId, status: job.status, imageUrls: [] }
    if (job?.status === "completed" || (!job && (await imageExists(imageUrls[0])))) {
      return { jobId, status: "completed", imageUrls }
    }
    if (Date.now() > deadline) {
      return { jobId, status: job?.status ?? "unknown", percentage: job?.percentage, imageUrls: [] }
    }
    await sleep(POLL_MS)
  }
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

/** Extends an image to a new aspect ratio, like the Editor's Move + aspect ratio + Submit edit. */
export async function outcrop(params: OutcropParams): Promise<JobResult> {
  const { text, flags: allFlags } = splitPrompt(params.prompt, params.extraFlags)
  const frame = frameSize(params.aspectRatio || "16:9")
  const { png, placement } = await composite(await loadSource(params.source), frame, params)
  const editUrl = await upload(png, true)

  const flags = dropFlag(dropFlag(allFlags, "ar"), "edit")
  const prompt = joinPrompt(
    text,
    `--ar ${frame.ar}`,
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
    prompt,
    editorPageRequest: true,
    parentJob: null,
    imageWasEdited: true
  })
  return { ...(await finish(job, prompt, params)), placement }
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

/** Saves a job's images to the Downloads folder. */
export async function downloadImages(params: {
  jobId: string
  indexes?: number[]
  folder?: string
}) {
  const indexes = params.indexes?.length ? params.indexes : [0, 1, 2, 3]
  const folder = (params.folder || "midjourney").replace(/^\/+|\/+$/g, "")
  const files = []
  for (const index of indexes) {
    const filename = `${folder}/${params.jobId}_${index}.png`
    await chrome.downloads.download({
      url: resultUrl(params.jobId, index),
      filename,
      conflictAction: "uniquify",
      saveAs: false
    })
    files.push(filename)
  }
  return { files }
}
