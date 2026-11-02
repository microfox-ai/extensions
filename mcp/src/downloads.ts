// The download tools with MediaMake's media library (library.ts) in front of
// the extension: the library's inbox as the default folder, a check for what
// the library already has, and a <file>.source.json beside each file these
// tools wait for. YouTube downloads finish after the tool returns, so the
// extension writes their sidecar itself, and a Pinterest session's
// _session.json when the session stops.

import { join } from "node:path"

import type { Bridge } from "./bridge.js"
import {
  canLookup,
  downloadsFolder,
  findMedia,
  hasLibrary,
  inboxFolder,
  knownPins,
  localDate,
  modelFromPrompt,
  pngHeight,
  readLibrary,
  subfolders,
  writeSidecar,
  type Have,
  type Library,
  type SourceFields
} from "./library.js"

const ALREADY_HAVE =
  "The media library already has this, so nothing was downloaded. Use alreadyHave's path, or pass force: true to download it again."

/** The folder to pass the extension: the one asked for, else the library inbox's (undefined keeps the extension's default). */
const folderFor = (lib: Library, folder: string | undefined, ...inbox: string[]) =>
  folder !== undefined ? downloadsFolder(folder, lib.home) : inboxFolder(lib, ...inbox)

// A sidecar that can't be written shouldn't fail a download that worked.
function sidecar(file: string, fields: SourceFields) {
  try {
    writeSidecar(file, fields)
    return undefined
  } catch (error) {
    return `${file}: ${error instanceof Error ? error.message : error}`
  }
}

// --- YouTube ---

/** Same rules as get-into-zone/lib/youtube.ts. */
export function parseVideoId(rawUrl?: string) {
  let url: URL
  try {
    url = new URL(rawUrl ?? "")
  } catch {
    return undefined
  }
  const host = url.hostname.replace(/^www\./, "")
  const valid = (id?: string | null) => (id && /^[\w-]{11}$/.test(id) ? id : undefined)
  if (host === "youtu.be") return valid(url.pathname.slice(1))
  if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return undefined
  if (url.pathname === "/watch") return valid(url.searchParams.get("v"))
  return valid(url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1])
}

const AUDIO_FILE = /\.(m4a|mp3|aac|opus|ogg|oga|wav|flac|weba)$/i

/**
 * Whether the library's copy answers a download request. It doesn't when the
 * request wants the picture and the library only has the sound, or asks for a
 * maxHeight above the library copy's height.
 */
export function covers(have: Pick<Have, "path" | "height">, request: { mode?: string; maxHeight?: number }) {
  if (request.mode !== "audio" && AUDIO_FILE.test(have.path)) return false
  return !(request.maxHeight && have.height && request.maxHeight > have.height)
}

export interface YoutubeDownloadParams {
  url?: string
  tabId?: number
  mode?: "both" | "video" | "audio"
  optionId?: string
  maxHeight?: number
  folder?: string
  fileName?: string
  force?: boolean
}

export async function youtubeDownload(bridge: Bridge, { folder, fileName, force, ...params }: YoutubeDownloadParams) {
  const lib = readLibrary()
  if (!force && canLookup(lib, "youtube")) {
    // Without a link, ask the extension which video the tab is playing.
    const videoId =
      parseVideoId(params.url) ??
      ((await bridge.call("youtube.getVideo", { url: params.url, tabId: params.tabId }, 90_000)) as any)?.videoId
    const have = videoId ? await findMedia("youtube", videoId, lib) : undefined
    if (have && covers(have, params)) return { alreadyHave: have, videoId, note: ALREADY_HAVE }
  }
  return bridge.call(
    "youtube.download",
    { ...params, folder: folderFor(lib, folder, "youtube"), fileName, sidecar: hasLibrary(lib) },
    90_000
  )
}

// --- Instagram ---

export interface InstagramDownloadParams {
  url?: string
  tabId?: number
  items?: number[]
  folder?: string
  fileName?: string
  force?: boolean
}

interface InstagramSaved {
  number: number
  path?: string
  height?: number
}

interface InstagramResult {
  username?: string
  code?: string
  mediaId?: string
  caption?: string
  count?: number
  saved?: InstagramSaved[]
}

/** The catalog's ref for one photo or video of a post: <shortcode>:<item number>. */
const instagramRef = (post: { code?: string; mediaId?: string }, number: number) =>
  `${post.code || post.mediaId}:${number}`

