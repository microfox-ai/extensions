// Files the extension leaves for MediaMake's media library (the MCP server's
// mcp/src/library.ts reads the library's config and catalog and tells the
// extension when to write them): a <file>.source.json beside a download saying
// where it came from, and a Pinterest session's _session.json. The extension
// can only write inside Downloads, through chrome.downloads, so each one is
// saved as a download of a data: URL and then dropped from Chrome's download
// list (the file stays).

export const SOURCE_SCHEMA = "mediamake.source/v1"
export const PINTEREST_SESSION_SCHEMA = "mediamake.pinterest-session/v1"

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
  /** What it cost (Suno credits). */
  price?: number
  height?: number
  fps?: number
  // Generated songs (Suno): what MediaMake's ingest keeps beside the audio.
  lyrics?: string
  excludeStyles?: string
  instrumental?: boolean
  settings?: Record<string, unknown>
  parentRef?: string
  relation?: string
  /** The library item (SHA-256) a cover was made from. */
  sourceItem?: string
  workspace?: { id: string; name: string }
  /** The library channel it belongs to. */
  channel?: string
}

// The same keys, in the same order, as sourceRecord in mcp/src/library.ts.
const SOURCE_KEYS = [
  "tool",
  "ref",
  "url",
  "pageUrl",
  "title",
  "author",
  "query",
  "prompt",
  "model",
  "price",
  "height",
  "fps",
  "lyrics",
  "excludeStyles",
  "instrumental",
  "settings",
  "parentRef",
  "relation",
  "sourceItem",
  "workspace",
  "channel"
] as const

const keep = (value: unknown): unknown => {
  if (typeof value === "number") return value > 0 ? value : undefined
  if (typeof value === "string") return value.trim() ? value : undefined
  if (typeof value === "boolean") return value
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined && v !== null && v !== "")
    return entries.length ? Object.fromEntries(entries) : undefined
  }
  return undefined
}

/** A sidecar's contents: keys in a fixed order, the unknown ones left out. */
export function sourceRecord(fields: SourceFields, downloadedAt = new Date()) {
  const record: Record<string, unknown> = { schema: SOURCE_SCHEMA }
  for (const key of SOURCE_KEYS) {
    const value = keep(fields[key])
    if (value !== undefined) record[key] = value
  }
  record.downloadedAt = downloadedAt.toISOString()
  return record
}

/** A folder for chrome.downloads: relative to Downloads, "/"-separated, nothing that climbs out. "" for none. */
export const cleanFolder = (input: unknown) =>
  typeof input !== "string"
    ? ""
    : input
        .split(/[\\/]+/)
        .map((segment) =>
          segment
            .replace(/[<>:"|?*\u0000-\u001f]/g, "")
            .trim()
            .replace(/^\.+|\.+$/g, "")
            .trim()
        )
        .filter(Boolean)
        .join("/")

export const inFolder = (folder: string, name: string) => (folder ? `${folder}/${name}` : name)

/** A file name asked for without its extension, taking off one given anyway. */
export const withoutExtension = (name: string) =>
  name.trim().replace(/\.(mp4|webm|m4a|mov|mkv|jpe?g|png|webp|gif|heic)$/i, "")

/** YYYY-MM-DD in local time, for folder names. */
export const localDate = (date = new Date()) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((n) => String(n).padStart(2, "0")).join("-")

function toBase64(text: string) {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

// Resolves with the saved file's full path once a download finishes.
export function downloadFinished(downloadId: number) {
  return new Promise<string>((resolve, reject) => {
    const settle = (item?: chrome.downloads.DownloadItem) => {
      if (item?.state === "complete") {
        chrome.downloads.onChanged.removeListener(onChanged)
        resolve(item.filename)
      } else if (item?.state === "interrupted") {
        chrome.downloads.onChanged.removeListener(onChanged)
        reject(new Error(`Couldn't save the file: ${item.error ?? "interrupted"}`))
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

/** Saves JSON text at a path relative to Downloads; resolves with the file's full path. */
export async function saveJsonFile(
  path: string,
  text: string,
  conflictAction: chrome.downloads.FilenameConflictAction = "overwrite"
) {
  const downloadId = await chrome.downloads.download({
    url: `data:application/json;base64,${toBase64(text)}`,
    filename: path,
    conflictAction,
    saveAs: false
  })
  const saved = await downloadFinished(downloadId)
  await chrome.downloads.erase({ id: downloadId }).catch(() => {})
  return saved
}

/**
 * Writes <file>.source.json beside a finished download: in the folder it was
 * asked for (relative to Downloads), named after the file Chrome saved, which
 * may differ from the name asked for (" (1)").
 */
export function saveSourceSidecar(requested: string, savedPath: string, fields: SourceFields) {
  const folder = requested.includes("/") ? requested.slice(0, requested.lastIndexOf("/")) : ""
  const name = savedPath.split(/[\\/]/).pop()
  return saveJsonFile(inFolder(folder, `${name}.source.json`), JSON.stringify(sourceRecord(fields), null, 2) + "\n")
}

/** JSON with each entry of the top-level lists on one line: easy to read, and small enough for a data: URL. */
export function jsonByLine(data: Record<string, unknown>) {
  const fields = Object.entries(data).map(([key, value]) =>
    Array.isArray(value)
      ? `  ${JSON.stringify(key)}: [${
          value.length ? `\n${value.map((entry) => `    ${JSON.stringify(entry)}`).join(",\n")}\n  ` : ""
        }]`
      : `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`
  )
  return `{\n${fields.join(",\n")}\n}\n`
}
