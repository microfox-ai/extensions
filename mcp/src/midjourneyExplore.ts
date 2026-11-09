// Midjourney's Explore from Claude: search and browse what the community
// publishes (images, videos and style codes), then save the ones worth keeping
// into MediaMake's library inbox as references.
//
// The extension fetches the pages in a midjourney.com tab (get-into-zone/lib/
// midjourneyExplore.ts) and hands back the site's own job objects; this file
// turns them into results: the prompt as a command you can reuse, its style
// codes, links to the image and its page, and an mj:<jobId>#<index> ref that
// midjourney_generate takes as an image prompt or style reference.

import type { Bridge } from "./bridge.js"
import {
  downloadsFolder,
  findMedia,
  hasLibrary,
  inboxFolder,
  localDate,
  pngHeight,
  readLibrary,
  writeSidecar,
  type Have
} from "./library.js"

const CDN = "https://cdn.midjourney.com"
const SITE = "https://www.midjourney.com"
const NEEDS_EXTENSION = "0.17.0"

// --- Prompts -----------------------------------------------------------------

type Weighted = { content?: unknown; weight?: unknown; t?: unknown }

// The site's lists hold strings or { content, weight } parts.
const list = (value: unknown): any[] => (Array.isArray(value) ? value : [])
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "")
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const weighted = (part: Weighted) => {
  const content = text(part.content)
  const weight = num(part.weight)
  return content && weight !== undefined && weight !== 1 ? `${content}::${weight}` : content
}

/** The model a job ran on, as a prompt flag: "--v 8.2", "--niji 7". */
function versionFlag(version: unknown) {
  const v = text(version)
  if (!v) return ""
  const niji = /^niji\s*(\S*)$/i.exec(v)
  if (niji) return niji[1] ? `--niji ${niji[1]}` : "--niji"
  return `--v ${v}`
}

/** "v8.2", "niji 7": the media library's model names. */
export function modelOf(version: unknown) {
  const v = text(version)
  if (!v) return undefined
  return /^niji/i.test(v) ? v.toLowerCase().replace(/^niji\s*/, "niji ").trim() : `v${v}`
}

/**
 * The command a feed job was made with, rebuilt from the site's parsed prompt
 * (the feed doesn't send the original text): the words, then the flags in the
 * order Midjourney writes them.
 */
export function promptCommand(prompt: any): string {
  if (typeof prompt === "string") return prompt.trim()
  if (!prompt || typeof prompt !== "object") return ""
  const images = list(prompt.images).map((image) => (typeof image === "string" ? image.trim() : weighted(image)))
  const words = list(prompt.decodedPrompt).map(weighted).filter(Boolean).join(" ")
  const flags: string[] = []
  const flag = (name: string, value: unknown) => {
    const v = text(value)
    if (v) flags.push(`--${name} ${v}`)
  }
  const no = list(prompt.no)
    .map((part) => (typeof part === "string" ? part.trim() : weighted(part)))
    .filter(Boolean)
  if (no.length) flags.push(`--no ${no.join(", ")}`)
  if (prompt.ar?.w && prompt.ar?.h) flags.push(`--ar ${prompt.ar.w}:${prompt.ar.h}`)
  flag("chaos", prompt.chaos)
  flag("exp", prompt.exp)
  flag("q", prompt.quality)
  flag("seed", prompt.seed)
  flag("stop", prompt.stop)
  flag("stylize", prompt.stylize)
  flag("weird", prompt.weird)
  flag("iw", prompt.imageWeight)
  const srefs = list(prompt.styleRef).map(weighted).filter(Boolean)
  if (srefs.length) flags.push(`--sref ${srefs.join(" ")}`)
  flag("sw", prompt.sw)
  flag("sv", prompt.sv)
  if (prompt.personalize === true) flags.push("--p")
  else {
    const codes = list(prompt.personalize).map(weighted).filter(Boolean)
    if (codes.length) flags.push(`--p ${codes.join(" ")}`)
  }
  if (prompt.styleRaw === true) flags.push("--raw")
  if (prompt.tile === true) flags.push("--tile")
  if (prompt.hd === true) flags.push("--hd")
  if (prompt.draft === true) flags.push("--draft")
  const version = versionFlag(prompt.version)
  if (version) flags.push(version)
  return [...images, words, ...flags].filter(Boolean).join(" ")
}

