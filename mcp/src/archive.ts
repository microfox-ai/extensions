// Reads the archives updates come in, without a dependency: zip (the .mcpb
// bundle, the extension's release zip) and tar.gz (MediaMake catalog
// packages). Only regular files and folders are kept; links and anything
// whose path would land outside the target folder are refused.

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { gunzipSync, inflateRawSync } from "node:zlib"

export interface ArchiveFile {
  /** Relative path with "/" separators, e.g. "server/index.js". */
  path: string
  data: Buffer
}

/** A safe relative path, or throws: no absolute paths, drive letters or "..". */
export function safePath(raw: string) {
  const parts = raw.replace(/\\/g, "/").split("/").filter((part) => part && part !== ".")
  if (/^[a-zA-Z]:/.test(raw) || raw.startsWith("/") || parts.includes("..")) {
    throw new Error(`Refusing archive entry outside its folder: ${raw}`)
  }
  return parts.join("/")
}

export function readZip(zip: Buffer): ArchiveFile[] {
  // The end-of-central-directory record sits in the last 64 KB (it may be
  // followed by a comment).
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("Not a zip file.")
  const count = zip.readUInt16LE(eocd + 10)
  let offset = zip.readUInt32LE(eocd + 16)
  if (count === 0xffff || offset === 0xffffffff) throw new Error("Zip64 archives aren't supported.")

  const files: ArchiveFile[] = []
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt zip: bad central directory.")
    const flags = zip.readUInt16LE(offset + 8)
    const method = zip.readUInt16LE(offset + 10)
    const compressedSize = zip.readUInt32LE(offset + 20)
    const size = zip.readUInt32LE(offset + 24)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const mode = zip.readUInt32LE(offset + 38) >>> 16
    const local = zip.readUInt32LE(offset + 42)
    const name = zip.toString("utf8", offset + 46, offset + 46 + nameLength)
    offset += 46 + nameLength + extraLength + commentLength

    if (name.endsWith("/")) continue
    // Symbolic links (S_IFLNK) are skipped.
    if ((mode & 0o170000) === 0o120000) continue
    if (flags & 1) throw new Error(`Encrypted zip entry: ${name}`)
    if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error(`Corrupt zip: bad local header for ${name}`)
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28)
    const raw = zip.subarray(start, start + compressedSize)
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? inflateRawSync(raw) : undefined
    if (!data) throw new Error(`Unsupported zip compression (${method}) for ${name}`)
    if (data.length !== size) throw new Error(`Corrupt zip: ${name} has the wrong size`)
    files.push({ path: safePath(name), data })
  }
  return files
}

const field = (block: Buffer, start: number, length: number) =>
  block.toString("utf8", start, start + length).replace(/\0.*$/s, "")

export function readTarGz(archive: Buffer): ArchiveFile[] {
  const tar = gunzipSync(archive)
  const files: ArchiveFile[] = []
  let longName: string | undefined
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const size = parseInt(field(header, 124, 12).trim() || "0", 8)
    const type = String.fromCharCode(header[156] || 48)
    const prefix = field(header, 257, 6).startsWith("ustar") ? field(header, 345, 155) : ""
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    const data = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512
    longName = undefined

    if (type === "x") {
      // A pax header: its "path" record names the next entry.
      const path = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString("utf8"))
      longName = path?.[1]
    } else if (type === "L") {
      longName = data.toString("utf8").replace(/\0.*$/s, "")
    } else if (type === "0" || type === "7") {
      const path = safePath(name)
      // macOS tar adds AppleDouble "._name" files for extended attributes.
      if (path && !path.split("/").pop()!.startsWith("._")) files.push({ path, data: Buffer.from(data) })
    }
    // Folders, links and global headers are skipped.
  }
  return files
}

/** Writes the files under `dir` (which is created). */
export function writeFiles(dir: string, files: ArchiveFile[]) {
  mkdirSync(dir, { recursive: true })
  for (const file of files) {
    const target = join(dir, safePath(file.path))
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.data)
  }
}
