// Reads release folders on disk and streams them to the extension, one
// DistroKid tab per folder. The browser cannot see these paths itself.

import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path"

import type { Bridge } from "./bridge.js"

const AUDIO_RANK: Record<string, number> = { ".wav": 0, ".m4a": 1, ".mp3": 2 }
const CHUNK = 256 * 1024

type ReleaseFile = { name: string; mime: string; bytes: Buffer }

export type FillOutcome = {
  folder: string
  ok: boolean
  tabId?: number
  message: string
  warnings?: string[]
  filled?: string[]
}

function resolvePath(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

function ignoredName(name: string): boolean {
  return name.startsWith(".") || name.startsWith("._") || name === "__MACOSX" || name === "node_modules"
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  async function rec(current: string, depth: number) {
    if (depth > 6 || out.length > 400) return
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (ignoredName(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) await rec(full, depth + 1)
      else if (entry.isFile()) out.push(full)
    }
  }
  await rec(dir, 0)
  return out
}

function mimeFor(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".wav":
      return "audio/wav"
    case ".mp3":
      return "audio/mpeg"
    case ".m4a":
      return "audio/mp4"
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".png":
      return "image/png"
    case ".gif":
      return "image/gif"
    default:
      return ""
  }
}

function imageSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length >= 24 && buf.toString("ascii", 1, 4) === "PNG") {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
  }
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null
  let i = 2
  while (i < buf.length - 8) {
    if (buf[i] !== 0xff) {
      i += 1
      continue
    }
    const marker = buf[i + 1]
    if (marker === 0xd8 || marker === 0xd9) {
      i += 2
      continue
    }
    const len = buf.readUInt16BE(i + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    }
    if (len < 2) break
    i += 2 + len
  }
  return null
}

async function hasInfoJson(dir: string): Promise<boolean> {
  try {
    return (await stat(join(dir, "info.json"))).isFile()
  } catch {
    return false
  }
}

/** A folder with info.json, or a parent whose child folders each have one. */
export async function resolveReleaseFolders(inputs: string[]): Promise<string[]> {
  const folders: string[] = []
  for (const input of inputs) {
    const dir = resolvePath(input)
    const info = await stat(dir).catch(() => null)
    if (!info?.isDirectory()) throw new Error(`${dir} is not a folder.`)
    if (await hasInfoJson(dir)) {
      folders.push(dir)
      continue
    }
    const children = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !ignoredName(entry.name))
      .map((entry) => join(dir, entry.name))
    const releases: string[] = []
    for (const child of children) {
      if (await hasInfoJson(child)) releases.push(child)
    }
    if (releases.length === 0) {
      throw new Error(`${dir} has no info.json, and none of its folders do either.`)
    }
    releases.sort((a, b) => a.localeCompare(b))
    folders.push(...releases)
  }
  return folders
}

