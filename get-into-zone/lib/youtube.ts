export const YT_JOBS_KEY = "youtubeJobs"
export const YT_MODE_KEY = "youtubeMode"

export type YtMode = "both" | "video" | "audio"

export interface YtFormat {
  itag: number
  url: string
  mimeType: string
  container: "mp4" | "webm"
  codec: string
  kind: "video" | "audio"
  /** A video format that already carries sound (no merge needed). */
  hasAudio: boolean
  bitrate: number
  contentLength?: number
  qualityLabel?: string
  height?: number
  audioTrack?: string
}

export interface YtVideo {
  videoId: string
  title: string
  author: string
  lengthSeconds: number
  thumbnail?: string
  formats: YtFormat[]
}

export interface YtOption {
  id: string
  label: string
  detail: string
  size?: number
  ext: "mp4" | "webm" | "m4a"
  streams: YtFormat[]
}

export type YtJobStatus =
  | "downloading"
  | "merging"
  | "saving"
  | "done"
  | "error"
  | "cancelled"

export interface YtJob {
  id: string
  videoId: string
  title: string
  label: string
  filename: string
  status: YtJobStatus
  received: number
  total: number
  error?: string
  blobUrl?: string
  downloadId?: number
  /** The YouTube tab that started the download from its page buttons. */
  tabId?: number
  /** Identifies the chosen formats so expired stream URLs can be re-fetched. */
  streams?: { itag: number; contentLength?: number; audioTrack?: string }[]
  createdAt: number
}

export function parseVideoId(rawUrl?: string): string | null {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, "")
  const valid = (id: string | null | undefined) =>
    id && /^[\w-]{11}$/.test(id) ? id : null
  if (host === "youtu.be") return valid(url.pathname.slice(1))
  if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return null
  if (url.pathname === "/watch") return valid(url.searchParams.get("v"))
  const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/)
  return valid(match?.[1])
}

export const isYouTubeUrl = (rawUrl?: string) => {
  try {
    const host = new URL(rawUrl ?? "").hostname
    return host === "youtube.com" || host.endsWith(".youtube.com")
  } catch {
    return false
  }
}

export const sanitizeFileName = (name: string) =>
  name
    .replace(/[\\/:*?"<>|~\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 150) || "youtube-video"

export const formatBytes = (bytes?: number) => {
  if (!bytes) return ""
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

const CODEC_NAMES: [RegExp, string][] = [
  [/^avc1/, "H.264"],
  [/^av01/, "AV1"],
  [/^vp0?9/, "VP9"],
  [/^mp4a/, "AAC"],
  [/^opus/, "Opus"]
]

export const codecName = (codec: string) =>
  CODEC_NAMES.find(([re]) => re.test(codec))?.[1] ?? codec

/**
 * Runs inside the YouTube tab (injected with chrome.scripting), because the
 * player API rejects requests sent with an extension origin. Asks for formats
 * whose stream URLs need no signature deciphering.
 * Must stay self-contained: it is serialized into the page.
 */
export async function fetchPlayerInPage(videoId: string) {
  // VISIONOS URLs need no PO token but the client is refused without visitor
  // data. IOS URLs without a PO token mostly stop after ~1 minute of media
  // (HTTP 403); they stay as the fallback for videos VISIONOS can't play.
  const clients = [
    {
      clientName: "VISIONOS",
      clientVersion: "1.02",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      osName: "visionOS",
      osVersion: "26.5.23O471"
    },
    {
      clientName: "IOS",
      clientVersion: "20.10.4",
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.3.2.22D82"
    }
  ]

  const VISITOR_RE = /"VISITOR_DATA":"([^"]+)"/
  let visitorData: string | undefined
  for (const script of Array.from(document.scripts)) {
    visitorData = script.textContent?.match(VISITOR_RE)?.[1]
    if (visitorData) break
  }
  if (!visitorData) {
    try {
      const html = await (
        await fetch(`${location.origin}/`, { credentials: "omit" })
      ).text()
      visitorData = html.match(VISITOR_RE)?.[1]
    } catch {
      // VISIONOS then fails with a bot check and IOS is used instead.
    }
  }

  let lastReason = "YouTube didn't return any downloadable formats."
  for (const client of clients) {
    let data: any
    try {
      const resp = await fetch(
        `${location.origin}/youtubei/v1/player?prettyPrint=false`,
        {
          method: "POST",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            ...(visitorData ? { "X-Goog-Visitor-Id": visitorData } : {})
          },
          body: JSON.stringify({
            context: { client: { ...client, hl: "en", gl: "US", visitorData } },
            videoId,
            contentCheckOk: true,
            racyCheckOk: true
          })
        }
      )
      if (!resp.ok) {
        lastReason = `YouTube player request failed (${resp.status}).`
        continue
      }
      data = await resp.json()
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error)
      continue
    }

    const status = data?.playabilityStatus
    if (status?.status !== "OK") {
      lastReason = status?.reason || `Video is not playable (${status?.status}).`
      continue
    }
    // A live stream's formats only cover the last few seconds.
    if (data.videoDetails?.isLive) {
      return {
        ok: false as const,
        message: "This is a live stream. It can be downloaded after it ends."
      }
    }
    const raw = [
      ...(data.streamingData?.formats ?? []),
      ...(data.streamingData?.adaptiveFormats ?? [])
    ].filter((f: any) => typeof f.url === "string" && !f.isDrc)
    if (raw.length === 0) continue

    const details = data.videoDetails ?? {}
    const thumbs = details.thumbnail?.thumbnails ?? []
    return {
      ok: true as const,
      video: {
        videoId,
        title: details.title || videoId,
        author: details.author || "",
        lengthSeconds: Number(details.lengthSeconds) || 0,
        thumbnail: thumbs[thumbs.length - 1]?.url,
        formats: raw.map((f: any) => {
          const mime = String(f.mimeType || "")
          return {
            itag: f.itag,
            url: f.url,
            mimeType: mime,
            container: mime.includes("webm") ? "webm" : "mp4",
            codec: (mime.match(/codecs="([^"]+)"/)?.[1] ?? "").split(",")[0].trim(),
            kind: mime.startsWith("audio/") ? "audio" : "video",
            bitrate: Number(f.averageBitrate || f.bitrate) || 0,
            contentLength: f.contentLength ? Number(f.contentLength) : undefined,
            qualityLabel: f.qualityLabel,
            height: f.height,
            audioTrack: f.audioTrack?.audioIsDefault === false
              ? f.audioTrack.displayName
              : undefined,
            hasAudio: Boolean(f.audioQuality)
          }
        })
      }
    }
  }
  return { ok: false as const, message: lastReason }
}