/** The words of a prompt, without its flags or image links. */
const promptWords = (prompt: any) =>
  typeof prompt === "string"
    ? prompt.replace(/\s--\S.*$/, "").replace(/https?:\/\/\S+/g, "").trim()
    : list(prompt?.decodedPrompt).map((part) => text(part.content)).filter(Boolean).join(" ")

// --- Results -----------------------------------------------------------------

export interface ExploreResult {
  /** An image prompt or style reference for midjourney_generate, and what midjourney_explore_download takes. */
  ref: string
  jobId: string
  index: number
  type: "image" | "video"
  /** The full-size file: a PNG, or a video's MP4. */
  url: string
  /** A small preview (384 px WebP). */
  preview: string
  page: string
  prompt: string
  srefs?: string[]
  personalize?: string[]
  model?: string
  ar?: string
  width?: number
  height?: number
  author?: string
  authorId?: string
  createdAt?: string
}

const isVideoJob = (job: any) =>
  job?.type === "video" || /video/i.test(String(job?.event_type ?? "")) || /video/i.test(String(job?.job_type ?? ""))

/** Which images of a job Explore shows: the one its maker published (the others are hidden from the feed). */
function shownIndexes(job: any): number[] {
  const items = Array.isArray(job?.items) ? job.items : []
  const shown = items.flatMap((item: any, i: number) => (item?.server_filtered || item?.filtered ? [] : [i]))
  return shown.length ? shown : [0]
}

export function exploreResults(job: any): ExploreResult[] {
  const jobId = text(job?.id)
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return []
  const video = isVideoJob(job)
  const prompt = job.prompt
  const codes = (key: string) => {
    const values = list(prompt?.[key]).map((part) => text(part.content)).filter(Boolean)
    return values.length ? values : undefined
  }
  const enqueued = num(job.enqueue_time) ?? Date.parse(String(job.enqueue_time ?? ""))
  return shownIndexes(job).map((index) => ({
    ref: `mj:${jobId}#${index}`,
    jobId,
    index,
    type: video ? "video" : "image",
    url: video ? `${CDN}/video/${jobId}/${index}.mp4` : `${CDN}/${jobId}/0_${index}.png`,
    preview: video ? `${CDN}/video/${jobId}/${index}_384_N.webp` : `${CDN}/${jobId}/0_${index}_384_N.webp`,
    page: `${SITE}/jobs/${jobId}?index=${index}`,
    prompt: promptCommand(prompt),
    srefs: codes("styleRef"),
    personalize: codes("personalize"),
    model: modelOf(prompt?.version),
    ar: prompt?.ar?.w && prompt?.ar?.h ? `${prompt.ar.w}:${prompt.ar.h}` : undefined,
    width: num(job.width),
    height: num(job.height),
    author: text(job.display_name) || text(job.owner_profile?.display_name) || undefined,
    authorId: text(job.user_id) || undefined,
    createdAt: Number.isFinite(enqueued) ? new Date(enqueued).toISOString() : undefined
  }))
}

export interface StyleResult {
  /** The code, for --sref. */
  sref: string
  use: string
  page: string
  /** The style's preview grid (when Midjourney has made one: styles from the Styles tab have). */
  grid: string
  /** Sample pictures in the style, by subject. */
  samples: Record<string, string>
}

const STYLE_SUBJECTS = ["portrait", "landscape", "still life"]

export function styleResult(style: any): StyleResult | undefined {
  const id = text(style?.id) || (text(style?.formatted_sref) ? `0_${text(style.formatted_sref)}` : "")
  const sref = text(style?.formatted_sref) || id.replace(/^0_/, "")
  if (!id || !sref) return undefined
  const base = `${CDN}/styles/${id}`
  return {
    sref,
    use: `--sref ${sref}`,
    page: `${SITE}/styles/${id}`,
    grid: `${base}/grid_3x3_640_N.webp`,
    samples: Object.fromEntries(STYLE_SUBJECTS.map((subject) => [subject, `${base}/${subject.replaceAll(" ", "_")}_640_N.webp`]))
  }
}

