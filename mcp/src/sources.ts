// Turns the image strings tools accept into sources the extension can load.
// Local files are read here, because the browser can't read the disk.

import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { extname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export type Source =
  | { url: string }
  | { jobId: string; index: number }
  | { base64: string; mimeType: string }
  | { code: string }

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif"
}

const MAX_BYTES = 20_000_000

export async function toSource(value: string, { allowStyleCode = false } = {}): Promise<Source> {
  const input = value.trim()
  if (/^https?:\/\//i.test(input)) return { url: input }

  // A Midjourney result: "mj:<jobId>#<index>" or a cdn.midjourney.com job id with index.
  const job = /^mj:([0-9a-f-]{36})(?:[#/](\d))?$/i.exec(input)
  if (job) return { jobId: job[1], index: Number(job[2] ?? 0) }

  if (allowStyleCode && /^\d{3,}$/.test(input)) return { code: input }

  const path = input.startsWith("file://")
    ? fileURLToPath(input)
    : input.startsWith("~/")
      ? resolve(homedir(), input.slice(2))
      : input
  if (!isAbsolute(path)) {
    throw new Error(`"${value}" isn't a URL, mj:<jobId>#<index> or an absolute file path.`)
  }
  const mimeType = MIME_TYPES[extname(path).toLowerCase()]
  if (!mimeType) throw new Error(`${path}: only PNG, JPEG, WebP and GIF images are supported.`)
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) throw new Error(`${path}: file not found.`)
  if (info.size > MAX_BYTES) throw new Error(`${path}: images must be under 20 MB.`)
  return { base64: (await readFile(path)).toString("base64"), mimeType }
}
