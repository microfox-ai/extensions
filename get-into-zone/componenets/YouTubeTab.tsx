import { Download, FolderOpen, RefreshCw, X } from "lucide-react"
import { useEffect, useMemo, useState, type CSSProperties } from "react"

import {
  YT_JOBS_KEY,
  YT_MODE_KEY,
  buildOptions,
  formatBytes,
  isYouTubeUrl,
  parseVideoId,
  type YtJob,
  type YtMode,
  type YtVideo
} from "../lib/youtube"

const YOUTUBE_RED = "#FF0000"

const MODES: { id: YtMode; label: string }[] = [
  { id: "both", label: "Video + audio" },
  { id: "video", label: "Video only" },
  { id: "audio", label: "Audio only" }
]

const STATUS_LABELS: Record<YtJob["status"], string> = {
  downloading: "Downloading",
  merging: "Merging video and audio",
  saving: "Saving",
  done: "Saved",
  error: "Failed",
  cancelled: "Cancelled"
}

const RUNNING = new Set<YtJob["status"]>(["downloading", "merging", "saving"])

const iconButton: CSSProperties = {
  display: "flex",
  border: "none",
  background: "transparent",
  padding: 2,
  cursor: "pointer",
  color: "#777"
}

const formatDuration = (seconds: number) => {
  if (!seconds) return ""
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = String(seconds % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`
}

function JobRow({ job }: { job: YtJob }) {
  const running = RUNNING.has(job.status)
  const percent =
    job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0
  const color =
    job.status === "error" ? "#c5221f" : job.status === "done" ? "#1e8e3e" : "#555"

  return (
    <div
      style={{
        padding: "8px 10px",
        marginTop: 6,
        borderRadius: 6,
        background: "#f5f5f5",
        fontSize: 12
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          title={job.filename}
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontWeight: 500
          }}>
          {job.filename}
        </span>
        {running && (
          <button
            title="Cancel"
            aria-label="Cancel download"
            style={iconButton}
            onClick={() =>
              chrome.runtime.sendMessage({ action: "youtubeCancel", jobId: job.id })
            }>
            <X size={13} />
          </button>
        )}
        {job.status === "done" && job.downloadId !== undefined && (
          <button
            title="Show in folder"
            aria-label="Show in folder"
            style={iconButton}
            onClick={() => chrome.downloads.show(job.downloadId!)}>
            <FolderOpen size={13} />
          </button>
        )}
      </div>

      {job.status === "downloading" && (
        <div
          style={{
            height: 4,
            borderRadius: 2,
            background: "#e0e0e0",
            marginTop: 6,
            overflow: "hidden"
          }}>
          <div
            style={{
              width: `${percent}%`,
              height: "100%",
              background: YOUTUBE_RED,
              transition: "width 0.3s"
            }}
          />
        </div>
      )}

      <div style={{ fontSize: 11, color, marginTop: 4 }}>
        {STATUS_LABELS[job.status]}
        {job.status === "downloading" && job.total > 0
          ? ` · ${formatBytes(job.received) || "0 KB"} of ${formatBytes(job.total)} (${percent}%)`
          : ""}
        {job.status === "error" && job.error ? `: ${job.error}` : ""}
      </div>
    </div>
  )
}

export function YouTubeTab() {
  const [tab, setTab] = useState<{ id: number; url?: string } | null>(null)
  const [video, setVideo] = useState<YtVideo | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [mode, setMode] = useState<YtMode>("both")
  const [optionId, setOptionId] = useState("")
  const [jobs, setJobs] = useState<YtJob[]>([])
  const [starting, setStarting] = useState(false)

  const videoId = parseVideoId(tab?.url)

  const loadVideo = (tabId: number) => {
    setLoading(true)
    setError("")
    chrome.runtime.sendMessage({ action: "youtubeGetVideo", tabId }, (response) => {
      setLoading(false)
      if (!response?.success) {
        setVideo(null)
        setError(response?.message || "Couldn't read this video.")
        return
      }
      setVideo(response.video)
    })
  }

  useEffect(() => {
    chrome.storage.local.get(YT_MODE_KEY, (result) => {
      if (MODES.some((m) => m.id === result[YT_MODE_KEY])) setMode(result[YT_MODE_KEY])
    })
    chrome.tabs.query({ active: true, currentWindow: true }, ([active]) => {
      if (active?.id === undefined) return
      setTab({ id: active.id, url: active.url })
      if (parseVideoId(active.url)) loadVideo(active.id)
    })

    const readJobs = (value: unknown) =>
      setJobs(
        Object.values((value ?? {}) as Record<string, YtJob>).sort(
          (a, b) => b.createdAt - a.createdAt
        )
      )
    chrome.storage.session.get(YT_JOBS_KEY, (result) => readJobs(result[YT_JOBS_KEY]))
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      namespace: string
    ) => {
      if (namespace === "session" && changes[YT_JOBS_KEY]) {
        readJobs(changes[YT_JOBS_KEY].newValue)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const options = useMemo(() => (video ? buildOptions(video, mode) : []), [video, mode])
  const selected = options.find((o) => o.id === optionId) ?? options[0]

  const pickMode = (next: YtMode) => {
    setMode(next)
    setOptionId("")
    chrome.storage.local.set({ [YT_MODE_KEY]: next })
  }

  const download = () => {
    if (!video || !selected) return
    setStarting(true)
    setError("")
    chrome.runtime.sendMessage(
      {
        action: "youtubeDownload",
        videoId: video.videoId,
        title: video.title,
        label: selected.label,
        ext: selected.ext,
        streams: selected.streams
      },
      (response) => {
        setStarting(false)
        if (!response?.success) {
          setError(response?.message || "Couldn't start the download.")
        }
      }
    )
  }

  const hasFinished = jobs.some((job) => !RUNNING.has(job.status))

  const renderVideo = () => {
    if (!tab) return null
    if (!videoId) {
      return (
        <div style={{ fontSize: 12, color: "#888" }}>
          {isYouTubeUrl(tab.url)
            ? "Open a video (or a Short) in this tab to download it."
            : "Open a YouTube video in this tab to download it."}
        </div>
      )
    }
    if (loading) {
      return <div style={{ fontSize: 12, color: "#888" }}>Reading video formats…</div>
    }
    if (!video) return null

    return (
      <>
        <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
          {video.thumbnail && (
            <img
              src={video.thumbnail}
              alt=""
              style={{
                width: 96,
                height: 54,
                objectFit: "cover",
                borderRadius: 4,
                flexShrink: 0,
                background: "#f0f0f0"
              }}
            />
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              title={video.title}
              style={{
                fontWeight: 600,
                fontSize: 13,
                lineHeight: 1.3,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden"
              }}>
              {video.title}
            </div>
            <div style={{ fontSize: 11, color: "#777", marginTop: 2 }}>
              {[video.author, formatDuration(video.lengthSeconds)]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            gap: 2,
            padding: 3,
            borderRadius: 8,
            background: "#f1f3f4"
          }}>
          {MODES.map((m) => {
            const active = m.id === mode
            return (
              <button
                key={m.id}
                onClick={() => pickMode(m.id)}
                style={{
                  flex: 1,
                  padding: "6px 0",
                  border: "none",
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: "pointer",
                  background: active ? "#fff" : "transparent",
                  color: active ? "#202124" : "#555",
                  fontWeight: active ? 600 : 400,
                  boxShadow: active ? "0 1px 2px rgba(0,0,0,0.15)" : "none"
                }}>
                {m.label}
              </button>
            )
          })}
        </div>

        {options.length === 0 ? (
          <div style={{ fontSize: 12, color: "#888", marginTop: 10 }}>
            No formats of this kind are available for this video.
          </div>
        ) : (
          <>
            <label style={{ display: "block", fontSize: 12, color: "#555", marginTop: 10 }}>
              Quality
              <select
                value={selected?.id}
                onChange={(e) => setOptionId(e.target.value)}
                style={{
                  width: "100%",
                  padding: 7,
                  marginTop: 4,
                  fontSize: 12,
                  boxSizing: "border-box"
                }}>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {[o.label, o.detail, formatBytes(o.size)].filter(Boolean).join(" · ")}
                  </option>
                ))}
              </select>
            </label>
            {mode === "both" && selected && selected.streams.length === 2 && (
              <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
                YouTube stores picture and sound separately at this quality; they're
                merged into one MP4 after downloading.
              </div>
            )}

            <button
              onClick={download}
              disabled={starting || !selected}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                width: "100%",
                marginTop: 10,
                padding: 9,
                border: "none",
                borderRadius: 6,
                background: YOUTUBE_RED,
                color: "#fff",
                cursor: starting ? "default" : "pointer",
                opacity: starting ? 0.7 : 1,
                fontSize: 12,
                fontWeight: 600
              }}>
              <Download size={13} /> {starting ? "Starting…" : "Download"}
            </button>
          </>
        )}
      </>
    )
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <div
        style={{
          border: "1px solid #e0e0e0",
          borderRadius: 8,
          padding: 12
        }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
          <Download size={15} color={YOUTUBE_RED} />
          <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>
            Download this video
          </span>
          {tab && videoId && (
            <button
              title="Reload formats"
              aria-label="Reload formats"
              disabled={loading}
              style={iconButton}
              onClick={() => loadVideo(tab.id)}>
              <RefreshCw size={13} />
            </button>
          )}
        </div>

        {renderVideo()}

        {error && (
          <div style={{ fontSize: 11, color: "#c5221f", marginTop: 8 }}>{error}</div>
        )}
      </div>

      {jobs.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <span style={{ fontSize: 12, color: "#666", flex: 1 }}>Downloads</span>
            {hasFinished && (
              <button
                onClick={() => chrome.runtime.sendMessage({ action: "youtubeClearFinished" })}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 6,
                  background: "#fff",
                  color: "#555",
                  fontSize: 11,
                  padding: "3px 8px",
                  cursor: "pointer"
                }}>
                Clear finished
              </button>
            )}
          </div>
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      )}
    </div>
  )
}
