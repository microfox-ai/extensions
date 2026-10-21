// Muxes a video-only and an audio-only fragmented MP4 (the DASH streams
// YouTube serves) into a single two-track fragmented MP4, without re-encoding.

const VIDEO_TRACK_ID = 1
const AUDIO_TRACK_ID = 2

// tfhd flag: base-data-offset-present. Fragments using absolute offsets would
// break once moved, so they are rejected.
const TFHD_BASE_DATA_OFFSET = 0x1

/** A byte stream held as a list of chunks, so large files never need one huge buffer. */
export class ByteChunks {
  readonly length: number
  private readonly starts: number[] = []

  constructor(private readonly chunks: Uint8Array[]) {
    let total = 0
    for (const chunk of chunks) {
      this.starts.push(total)
      total += chunk.length
    }
    this.length = total
  }

  private locate(offset: number) {
    let lo = 0
    let hi = this.chunks.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  /** Zero-copy views covering [start, end). */
  views(start: number, end: number): Uint8Array[] {
    const out: Uint8Array[] = []
    let index = this.locate(start)
    let pos = start
    while (pos < end && index < this.chunks.length) {
      const chunk = this.chunks[index]
      const from = pos - this.starts[index]
      const to = Math.min(chunk.length, end - this.starts[index])
      if (to > from) out.push(chunk.subarray(from, to))
      pos = this.starts[index] + to
      index++
    }
    return out
  }

  /** A standalone copy of [start, end), for small boxes that get edited. */
  copy(start: number, end: number): Uint8Array {
    const out = new Uint8Array(end - start)
    let pos = 0
    for (const view of this.views(start, end)) {
      out.set(view, pos)
      pos += view.length
    }
    return out
  }

  u32(offset: number) {
    const b = this.copy(offset, offset + 4)
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0
  }

  type(offset: number) {
    return String.fromCharCode(...this.copy(offset, offset + 4))
  }
}

interface Box {
  type: string
  start: number
  end: number
  headerSize: number
}

function readBoxes(src: ByteChunks, start: number, end: number): Box[] {
  const boxes: Box[] = []
  let pos = start
  while (pos + 8 <= end) {
    let size = src.u32(pos)
    const type = src.type(pos + 4)
    let headerSize = 8
    if (size === 1) {
      size = src.u32(pos + 8) * 2 ** 32 + src.u32(pos + 12)
      headerSize = 16
    } else if (size === 0) {
      size = end - pos
    }
    if (size < headerSize || pos + size > end) {
      throw new Error(`Corrupt MP4: bad "${type}" box at byte ${pos}.`)
    }
    boxes.push({ type, start: pos, end: pos + size, headerSize })
    pos += size
  }
  return boxes
}

const view = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

function readMemBoxes(bytes: Uint8Array, start = 0, end = bytes.length) {
  return readBoxes(new ByteChunks([bytes]), start, end)
}

function child(bytes: Uint8Array, parent: Box, type: string) {
  return readMemBoxes(bytes, parent.start + parent.headerSize, parent.end).find(
    (b) => b.type === type
  )
}

function findPath(bytes: Uint8Array, parent: Box, path: string[]) {
  let box: Box | undefined = parent
  for (const type of path) {
    box = box && child(bytes, box, type)
  }
  return box
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const part of parts) {
    out.set(part, pos)
    pos += part.length
  }
  return out
}

function makeBox(type: string, payload: Uint8Array[]) {
  const size = 8 + payload.reduce((n, p) => n + p.length, 0)
  const header = new Uint8Array(8)
  view(header).setUint32(0, size)
  for (let i = 0; i < 4; i++) header[4 + i] = type.charCodeAt(i)
  return concat([header, ...payload])
}

// Offset of a field inside a full box payload, which differs between versions.
const fullBoxField = (bytes: Uint8Array, box: Box, v0: number, v1: number) =>
  box.start + box.headerSize + (bytes[box.start + box.headerSize] === 1 ? v1 : v0)

interface ParsedTrack {
  ftyp: Uint8Array
  mvhd: Uint8Array
  trak: Uint8Array
  trex: Uint8Array
  mehd?: Uint8Array
  timescale: number
  fragments: { moof: Box; mdat: Box }[]
  src: ByteChunks
}

