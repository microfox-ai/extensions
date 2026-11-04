// Reads a YouTube pack folder the user picked in the popup (an <input webkitdirectory>
// FileList), the way the MCP server reads one from disk (mcp/src/youtubeUpload.ts):
// info.json with title.txt and description.txt, the video and the thumbnails; or a
// shorts-pack.json listing several shorts.

import { parseShortsPack } from "./youtubeShorts"
import { parseYoutubeUploadInfo, type YoutubeUploadInfo } from "./youtubeUpload"

const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|mpe?g|flv|3gp)$/i
const IMAGE = /\.(jpe?g|png)$/i

/** One upload: info.json's fields with the title and description text put in, and its files. */
export type PackUpload = {
  label: string
  /** info.json as YouTube Studio's content script reads it. */
  fields: Record<string, unknown>
  info: YoutubeUploadInfo
  video: File
  thumbnail: File | null
  abThumbnails: File[]
  /** Its day comes from the channel's calendar (shorts-pack.json's schedule). */
  needsDay: boolean
}

export type PackFolder = {
  folder: string
  kind: "pack" | "shorts"
  channel: string
  schedule: { time: string; from: string | null } | null
  uploads: PackUpload[]
  notes: string[]
  errors: string[]
}

class Folder {
  readonly name: string
  private byPath = new Map<string, File>()

  constructor(files: File[]) {
    const kept = files.filter((file) => !/(^|\/)\./.test(file.webkitRelativePath || file.name))
    this.name = (kept[0]?.webkitRelativePath || "").split("/")[0] || "Pack folder"
    for (const file of kept) {
      const path = (file.webkitRelativePath || file.name).split("/").slice(1).join("/")
      this.byPath.set(path.toLowerCase(), file)
    }
  }

  get(path: string): File | null {
    return this.byPath.get(path.replace(/^\.\//, "").toLowerCase()) ?? null
  }

  /** Files directly in this sub-folder ("" for the top), sorted by name. */
  in(dir: string, test: RegExp): File[] {
    const prefix = dir ? `${dir.toLowerCase()}/` : ""
    return [...this.byPath.entries()]
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/") && test.test(path))
      .map(([, file]) => file)
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

async function readJson(file: File): Promise<unknown> {
  try {
    return JSON.parse((await file.text()).replace(/^﻿/, ""))
  } catch {
    throw new Error(`${file.name} is not valid JSON.`)
  }
}

const firstLine = (text: string) => text.split(/\r?\n/).find((line) => line.trim())?.trim() || ""

/** Turns one info.json-shaped record into an upload, reading its text files and finding its files. */
async function resolveUpload(
  folder: Folder,
  raw: Record<string, unknown>,
  label: string,
  pickLoose: boolean
): Promise<{ upload: PackUpload | null; notes: string[]; errors: string[] }> {
  const notes: string[] = []
  const errors: string[] = []
  const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string).trim() : "")
  const fields: Record<string, unknown> = { ...raw }

  let title = text("title")
  const titleFile = text("titleFile") || (!title && pickLoose ? "title.txt" : "")
  if (titleFile) {
    const file = folder.get(titleFile)
    if (file) title = firstLine(await file.text())
    else if (text("titleFile")) errors.push(`${label}: titleFile ${titleFile} isn't in the folder.`)
  }
  let description = typeof raw.description === "string" ? raw.description : undefined
  const descriptionFile = text("descriptionFile") || (description === undefined && pickLoose ? "description.txt" : "")
  if (descriptionFile) {
    const file = folder.get(descriptionFile)
    if (file) description = await file.text()
    else if (text("descriptionFile")) errors.push(`${label}: descriptionFile ${descriptionFile} isn't in the folder.`)
  }
  fields.title = title
  delete fields.titleFile
  delete fields.descriptionFile
  if (description !== undefined) fields.description = description

  let video = text("video") ? folder.get(text("video")) : null
  if (text("video") && !video) errors.push(`${label}: the video ${text("video")} isn't in the folder.`)
  if (!text("video") && pickLoose) {
    const videos = folder.in("", VIDEO)
    if (videos.length === 1) video = videos[0]
    else errors.push(videos.length ? `${label}: ${videos.length} videos; name one in info.json "video".` : `${label}: no video file.`)
  }

  const abThumbnails: File[] = []
  for (const variant of Array.isArray(raw.abTest) ? raw.abTest : []) {
    const path = typeof variant?.thumbnail === "string" ? variant.thumbnail.trim() : ""
    if (!path) continue
    const file = folder.get(path)
    if (file) abThumbnails.push(file)
    else errors.push(`${label}: the A/B test thumbnail ${path} isn't in the folder.`)
  }
  let thumbnail = text("thumbnail") ? folder.get(text("thumbnail")) : null
  if (text("thumbnail") && !thumbnail) errors.push(`${label}: the thumbnail ${text("thumbnail")} isn't in the folder.`)
  if (!text("thumbnail") && pickLoose && !abThumbnails.length) {
    const picked = folder.in("thumbnails", IMAGE)
    const candidates = picked.length ? picked : folder.in("", /(^|\/)thumbnail\.(jpe?g|png)$/i)
    if (candidates.length === 1) thumbnail = candidates[0]
    else if (candidates.length > 1) notes.push(`${candidates.length} thumbnails and none named in info.json "thumbnail", so none is set.`)
  }

  const parsed = parseYoutubeUploadInfo(fields)
  errors.push(...parsed.errors.map((error) => `${label}: ${error}`))
  notes.push(...parsed.warnings.map((warning) => `${label}: ${warning}`))
  if (!video || errors.length) return { upload: null, notes, errors }
  return { upload: { label, fields, info: parsed.info, video, thumbnail, abThumbnails, needsDay: false }, notes, errors }
}

export async function readPackFolder(files: File[]): Promise<PackFolder> {
  const folder = new Folder(files)
  const result: PackFolder = { folder: folder.name, kind: "pack", channel: "", schedule: null, uploads: [], notes: [], errors: [] }
  const shortsFile = folder.get("shorts-pack.json")
  const infoFile = folder.get("info.json")
  try {
    if (shortsFile) {
      const { pack, errors } = parseShortsPack(await readJson(shortsFile))
      Object.assign(result, { kind: "shorts", channel: pack.channel, schedule: pack.schedule })
      result.errors.push(...errors)
      for (const [index, entry] of pack.entries.entries()) {
        const label = `Short ${index + 1}`
        // With a schedule, a short with no scheduleAt of its own gets the next empty day later.
        const needsDay = !!pack.schedule && !entry.scheduleAt && (!entry.visibility || /^schedul/i.test(String(entry.visibility)))
        const raw = { ...entry }
        if (needsDay) delete raw.visibility
        const { upload, notes, errors: problems } = await resolveUpload(folder, raw, label, false)
        result.notes.push(...notes)
        result.errors.push(...problems)
        if (upload) {
          upload.label = `${label}: ${upload.info.title}`
          upload.needsDay = needsDay
          result.uploads.push(upload)
        }
      }
    } else if (infoFile) {
      const raw = await readJson(infoFile)
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("info.json must be a JSON object.")
      const { upload, notes, errors } = await resolveUpload(folder, raw as Record<string, unknown>, folder.name, true)
      result.channel = upload?.info.channel || String((raw as Record<string, unknown>).channel || "")
      result.notes.push(...notes)
      result.errors.push(...errors)
      if (upload) result.uploads.push(upload)
    } else {
      result.errors.push("This folder has no info.json or shorts-pack.json.")
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
  }
  return result
}
