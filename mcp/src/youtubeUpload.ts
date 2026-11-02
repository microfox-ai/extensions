// Reads YouTube upload folders (info.json, the video, the thumbnail) and
// streams them to the extension, one YouTube Studio tab per folder. The browser
// cannot see these paths itself.

import { open, readdir, readFile, stat } from "node:fs/promises"
import { basename, extname, isAbsolute, join, resolve } from "node:path"

import type { Bridge } from "./bridge.js"
import { resolveReleaseFolders } from "./distrokid.js"

const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".flv": "video/x-flv",
  ".3gp": "video/3gpp"
}
const IMAGE_MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" }
const CHUNK = 1024 * 1024
// The whole video is held in the Studio tab before YouTube reads it.
const VIDEO_MAX = 4 * 1024 ** 3
const THUMBNAIL_MAX = 50 * 1024 ** 2

type LocalFile = { path: string; name: string; mime: string; size: number }

export type UploadOutcome = {
  folder: string
  ok: boolean
  tabId?: number
  channel?: string
  message: string
  warnings?: string[]
  filled?: string[]
  videoUrl?: string
}

async function isFile(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false
}

async function localFile(dir: string, relative: string, mimes: Record<string, string>, what: string) {
  const path = isAbsolute(relative) ? relative : resolve(dir, relative)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`${what} ${relative} isn't in ${dir}.`)
  const mime = mimes[extname(path).toLowerCase()]
  if (!mime) throw new Error(`${what} ${basename(path)} isn't a type YouTube takes (${Object.keys(mimes).join(", ")}).`)
  return { path, name: basename(path), mime, size: info.size }
}

async function filesIn(dir: string, mimes: Record<string, string>): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && extname(entry.name).toLowerCase() in mimes)
    .map((entry) => join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b))
}

async function readUpload(dir: string): Promise<{
  infoJson: string
  video: LocalFile
  thumbnail?: LocalFile
  notes: string[]
}> {
  let info: Record<string, unknown>
  try {
    info = JSON.parse((await readFile(join(dir, "info.json"), "utf8")).replace(/^﻿/, ""))
  } catch {
    throw new Error(`${dir}/info.json is not valid JSON.`)
  }
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new Error(`${dir}/info.json must be a JSON object.`)
  const notes: string[] = []
  const text = (key: string) => (typeof info[key] === "string" ? (info[key] as string) : "")

  // Title and description can live in the pack's title.txt and description.txt.
  let title = text("title").trim()
  const titleFile = text("titleFile") || (!title ? "title.txt" : "")
  if (titleFile) {
    const path = resolve(dir, titleFile)
    if (await isFile(path)) title = (await readFile(path, "utf8")).split(/\r?\n/).find((line) => line.trim())?.trim() || ""
    else if (text("titleFile")) throw new Error(`titleFile ${titleFile} isn't in ${dir}.`)
  }
  let description: string | undefined = typeof info.description === "string" ? info.description : undefined
  const descriptionFile = text("descriptionFile") || (description === undefined ? "description.txt" : "")
  if (descriptionFile) {
    const path = resolve(dir, descriptionFile)
    if (await isFile(path)) description = await readFile(path, "utf8")
    else if (text("descriptionFile")) throw new Error(`descriptionFile ${descriptionFile} isn't in ${dir}.`)
  }

  let video: LocalFile
  if (text("video")) video = await localFile(dir, text("video"), VIDEO_MIME, "The video")
  else {
    const videos = await filesIn(dir, VIDEO_MIME)
    if (videos.length === 0) throw new Error(`${dir} has no video file. Put one in, or name it in info.json "video".`)
    if (videos.length > 1) {
      throw new Error(`${dir} has ${videos.length} videos (${videos.map((v) => basename(v)).join(", ")}). Name one in info.json "video".`)
    }
    video = await localFile(dir, videos[0], VIDEO_MIME, "The video")
  }
  if (video.size > VIDEO_MAX) {
    throw new Error(`${video.name} is ${(video.size / 1024 ** 3).toFixed(1)} GB; upload videos over 4 GB in YouTube Studio by hand.`)
  }

  let thumbnail: LocalFile | undefined
  if (text("thumbnail")) thumbnail = await localFile(dir, text("thumbnail"), IMAGE_MIME, "The thumbnail")
  else {
    const picked = await filesIn(join(dir, "thumbnails"), IMAGE_MIME)
    const loose = (await filesIn(dir, IMAGE_MIME)).filter((file) => /^thumbnail\./i.test(basename(file)))
    const candidates = picked.length ? picked : loose
    if (candidates.length === 1) thumbnail = await localFile(dir, candidates[0], IMAGE_MIME, "The thumbnail")
    else if (candidates.length > 1) {
      notes.push(
        `${candidates.length} thumbnails and none named in info.json "thumbnail", so none was set. ` +
          "For YouTube's Test & Compare, add them under Thumbnail → A/B testing."
      )
    }
  }
  if (thumbnail && thumbnail.size > THUMBNAIL_MAX) throw new Error(`${thumbnail.name} is over YouTube's 50 MB thumbnail limit.`)

  const merged: Record<string, unknown> = { ...info, title }
  delete merged.titleFile
  delete merged.descriptionFile
  if (description !== undefined) merged.description = description
  return { infoJson: JSON.stringify(merged), video, thumbnail, notes }
}