const bareResult = (jobId: string, index: number): ExploreResult => ({
  ref: `mj:${jobId}#${index}`,
  jobId,
  index,
  type: "image",
  url: `${CDN}/${jobId}/0_${index}.png`,
  preview: `${CDN}/${jobId}/0_${index}_384_N.webp`,
  page: `${SITE}/jobs/${jobId}?index=${index}`,
  prompt: ""
})

// What this server has shown, so a download can name what it saves without
// asking Midjourney again (a feed job's details come only with the feed).
interface Shown extends ExploreResult {
  query?: string
  feed?: string
}
const shown = new Map<string, Shown>()
const SHOWN_LIMIT = 5000

function remember(result: Shown) {
  const key = `${result.jobId}:${result.index}`
  shown.delete(key)
  shown.set(key, result)
  if (shown.size > SHOWN_LIMIT) shown.delete(shown.keys().next().value!)
}

/** Forgets what was shown (for tests). */
export const forgetShown = () => shown.clear()

// --- Tools -------------------------------------------------------------------

/** The extension's error for a method it doesn't have, as an update to ask for. */
async function call<T>(bridge: Bridge, method: string, params: Record<string, unknown>, timeoutMs?: number) {
  try {
    return (await bridge.call(method, params, timeoutMs)) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Unknown method/i.test(message)) {
      throw new Error(`This needs Browse Hack ${NEEDS_EXTENSION} or later in Chrome. Call update_browse_hack, then try again.`)
    }
    throw error
  }
}

export interface ExploreParams {
  query?: string
  feed?: string
  page?: number
  pages?: number
  limit?: number
}

const SIGNED_OUT_FEED =
  "midjourney.com isn't signed in in this Chrome profile, so Explore answered its Top month feed instead of the one asked for."

export async function exploreMidjourney(bridge: Bridge, { limit = 30, ...params }: ExploreParams) {
  const answer = await call<{
    query?: string
    feed?: string
    jobs: unknown[]
    page: number
    nextPage: number | null
    signedIn: boolean
  }>(bridge, "midjourney.explore", params, 120_000)
  const results = (answer.jobs ?? []).flatMap(exploreResults)
  for (const result of results) remember({ ...result, query: answer.query, feed: answer.feed })
  const feed = answer.feed
  return {
    ...(answer.query ? { query: answer.query } : { feed }),
    page: answer.page,
    nextPage: answer.nextPage,
    found: results.length,
    ...(feed && feed !== "top_month" && !answer.signedIn ? { note: SIGNED_OUT_FEED } : {}),
    results: results.slice(0, Math.max(1, limit))
  }
}

export async function exploreMidjourneyStyles(bridge: Bridge, { limit = 30, ...params }: ExploreParams) {
  const answer = await call<{ query?: string; feed?: string; styles: unknown[]; page: number; nextPage: number | null }>(
    bridge,
    "midjourney.exploreStyles",
    params,
    120_000
  )
  const styles = (answer.styles ?? []).flatMap((style) => styleResult(style) ?? [])
  return {
    ...(answer.query ? { query: answer.query } : { feed: answer.feed }),
    page: answer.page,
    nextPage: answer.nextPage,
    found: styles.length,
    styles: styles.slice(0, Math.max(1, limit))
  }
}