function instagramSource(post: InstagramResult, file: InstagramSaved): SourceFields {
  const link = post.code ? `https://www.instagram.com/p/${post.code}/` : undefined
  return {
    tool: "instagram",
    ref: instagramRef(post, file.number),
    url: link && (post.count ?? 1) > 1 ? `${link}?img_index=${file.number}` : link,
    title: post.caption?.split("\n")[0].trim().slice(0, 200),
    author: post.username,
    height: file.height
  }
}

export async function instagramDownload(bridge: Bridge, { folder, fileName, force, ...params }: InstagramDownloadParams) {
  const lib = readLibrary()
  const alreadyHave: (Have & { number: number })[] = []
  let items = params.items
  if (!force && canLookup(lib, "instagram")) {
    const post = (await bridge.call("instagram.getPost", { url: params.url, tabId: params.tabId }, 60_000)) as {
      username?: string
      code?: string
      mediaId?: string
      items: { number: number }[]
    }
    const numbers = items?.length ? [...new Set(items)] : post.items.map((item) => item.number)
    const missing: number[] = []
    for (const number of numbers) {
      const have = await findMedia("instagram", instagramRef(post, number), lib)
      if (have) alreadyHave.push({ number, ...have })
      else missing.push(number)
    }
    if (!missing.length) return { username: post.username, code: post.code, saved: [], alreadyHave, note: ALREADY_HAVE }
    items = missing
  }

  const result = (await bridge.call(
    "instagram.download",
    { ...params, items, folder: folderFor(lib, folder, "instagram"), fileName },
    300_000
  )) as InstagramResult
  const sidecarErrors = hasLibrary(lib)
    ? (result.saved ?? []).flatMap((file) => (file.path ? sidecar(file.path, instagramSource(result, file)) ?? [] : []))
    : []
  return {
    ...result,
    ...(alreadyHave.length ? { alreadyHave, note: "The media library already had some items; only the others were downloaded." } : {}),
    ...(sidecarErrors.length ? { sidecarErrors } : {})
  }
}

// --- Midjourney ---

export interface MidjourneyDownloadParams {
  jobId: string
  indexes?: number[]
  folder?: string
  name?: string
  set?: string
}

const folderName = (name?: string) => name?.replace(/[\\/:*?"<>|]+/g, "-").trim()

export async function downloadMidjourneyImages(bridge: Bridge, { set, ...params }: MidjourneyDownloadParams) {
  const lib = readLibrary()
  const library = hasLibrary(lib)
  const result = (await bridge.call(
    "midjourney.downloadImages",
    {
      ...params,
      folder: folderFor(lib, params.folder, "midjourney", folderName(set) || localDate()),
      withPrompt: library || undefined
    },
    180_000
  )) as { files: string[]; indexes?: number[]; prompt?: string }
  if (!library) return result
  const sidecarErrors = result.files.flatMap((file, i) => {
    const index = result.indexes?.[i] ?? params.indexes?.[i] ?? i
    return (
      sidecar(file, {
        tool: "midjourney",
        ref: `${params.jobId}:${index}`,
        url: `https://cdn.midjourney.com/${params.jobId}/0_${index}.png`,
        pageUrl: `https://www.midjourney.com/jobs/${params.jobId}?index=${index}`,
        prompt: result.prompt,
        model: modelFromPrompt(result.prompt),
        height: pngHeight(file)
      }) ?? []
    )
  })
  return sidecarErrors.length ? { ...result, sidecarErrors } : result
}

// --- Pinterest ---

export interface PinterestBulkParams {
  tabId?: number
  destination?: "browser" | "mediamake"
  folder?: string
  videoFolder?: string
  includeVideos?: boolean
  tags?: string[]
  perPageLimit?: number
  force?: boolean
}

export async function startPinterestBulk(bridge: Bridge, { force, ...params }: PinterestBulkParams) {
  const lib = readLibrary()
  const library = params.destination !== "mediamake" && hasLibrary(lib)
  // The extension names the session's folder after the tab's search: <date>-<query>.
  const inbox = library && params.folder === undefined ? inboxFolder(lib, "pinterest") : undefined
  const known = library && !force ? await knownPins(lib) : undefined
  return bridge.call("pinterest.bulkStart", {
    ...params,
    folder: params.folder !== undefined ? downloadsFolder(params.folder, lib.home) : undefined,
    videoFolder: params.videoFolder !== undefined ? downloadsFolder(params.videoFolder, lib.home) : undefined,
    inboxFolder: inbox,
    takenFolders: inbox && lib.inbox ? subfolders(join(lib.inbox, "pinterest")) : undefined,
    manifest: library || undefined,
    skipPins: known?.pins,
    // Video pins are checked against these, so a saved cover doesn't stand for its video.
    skipVideos: known?.videos
  })
}