async function sendFile(bridge: Bridge, sessionId: string, fileId: string, file: LocalFile) {
  const total = Math.max(1, Math.ceil(file.size / CHUNK))
  const handle = await open(file.path, "r")
  try {
    const buffer = Buffer.alloc(CHUNK)
    for (let index = 0; index < total; index++) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK, index * CHUNK)
      await bridge.call(
        "youtube.uploadChunk",
        {
          sessionId,
          fileId,
          name: file.name,
          mime: file.mime,
          index,
          total,
          base64: buffer.subarray(0, bytesRead).toString("base64")
        },
        30_000
      )
    }
  } finally {
    await handle.close()
  }
}

async function fillOne(bridge: Bridge, folder: string): Promise<UploadOutcome> {
  const upload = await readUpload(folder)
  const opened = (await bridge.call("youtube.uploadOpen", { infoJson: upload.infoJson }, 150_000)) as {
    sessionId: string
    tabId: number
    channel: { name: string; handle?: string }
    warnings?: string[]
  }
  const channel = [opened.channel?.name, opened.channel?.handle].filter(Boolean).join(" ")
  try {
    await sendFile(bridge, opened.sessionId, "video", upload.video)
    if (upload.thumbnail) await sendFile(bridge, opened.sessionId, "thumbnail", upload.thumbnail)
    const result = (await bridge.call(
      "youtube.uploadCommit",
      { sessionId: opened.sessionId, videoId: "video", thumbnailId: upload.thumbnail ? "thumbnail" : undefined },
      330_000
    )) as Omit<UploadOutcome, "folder">
    return {
      folder,
      ok: result.ok !== false,
      tabId: result.tabId ?? opened.tabId,
      channel,
      message: result.message,
      warnings: [...upload.notes, ...(opened.warnings ?? []), ...(result.warnings ?? [])],
      filled: result.filled,
      videoUrl: result.videoUrl
    }
  } catch (error) {
    await bridge.call("youtube.uploadAbort", { sessionId: opened.sessionId }, 10_000).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    return { folder, ok: false, tabId: opened.tabId, channel, message, warnings: upload.notes }
  }
}

export async function fillYoutubeUploads(
  bridge: Bridge,
  inputs: string[]
): Promise<{ published: false; note: string; results: UploadOutcome[] }> {
  const folders = await resolveReleaseFolders(inputs)
  // One at a time: switching channels changes the whole Chrome profile's YouTube.
  const results: UploadOutcome[] = []
  for (const folder of folders) {
    results.push(
      await fillOne(bridge, folder).catch((error) => ({
        folder,
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      }))
    )
  }
  return {
    published: false,
    note:
      "Nothing was saved or published. Each tab is left on YouTube Studio's Visibility step with the upload running: " +
      "the user reviews it and clicks Save, Publish or Schedule. The Chrome profile's YouTube now acts as the last channel used.",
    results
  }
}