/** "mj:<jobId>#<index>", "<jobId>#<index>", "<jobId>:<index>", a job page link, or a job id (its shown image). */
export function parseExploreRef(value: string): { jobId: string; index?: number } | undefined {
  const input = value.trim()
  const match =
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:(?:[#:/]|\?index=|\/0_)(\d))?/i.exec(input)
  if (!match) return undefined
  return { jobId: match[1].toLowerCase(), ...(match[2] !== undefined ? { index: Number(match[2]) } : {}) }
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .slice(0, 60)
    .replace(/^-+|-+$/g, "")

export interface ExploreDownloadParams {
  items: string[]
  set?: string
  folder?: string
  force?: boolean
}

const ALREADY_HAVE = "The media library already has some of these, so they weren't downloaded again (force: true downloads them)."

export async function downloadExplore(bridge: Bridge, { items, set, folder, force }: ExploreDownloadParams) {
  const wanted: Shown[] = []
  const unknown: string[] = []
  for (const item of items) {
    const ref = parseExploreRef(String(item))
    if (!ref) {
      unknown.push(String(item))
      continue
    }
    const known =
      ref.index !== undefined
        ? shown.get(`${ref.jobId}:${ref.index}`)
        : [...shown.values()].find((result) => result.jobId === ref.jobId)
    // A job this server hasn't shown is saved as an image, without its prompt.
    const result: Shown = known ?? bareResult(ref.jobId, ref.index ?? 0)
    if (!wanted.some((w) => w.jobId === result.jobId && w.index === result.index)) wanted.push(result)
  }
  if (unknown.length) throw new Error(`Not a Midjourney job: ${unknown.join(", ")}. Pass refs from midjourney_explore.`)
  if (!wanted.length) throw new Error("Pass at least one item from midjourney_explore.")

  const lib = readLibrary()
  const library = hasLibrary(lib)
  const topic = set?.trim() || [localDate(), slug(wanted[0].query || wanted[0].feed || "explore")].filter(Boolean).join("-")
  const setName = topic.replace(/[\\/:*?"<>|]+/g, "-").trim()
  // In the inbox's midjourney/references/, so MediaMake files them as references (someone else's work), not as your art.
  const target =
    folder !== undefined
      ? downloadsFolder(folder, lib.home)
      : (library ? inboxFolder(lib, "midjourney", "references", setName) : undefined) ?? `midjourney-explore/${setName}`

  const alreadyHave: (Have & { ref: string })[] = []
  const todo: Shown[] = []
  for (const result of wanted) {
    const have = !force && library ? await findMedia("midjourney", `${result.jobId}:${result.index}`, lib) : undefined
    if (have) alreadyHave.push({ ref: result.ref, ...have })
    else todo.push(result)
  }

  if (todo.some((result) => result.type === "video")) {
    const info = (await bridge.call("extension.info", {}).catch(() => undefined)) as { version?: string } | undefined
    if (info?.version && newer(NEEDS_EXTENSION, info.version)) {
      throw new Error(`Saving Midjourney videos needs Browse Hack ${NEEDS_EXTENSION} or later. Call update_browse_hack, then try again.`)
    }
  }

  const saved: { ref: string; path: string; sidecar?: string }[] = []
  const failed: { ref: string; error: string }[] = []
  // One call per job and kind, as the extension saves a job's files one at a time.
  const groups = new Map<string, Shown[]>()
  for (const result of todo) {
    const key = `${result.jobId}:${result.type}`
    groups.set(key, [...(groups.get(key) ?? []), result])
  }
  for (const group of groups.values()) {
    const [{ jobId, type }] = group
    try {
      const answer = await call<{ files: string[] }>(
        bridge,
        "midjourney.downloadImages",
        { jobId, indexes: group.map((r) => r.index), folder: target, ...(type === "video" ? { video: true } : {}) },
        180_000
      )
      group.forEach((result, i) => {
        const path = answer.files?.[i]
        if (!path) return failed.push({ ref: result.ref, error: "The extension didn't say where it saved this one." })
        let sidecar: string | undefined
        if (library) {
          try {
            sidecar = writeSidecar(path, {
              tool: "midjourney",
              ref: `${result.jobId}:${result.index}`,
              url: result.url,
              pageUrl: result.page,
              title: promptWords(result.prompt).slice(0, 120) || undefined,
              author: result.author,
              query: result.query,
              prompt: result.prompt || undefined,
              model: result.model,
              height: result.type === "image" ? (pngHeight(path) ?? result.height) : result.height
            })
          } catch (error) {
            failed.push({ ref: result.ref, error: `Saved, but its sidecar wasn't: ${error instanceof Error ? error.message : error}` })
          }
        }
        saved.push({ ref: result.ref, path, ...(sidecar ? { sidecar } : {}) })
      })
    } catch (error) {
      for (const result of group) failed.push({ ref: result.ref, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    folder: target,
    saved,
    ...(failed.length ? { failed } : {}),
    ...(alreadyHave.length ? { alreadyHave, note: ALREADY_HAVE } : {})
  }
}

/** Whether version a is newer than b ("0.17.0" vs "0.16.4"). */
function newer(a: string, b: string) {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}
