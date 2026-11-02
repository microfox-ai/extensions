// MediaMake's local media library, as the download tools see it.
//
// ~/.mediamake/config.json names it:
//   { "library": { "root": "~/Downloads/_LIBRARY", "inbox": "~/Downloads/_INBOX" } }
// Downloads go to the inbox (<inbox>/<tool>/...), each with a <file>.source.json
// saying where it came from, and MediaMake's `media` CLI files them into the
// root and its SQLite catalog (<root>/.catalog/library.db). Before a download
// the tools ask the catalog (read only), and the inbox for what isn't filed
// yet, whether the library already has it. Without the config, nothing here
// applies: the tools keep their old folders and write no sidecars.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import type { DatabaseSync } from "node:sqlite"

export const SOURCE_SCHEMA = "mediamake.source/v1"
export const SIDECAR_SUFFIX = ".source.json"

export interface Library {
  home: string
  /** Absolute paths, when the config names them. */
  root?: string
  inbox?: string
}

export interface Have {
  /** Absolute path of the file. */
  path: string
  height: number | null
  fps: number | null
  /** Filed in the catalog, or a download in the inbox that isn't filed yet. */
  where: "library" | "inbox"
}

const expandHome = (path: string, home: string) =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path

const readJson = (path: string): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

export function readLibrary(home = homedir()): Library {
  const library = readJson(join(home, ".mediamake", "config.json"))?.library
  const at = (value: unknown) =>
    typeof value === "string" && value.trim() ? resolve(home, expandHome(value.trim(), home)) : undefined
  return { home, root: at(library?.root), inbox: at(library?.inbox) }
}

/** Whether the library is set up at all; sidecars are written only then. */
export const hasLibrary = (lib: Library) => Boolean(lib.root || lib.inbox)

const catalogFile = (lib: Library) => (lib.root ? join(lib.root, ".catalog", "library.db") : undefined)

/** Whether there's anything to check for a tool, so callers can skip work to find a ref. */
export const canLookup = (lib: Library, tool: string) =>
  Boolean((catalogFile(lib) && existsSync(catalogFile(lib)!)) || (lib.inbox && existsSync(join(lib.inbox, tool))))

const downloadsDir = (home: string) => join(home, "Downloads")

const isInside = (rel: string) => Boolean(rel) && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)

/**
 * A folder as Chrome's downloads API takes it: relative to Downloads, with "/".
 * Accepts that too, or a path inside ~/Downloads ("~/Downloads/x", "/Users/me/Downloads/x").
 */
export function downloadsFolder(folder: string, home = homedir()) {
  const path = expandHome(folder.trim(), home)
  const rel = isAbsolute(path) ? relative(downloadsDir(home), path) : path
  const parts = rel.split(/[\\/]+/).filter((part) => part && part !== ".")
  if (isAbsolute(rel) || parts.includes("..")) {
    throw new Error(`folder must be inside ${downloadsDir(home)}, where Chrome saves downloads; got "${folder}".`)
  }
  return parts.join("/")
}

/** <inbox>/<parts...> relative to Downloads, when the inbox is inside Downloads (Chrome can't save elsewhere). */
export function inboxFolder(lib: Library, ...parts: string[]) {
  if (!lib.inbox) return undefined
  const rel = relative(downloadsDir(lib.home), lib.inbox)
  return isInside(rel) ? [...rel.split(sep), ...parts].join("/") : undefined
}

// --- The catalog ---------------------------------------------------------

type Sqlite = typeof import("node:sqlite")
let sqlite: Promise<Sqlite | null> | undefined

// node:sqlite came with Node 22.5; on older Node there is nothing to check. The
// specifier is built at run time so the bundler leaves the import alone.
const loadSqlite = () => (sqlite ??= import(String("node:sqlite")).then((mod) => mod as Sqlite, () => null))

async function readCatalog<T>(lib: Library, read: (db: DatabaseSync) => T): Promise<T | undefined> {
  const file = catalogFile(lib)
  if (!file || !existsSync(file)) return undefined
  const mod = await loadSqlite()
  if (!mod) return undefined
  let db: DatabaseSync | undefined
  try {
    db = new mod.DatabaseSync(file, { readOnly: true, timeout: 2000 })
    return read(db)
  } catch (error) {
    // A catalog that's locked or mid-migration: download as if it weren't there.
    console.error("[library]", error instanceof Error ? error.message : error)
    return undefined
  } finally {
    db?.close()
  }
}

const positive = (value: unknown) => (typeof value === "number" && value > 0 ? value : null)

/** The library's file for a source (tool + ref), if the catalog has it online and it's on disk. */
export async function lookup(tool: string, ref: string, lib = readLibrary()): Promise<Have | undefined> {
  const row = await readCatalog(lib, (db) =>
    db
      .prepare(
        "SELECT i.path, i.height, i.fps FROM sources s JOIN items i ON i.id = s.item_id " +
          "WHERE s.tool = ? AND s.ref = ? AND i.status = 'online'"
      )
      .get(tool, ref)
  )
  if (typeof row?.path !== "string" || !row.path) return undefined
  const path = resolve(lib.root!, row.path)
  if (!existsSync(path)) return undefined
  return { path, height: positive(row.height), fps: positive(row.fps), where: "library" }
}

// --- The inbox -------------------------------------------------------------