const sizeOf = (streams: YtFormat[]) =>
  streams.every((s) => s.contentLength)
    ? streams.reduce((n, s) => n + (s.contentLength ?? 0), 0)
    : undefined

const byQuality = (a: YtFormat, b: YtFormat) =>
  (b.height ?? 0) - (a.height ?? 0) || b.bitrate - a.bitrate

/** Builds the choices shown for each mode, best first. */
export function buildOptions(video: YtVideo, mode: YtMode): YtOption[] {
  // Dubbed tracks are only offered as audio-only; merges use the original audio.
  const audio = video.formats
    .filter((f) => f.kind === "audio")
    .sort((a, b) => b.bitrate - a.bitrate)
  const videoOnly = video.formats
    .filter((f) => f.kind === "video" && !f.hasAudio)
    .sort(byQuality)
  const muxed = video.formats
    .filter((f) => f.kind === "video" && f.hasAudio)
    .sort(byQuality)

  if (mode === "audio") {
    return audio.map((f) => ({
      id: `a${f.itag}${f.audioTrack ?? ""}`,
      label: `${f.container === "mp4" ? "M4A" : "WebM"} · ${Math.round(f.bitrate / 1000)} kbps`,
      detail: [codecName(f.codec), f.audioTrack].filter(Boolean).join(" · "),
      size: f.contentLength,
      ext: f.container === "mp4" ? "m4a" : "webm",
      streams: [f]
    }))
  }

  if (mode === "video") {
    return videoOnly.map((f) => ({
      id: `v${f.itag}`,
      label: `${f.qualityLabel ?? `${f.height}p`} · ${codecName(f.codec)}`,
      detail: `${f.container.toUpperCase()}, no sound`,
      size: f.contentLength,
      ext: f.container,
      streams: [f]
    }))
  }

  const bestAudio = audio.find((f) => f.container === "mp4" && !f.audioTrack)
  // One option per resolution: H.264 where it exists (plays everywhere), AV1 above that.
  const perLabel = new Map<string, YtFormat>()
  for (const f of bestAudio ? videoOnly : []) {
    if (f.container !== "mp4" || !f.qualityLabel) continue
    const current = perLabel.get(f.qualityLabel)
    const isH264 = f.codec.startsWith("avc1")
    if (!current || (isH264 && !current.codec.startsWith("avc1"))) {
      perLabel.set(f.qualityLabel, f)
    }
  }
  const merged: YtOption[] = [...perLabel.values()].map((f) => {
    const streams = [f, bestAudio!]
    return {
      id: `b${f.itag}`,
      label: `${f.qualityLabel} · ${codecName(f.codec)}`,
      detail: "MP4 with sound",
      size: sizeOf(streams),
      ext: "mp4",
      streams
    }
  })
  const single: YtOption[] = muxed
    .filter((f) => !perLabel.has(f.qualityLabel ?? ""))
    .map((f) => ({
      id: `m${f.itag}`,
      label: `${f.qualityLabel ?? `${f.height}p`} · ${codecName(f.codec)}`,
      detail: `${f.container.toUpperCase()} with sound`,
      size: f.contentLength,
      ext: f.container,
      streams: [f]
    }))
  return [...merged, ...single].sort((a, b) => byQuality(a.streams[0], b.streams[0]))
}
