import { ByteChunks, mergeAudioVideo } from "./mp4Merge"

// Downloads an HLS stream into a single file: the best variant, plus its
// separate audio rendition when there is one. fMP4/CMAF streams come out as
// an MP4; MPEG-TS streams are concatenated into a .ts file.

export interface HlsFile {
  /** Blob parts making up the file, in order. */
  parts: Uint8Array[]
  ext: "mp4" | "ts"
  mime: string
}

interface Part {
  url: string
  range?: [offset: number, length: number]
}

interface MediaPlaylist {
  init?: Part
  segments: Part[]
}

const SEGMENT_CONCURRENCY = 4

function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {}
  const list = line.slice(line.indexOf(":") + 1)
  for (const match of list.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    out[match[1]] = match[2].replace(/^"|"$/g, "")
  }
  return out
}

const playlistLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

async function fetchText(url: string) {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Playlist request failed: ${resp.status}`)
  return resp.text()
}

async function fetchPart(part: Part) {
  const headers: HeadersInit = part.range
    ? { Range: `bytes=${part.range[0]}-${part.range[0] + part.range[1] - 1}` }
    : {}
  const resp = await fetch(part.url, { headers })
  if (!resp.ok) throw new Error(`Segment request failed: ${resp.status}`)
  return new Uint8Array(await resp.arrayBuffer())
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function fetchParts(parts: Part[]) {
  const out: Uint8Array[] = new Array(parts.length)
  for (let i = 0; i < parts.length; i += SEGMENT_CONCURRENCY) {
    const batch = parts.slice(i, i + SEGMENT_CONCURRENCY)
    const bytes = await Promise.all(batch.map(fetchPart))
    bytes.forEach((chunk, j) => (out[i + j] = chunk))
  }
  return concat(out)
}

function parseMediaPlaylist(text: string, playlistUrl: string): MediaPlaylist {
  const playlist: MediaPlaylist = { segments: [] }
  // A BYTERANGE without "@offset" continues where the previous range of the
  // same file ended.
  const rangeEnds = new Map<string, number>()
  const toPart = (uri: string, byteRange?: string): Part => {
    const url = new URL(uri, playlistUrl).href
    if (!byteRange) return { url }
    const [length, offset] = byteRange.split("@").map(Number)
    const start = Number.isFinite(offset) ? offset : rangeEnds.get(url) ?? 0
    rangeEnds.set(url, start + length)
    return { url, range: [start, length] }
  }

  let pendingRange: string | undefined
  for (const line of playlistLines(text)) {
    if (line.startsWith("#EXT-X-KEY")) {
      const method = attributes(line).METHOD
      if (method && method !== "NONE") {
        throw new Error("Encrypted video streams aren't supported.")
      }
    } else if (line.startsWith("#EXT-X-MAP")) {
      const attrs = attributes(line)
      playlist.init = toPart(attrs.URI, attrs.BYTERANGE)
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = line.slice("#EXT-X-BYTERANGE:".length)
    } else if (!line.startsWith("#")) {
      playlist.segments.push(toPart(line, pendingRange))
      pendingRange = undefined
    }
  }
  if (playlist.segments.length === 0) throw new Error("Video playlist is empty.")
  return playlist
}

// CMAF tracks are often one file addressed by byte ranges; fetching it whole
// is one request instead of one per segment, and the merger skips the extra
// index boxes it contains.
async function fetchFmp4Track(playlist: MediaPlaylist) {
  const parts = [playlist.init!, ...playlist.segments]
  const files = new Set(parts.map((part) => part.url))
  if (files.size === 1) return fetchPart({ url: parts[0].url })
  return fetchParts(parts)
}

export async function downloadHls(masterUrl: string): Promise<HlsFile> {
  const masterText = await fetchText(masterUrl)
  let videoUrl = masterUrl
  let videoText = masterText
  let audioUrl: string | undefined

  if (masterText.includes("#EXT-X-STREAM-INF")) {
    const lines = playlistLines(masterText)
    const variants: { bandwidth: number; audio?: string; url: string }[] = []
    lines.forEach((line, i) => {
      if (!line.startsWith("#EXT-X-STREAM-INF")) return
      const uri = lines.slice(i + 1).find((next) => !next.startsWith("#"))
      if (!uri) return
      const attrs = attributes(line)
      variants.push({
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        audio: attrs.AUDIO,
        url: new URL(uri, masterUrl).href
      })
    })
    if (variants.length === 0) throw new Error("Video has no playable stream.")
    const best = variants.reduce((a, b) => (b.bandwidth > a.bandwidth ? b : a))
    videoUrl = best.url
    videoText = await fetchText(videoUrl)

    const audio = lines
      .filter((line) => line.startsWith("#EXT-X-MEDIA:"))
      .map(attributes)
      .filter(
        (attrs) =>
          attrs.TYPE === "AUDIO" &&
          attrs.URI &&
          (!best.audio || attrs["GROUP-ID"] === best.audio)
      )
      .sort((a, b) => Number(b.DEFAULT === "YES") - Number(a.DEFAULT === "YES"))[0]
    if (audio) audioUrl = new URL(audio.URI, masterUrl).href
  }

  const video = parseMediaPlaylist(videoText, videoUrl)
  if (!video.init) {
    return {
      parts: [await fetchParts(video.segments)],
      ext: "ts",
      mime: "video/mp2t"
    }
  }

  const videoBytes = await fetchFmp4Track(video)
  if (!audioUrl) return { parts: [videoBytes], ext: "mp4", mime: "video/mp4" }

  const audio = parseMediaPlaylist(await fetchText(audioUrl), audioUrl)
  if (!audio.init) throw new Error("Unsupported video: audio isn't fragmented MP4.")
  const audioBytes = await fetchFmp4Track(audio)
  return {
    parts: mergeAudioVideo(new ByteChunks([videoBytes]), new ByteChunks([audioBytes])),
    ext: "mp4",
    mime: "video/mp4"
  }
}