function* filesIn(dir: string, depth: number, match: (name: string) => boolean): Generator<string> {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory() && depth > 0) yield* filesIn(path, depth - 1, match)
    else if (entry.isFile() && match(entry.name)) yield path
  }
}

/** A download still in <inbox>/<tool>, found by its sidecar. */
export function inInbox(tool: string, ref: string, lib = readLibrary()): Have | undefined {
  if (!lib.inbox) return undefined
  for (const sidecar of filesIn(join(lib.inbox, tool), 3, (name) => name.endsWith(SIDECAR_SUFFIX))) {
    const record = readJson(sidecar)
    if (record?.tool !== tool || record.ref !== ref) continue
    const path = sidecar.slice(0, -SIDECAR_SUFFIX.length)
    if (existsSync(path)) return { path, height: positive(record.height), fps: positive(record.fps), where: "inbox" }
  }
  return undefined
}

/** What the library has for a source: filed, else waiting in the inbox. */
export async function findMedia(tool: string, ref: string, lib = readLibrary()) {
  return (await lookup(tool, ref, lib)) ?? inInbox(tool, ref, lib)
}

// A video pin's file, by its name: the catalog's kind is the library section (images, footage…).
const PIN_VIDEO_FILE_RE = /\.(?:mp4|m4v|mov|webm|ts)$/i

/**
 * Every Pinterest pin the library has (filed, or saved by an earlier session still in the inbox),
 * and which of them are videos: a video pin's cover image can share its video's ref.
 */
export async function knownPins(lib = readLibrary()): Promise<{ pins: string[]; videos: string[] }> {
  const filed =
    (await readCatalog(lib, (db) =>
      db
        .prepare(
          "SELECT s.ref, i.path FROM sources s JOIN items i ON i.id = s.item_id WHERE s.tool = 'pinterest' AND i.status = 'online'"
        )
        .all()
        .map((row) => ({ ref: String(row.ref), file: String(row.path) }))
    )) ?? []
  const waiting: { ref: string; file: string }[] = []
  if (lib.inbox) {
    const manifests = filesIn(join(lib.inbox, "pinterest"), 2, (name) => /^_session.*\.json$/.test(name))
    for (const manifest of manifests) {
      for (const pin of readJson(manifest)?.pins ?? []) {
        if (typeof pin?.id !== "string" || typeof pin.file !== "string") continue
        if (existsSync(resolve(dirname(manifest), pin.file))) waiting.push({ ref: pin.id, file: pin.file })
      }
    }
  }
  const pins = [...filed, ...waiting]
  return {
    pins: [...new Set(pins.map((pin) => pin.ref))],
    videos: [...new Set(pins.filter((pin) => PIN_VIDEO_FILE_RE.test(pin.file)).map((pin) => pin.ref))]
  }
}

/** Names of the folders in a directory (for picking one that's free). */
export function subfolders(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

// --- Sidecars --------------------------------------------------------------

export interface SourceFields {
  tool: string
  ref: string
  url?: string
  pageUrl?: string
  title?: string
  author?: string
  query?: string
  prompt?: string
  model?: string
  height?: number | null
  fps?: number | null
}

// get-into-zone/lib/libraryFiles.ts writes the same records for YouTube.
const SOURCE_KEYS = ["tool", "ref", "url", "pageUrl", "title", "author", "query", "prompt", "model", "height", "fps"] as const

/** A sidecar's contents: keys in a fixed order, the unknown ones left out. */
export function sourceRecord(fields: SourceFields, downloadedAt = new Date()) {
  const record: Record<string, unknown> = { schema: SOURCE_SCHEMA }
  for (const key of SOURCE_KEYS) {
    const value = fields[key]
    if (typeof value === "number" ? value > 0 : typeof value === "string" && value.trim()) record[key] = value
  }
  record.downloadedAt = downloadedAt.toISOString()
  return record
}

/** Writes <file>.source.json next to a downloaded file and returns its path. */
export function writeSidecar(file: string, fields: SourceFields, downloadedAt?: Date) {
  const path = `${file}${SIDECAR_SUFFIX}`
  writeFileSync(path, JSON.stringify(sourceRecord(fields, downloadedAt), null, 2) + "\n")
  return path
}

// --- Small helpers for the records -----------------------------------------

/** YYYY-MM-DD in local time, for folder names. */
export const localDate = (date = new Date()) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, "0")).join("-")

/** The model a Midjourney prompt asks for ("v7", "niji 6"), if it names one. */
export function modelFromPrompt(prompt?: string) {
  const niji = /(?:^|\s)--niji(?:\s+(\d+(?:\.\d+)?))?(?=\s|$)/.exec(prompt ?? "")
  if (niji) return niji[1] ? `niji ${niji[1]}` : "niji"
  const version = /(?:^|\s)--(?:v|version)\s+(\d+(?:\.\d+)?)/.exec(prompt ?? "")
  return version ? `v${version[1]}` : undefined
}

/** A PNG's height from its header, without reading the rest of the file. */
export function pngHeight(file: string) {
  let fd: number | undefined
  try {
    fd = openSync(file, "r")
    const header = Buffer.alloc(24)
    if (readSync(fd, header, 0, 24, 0) < 24 || header.readUInt32BE(0) !== 0x89504e47) return undefined
    return header.readUInt32BE(20)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