function parseTrack(src: ByteChunks, label: string): ParsedTrack {
  const top = readBoxes(src, 0, src.length)
  const ftypBox = top.find((b) => b.type === "ftyp")
  const moovBox = top.find((b) => b.type === "moov")
  if (!ftypBox || !moovBox) {
    throw new Error(`The ${label} stream isn't an MP4 file.`)
  }

  const moov = src.copy(moovBox.start, moovBox.end)
  const moovRoot: Box = { ...moovBox, start: 0, end: moov.length }
  const mvhd = findPath(moov, moovRoot, ["mvhd"])
  const traks = readMemBoxes(moov, moovRoot.headerSize, moov.length).filter(
    (b) => b.type === "trak"
  )
  const trex = findPath(moov, moovRoot, ["mvex", "trex"])
  const mehd = findPath(moov, moovRoot, ["mvex", "mehd"])
  const mdhd = traks[0] && findPath(moov, traks[0], ["mdia", "mdhd"])
  if (!mvhd || traks.length !== 1 || !trex || !mdhd) {
    throw new Error(`The ${label} stream isn't a single-track fragmented MP4.`)
  }

  const fragments: ParsedTrack["fragments"] = []
  for (let i = 0; i < top.length; i++) {
    if (top[i].type !== "moof") continue
    const mdat = top[i + 1]
    if (mdat?.type !== "mdat") {
      throw new Error(`The ${label} stream has a fragment without media data.`)
    }
    fragments.push({ moof: top[i], mdat })
  }
  if (fragments.length === 0) {
    throw new Error(`The ${label} stream has no fragments.`)
  }

  return {
    ftyp: src.copy(ftypBox.start, ftypBox.end),
    mvhd: moov.slice(mvhd.start, mvhd.end),
    trak: moov.slice(traks[0].start, traks[0].end),
    trex: moov.slice(trex.start, trex.end),
    mehd: mehd && moov.slice(mehd.start, mehd.end),
    timescale: view(moov).getUint32(fullBoxField(moov, mdhd, 12, 20)),
    fragments,
    src
  }
}

function setTrackId(trak: Uint8Array, trex: Uint8Array, id: number) {
  const trakRoot = readMemBoxes(trak)[0]
  const tkhd = child(trak, trakRoot, "tkhd")
  if (!tkhd) throw new Error("Corrupt MP4: track header missing.")
  view(trak).setUint32(fullBoxField(trak, tkhd, 12, 20), id)
  view(trex).setUint32(12, id)
}

/** Points a moof at a new track ID, in place. Returns its decode time in seconds. */
function retargetMoof(moof: Uint8Array, trackId: number, timescale: number) {
  const root = readMemBoxes(moof)[0]
  let time = 0
  for (const box of readMemBoxes(moof, root.headerSize, moof.length)) {
    if (box.type === "traf") {
      const tfhd = child(moof, box, "tfhd")
      if (!tfhd) throw new Error("Corrupt MP4: fragment header missing.")
      const flags = view(moof).getUint32(tfhd.start + tfhd.headerSize) & 0xffffff
      if (flags & TFHD_BASE_DATA_OFFSET) {
        throw new Error("This stream uses absolute offsets and can't be merged.")
      }
      view(moof).setUint32(tfhd.start + tfhd.headerSize + 4, trackId)
      const tfdt = child(moof, box, "tfdt")
      if (tfdt) {
        const at = tfdt.start + tfdt.headerSize + 4
        const dv = view(moof)
        const ticks =
          moof[tfdt.start + tfdt.headerSize] === 1
            ? dv.getUint32(at) * 2 ** 32 + dv.getUint32(at + 4)
            : dv.getUint32(at)
        time = ticks / timescale
      }
    }
  }
  return time
}

/** Merges the two streams and returns Blob parts for the combined MP4. */
export function mergeAudioVideo(video: ByteChunks, audio: ByteChunks) {
  const v = parseTrack(video, "video")
  const a = parseTrack(audio, "audio")

  setTrackId(v.trak, v.trex, VIDEO_TRACK_ID)
  setTrackId(a.trak, a.trex, AUDIO_TRACK_ID)
  // next_track_ID is the last field of mvhd in both versions.
  view(v.mvhd).setUint32(v.mvhd.length - 4, AUDIO_TRACK_ID + 1)

  const mvex = makeBox("mvex", [...(v.mehd ? [v.mehd] : []), v.trex, a.trex])
  const moov = makeBox("moov", [v.mvhd, v.trak, a.trak, mvex])

  const fragments = [
    ...v.fragments.map((f) => ({ ...f, track: v, id: VIDEO_TRACK_ID })),
    ...a.fragments.map((f) => ({ ...f, track: a, id: AUDIO_TRACK_ID }))
  ].map((f) => {
    const moof = f.track.src.copy(f.moof.start, f.moof.end)
    const time = retargetMoof(moof, f.id, f.track.timescale)
    return { ...f, moof, time }
  })
  // Interleave by decode time so players can stream the file front to back.
  fragments.sort((x, y) => x.time - y.time || x.id - y.id)

  const parts: Uint8Array[] = [v.ftyp, moov]
  fragments.forEach((f, index) => {
    const mfhd = child(f.moof, readMemBoxes(f.moof)[0], "mfhd")
    if (mfhd) view(f.moof).setUint32(mfhd.start + mfhd.headerSize + 4, index + 1)
    parts.push(f.moof, ...f.track.src.views(f.mdat.start, f.mdat.end))
  })
  return parts
}