async function readRelease(dir: string): Promise<{
  infoJson: string
  tracks: ReleaseFile[]
  cover: ReleaseFile
  notes: string[]
}> {
  const files = await walk(dir)
  const infos = files
    .filter((file) => basename(file).toLowerCase() === "info.json")
    .sort((a, b) => a.split(sep).length - b.split(sep).length || a.length - b.length)
  if (!infos[0]) throw new Error(`${dir} has no info.json.`)
  const infoJson = (await readFile(infos[0], "utf8")).replace(/^\uFEFF/, "")

  const audio = files.filter((file) => extname(file).toLowerCase() in AUDIO_RANK)
  const groups = new Map<string, string[]>()
  for (const file of audio) {
    const stem = basename(file).replace(/\.[^.]+$/, "").toLowerCase()
    const list = groups.get(stem) || []
    list.push(file)
    groups.set(stem, list)
  }
  const chosen = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, group]) =>
      [...group].sort(
        (a, b) =>
          (AUDIO_RANK[extname(a).toLowerCase()] ?? 9) - (AUDIO_RANK[extname(b).toLowerCase()] ?? 9)
      )[0]
    )
  if (chosen.length === 0) throw new Error(`${dir} has no .wav, .m4a, or .mp3 file.`)
  if (chosen.length > 35) throw new Error(`${dir} has ${chosen.length} songs. DistroKid's form stops at 35.`)

  const notes: string[] = []
  const skipped = audio.length - chosen.length
  if (skipped > 0) {
    notes.push(
      `Skipped ${skipped} extra format${skipped === 1 ? "" : "s"} of the same song (kept wav, then m4a, then mp3).`
    )
  }

  const images = files.filter((file) =>
    [".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(extname(file).toLowerCase())
  )
  const sized: { file: string; w: number; h: number }[] = []
  for (const file of images) {
    const bytes = await readFile(file)
    const size = imageSize(bytes)
    if (size) sized.push({ file, ...size })
  }
  const squares = sized.filter((image) => image.w === image.h && extname(image.file).toLowerCase() !== ".webp")
  if (squares.length === 0) {
    const webp = sized.filter((image) => extname(image.file).toLowerCase() === ".webp" && image.w === image.h)
    if (webp.length) throw new Error(`${dir}: DistroKid accepts JPG, PNG, or GIF. The square image is WebP.`)
    const listed = sized.map((image) => `${basename(image.file)} ${image.w}×${image.h}`).join(", ")
    throw new Error(listed ? `${dir} has no square cover. Found ${listed}.` : `${dir} has no JPG, PNG, or GIF cover.`)
  }
  const inRange = squares.filter((image) => image.w >= 1000 && image.w <= 5000)
  const pool = (inRange.length ? inRange : squares)
    .slice()
    .sort((a, b) => Math.abs(a.w - 3000) - Math.abs(b.w - 3000))
  const coverPath = pool[0]
  if (coverPath.w < 1000 || coverPath.w > 5000) {
    notes.push(
      `${basename(coverPath.file)} is ${coverPath.w}×${coverPath.h}. DistroKid wants 1000–5000 px, so it may reject this cover.`
    )
  }
  if (squares.length > 1) notes.push(`${squares.length} square images; using the one closest to 3000 px.`)

  const tracks: ReleaseFile[] = []
  for (const file of chosen) {
    tracks.push({ name: basename(file), mime: mimeFor(file), bytes: await readFile(file) })
  }
  return {
    infoJson,
    tracks,
    cover: { name: basename(coverPath.file), mime: mimeFor(coverPath.file), bytes: await readFile(coverPath.file) },
    notes
  }
}

async function sendFile(
  bridge: Bridge,
  sessionId: string,
  fileId: string,
  file: ReleaseFile
) {
  const total = file.bytes.length === 0 ? 0 : Math.max(1, Math.ceil(file.bytes.length / CHUNK))
  if (total === 0) {
    await bridge.call(
      "distrokid.chunk",
      { sessionId, fileId, name: file.name, mime: file.mime, index: 0, total: 0, base64: "" },
      30_000
    )
    return
  }
  for (let index = 0; index < total; index++) {
    const slice = file.bytes.subarray(index * CHUNK, Math.min(file.bytes.length, (index + 1) * CHUNK))
    await bridge.call(
      "distrokid.chunk",
      {
        sessionId,
        fileId,
        name: file.name,
        mime: file.mime,
        index,
        total,
        base64: slice.toString("base64")
      },
      30_000
    )
  }
}

async function fillOne(bridge: Bridge, folder: string): Promise<FillOutcome> {
  const release = await readRelease(folder)
  const opened = (await bridge.call("distrokid.open", { infoJson: release.infoJson }, 60_000)) as {
    sessionId: string
    tabId: number
  }
  try {
    const trackIds = release.tracks.map((_, index) => `track-${index}`)
    for (let index = 0; index < release.tracks.length; index++) {
      await sendFile(bridge, opened.sessionId, trackIds[index], release.tracks[index])
    }
    await sendFile(bridge, opened.sessionId, "cover", release.cover)
    const result = (await bridge.call(
      "distrokid.commit",
      { sessionId: opened.sessionId, trackIds, coverId: "cover" },
      150_000
    )) as FillOutcome
    return {
      folder,
      ok: result.ok !== false,
      tabId: result.tabId ?? opened.tabId,
      message: result.message,
      warnings: [...release.notes, ...(result.warnings ?? [])],
      filled: result.filled
    }
  } catch (error) {
    await bridge.call("distrokid.abort", { sessionId: opened.sessionId }, 10_000).catch(() => {})
    const message = error instanceof Error ? error.message : String(error)
    return { folder, ok: false, tabId: opened.tabId, message, warnings: release.notes }
  }
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return results
}

export async function fillDistrokidReleases(
  bridge: Bridge,
  inputs: string[],
  concurrency: number
): Promise<{
  submitted: false
  note: string
  results: FillOutcome[]
}> {
  const folders = await resolveReleaseFolders(inputs)
  const results = await mapPool(folders, concurrency, (folder) =>
    fillOne(bridge, folder).catch((error) => ({
      folder,
      ok: false,
      message: error instanceof Error ? error.message : String(error)
    }))
  )
  return {
    submitted: false,
    note: "Nothing was submitted. Review each tab and click Continue yourself.",
    results
  }
}
