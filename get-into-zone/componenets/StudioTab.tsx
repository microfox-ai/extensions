import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"

import { clearJobFiles, putJobFile } from "../lib/studioFiles"
import type { StudioJob, StudioJobItem, StudioJobState } from "../lib/studioJobs"
import { readPackFolder, type PackFolder } from "../lib/youtubePackFiles"

// YouTube Studio: upload a pack folder (info.json), upload every short of a
// shorts-pack.json, or fill the channel's Shorts drafts from a similar short. The
// service worker does the work (lib/studioJobs.ts): this popup closes as soon as a
// Studio tab comes to the front, and the job carries on.

type Prefs = { channel: string; time: string; finish: boolean }
const PREFS_KEY = "studioPrefs"
const DEFAULT_PREFS: Prefs = { channel: "", time: "18:30", finish: false }

export function StudioTab() {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS)
  const [job, setJob] = useState<StudioJobState | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    chrome.storage.local.get([PREFS_KEY, "studioJob"]).then((stored) => {
      setPrefs({ ...DEFAULT_PREFS, ...(stored[PREFS_KEY] || {}) })
      setJob(stored.studioJob || null)
    })
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes.studioJob) setJob(changes.studioJob.newValue || null)
    }
    chrome.storage.onChanged.addListener(onChange)
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [])

  const update = (next: Partial<Prefs>) => {
    const merged = { ...prefs, ...next }
    setPrefs(merged)
    void chrome.storage.local.set({ [PREFS_KEY]: merged })
  }

  const busy = job?.status === "running"

  /** Saves the folder's files for the service worker and hands it the job. */
  const start = async (job: StudioJob, folder?: PackFolder) => {
    setError("")
    if (busy) return setError("A job is still running.")
    await clearJobFiles()
    if (folder) {
      const items: StudioJobItem[] = []
      for (const [index, upload] of folder.uploads.entries()) {
        const key = (name: string) => `${index}/${name}`
        await putJobFile(key("video"), upload.video)
        if (upload.thumbnail) await putJobFile(key("thumbnail"), upload.thumbnail)
        for (const [n, file] of upload.abThumbnails.entries()) await putJobFile(key(`ab-${n}`), file)
        items.push({
          label: upload.label,
          fields: upload.fields,
          files: {
            video: key("video"),
            thumbnail: upload.thumbnail ? key("thumbnail") : undefined,
            ab: upload.abThumbnails.map((_, n) => key(`ab-${n}`))
          },
          needsDay: upload.needsDay
        })
      }
      job.items = items
    }
    const reply = await chrome.runtime.sendMessage({ action: "studio-job", job })
    if (!reply?.ok) setError(reply?.error || "The job didn't start.")
  }

  return (
    <div style={{ fontSize: 12, lineHeight: 1.45 }}>
      <h2 style={{ margin: "0 0 6px", fontSize: 16 }}>YouTube Studio</h2>
      <p style={{ margin: "0 0 10px", color: "#444" }}>
        Browse Hack switches Studio to the channel and fills each upload. It keeps going after this popup closes;
        open it again to see how it went.
      </p>
      <label style={{ display: "flex", gap: 6, alignItems: "flex-start", marginBottom: 10 }}>
        <input type="checkbox" checked={prefs.finish} onChange={(event) => update({ finish: event.target.checked })} />
        <span>
          Click Schedule for me. Only for uploads with a schedule; Save and Publish stay yours. Off, each upload waits
          in its own tab for you.
        </span>
      </label>

      <PackCard
        title="Upload from a pack"
        hint="A folder with info.json, the video and its thumbnails, as MediaMake's pack-youtube makes it."
        kind="pack"
        busy={busy}
        onStart={(folder) => start({ kind: "pack", channel: folder.channel, finish: prefs.finish }, folder)}
      />

      <PackCard
        title="Bulk Upload Shorts"
        hint="A folder with shorts-pack.json. Shorts without a scheduleAt go on the next days that have no short."
        kind="shorts"
        busy={busy}
        onStart={(folder) =>
          start(
            {
              kind: "shorts",
              channel: folder.channel,
              time: folder.schedule?.time || prefs.time,
              from: folder.schedule?.from,
              finish: prefs.finish
            },
            folder
          )
        }
      />

      <Card title="Autofill Shorts">
        <p style={{ margin: "0 0 6px", color: "#444" }}>
          For each draft on the channel's Shorts tab: copies the details and title of the most similar short already
          filled in, and schedules it on the next day that has no short.
        </p>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={prefs.channel}
            onChange={(event) => update({ channel: event.target.value })}
            placeholder="@channel-handle"
            style={{ ...inputStyle, flex: 2 }}
          />
          <input type="time" value={prefs.time} onChange={(event) => update({ time: event.target.value })} style={{ ...inputStyle, flex: 1 }} />
        </div>
        <button
          type="button"
          disabled={busy || !prefs.channel.trim()}
          onClick={() => void start({ kind: "autofill", channel: prefs.channel.trim(), time: prefs.time, finish: prefs.finish })}
          style={{ ...buttonStyle(busy || !prefs.channel.trim() ? "#E0E0E0" : "#CC0000", busy || !prefs.channel.trim() ? "#666" : "#fff"), marginTop: 6 }}>
          Autofill drafts
        </button>
      </Card>

      {error && <p style={{ color: "#9f1239" }}>{error}</p>}
      {job && <JobStatus job={job} />}
    </div>
  )
}

function PackCard({
  title,
  hint,
  kind,
  busy,
  onStart
}: {
  title: string
  hint: string
  kind: PackFolder["kind"]
  busy: boolean
  onStart: (folder: PackFolder) => Promise<void>
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [folder, setFolder] = useState<PackFolder | null>(null)
  const [reading, setReading] = useState(false)

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setReading(true)
    const read = await readPackFolder(Array.from(files))
    if (read.kind !== kind && !read.errors.length) {
      read.errors.push(kind === "shorts" ? "This folder has info.json, not shorts-pack.json: use Upload from a pack." : "This folder has shorts-pack.json: use Bulk Upload Shorts.")
    }
    setFolder(read)
    setReading(false)
  }

  const blocked = busy || !folder || folder.errors.length > 0 || !folder.uploads.length
  return (
    <Card title={title}>
      <p style={{ margin: "0 0 6px", color: "#444" }}>{hint}</p>
      <input
        ref={(node) => {
          inputRef.current = node
          node?.setAttribute("webkitdirectory", "")
          node?.setAttribute("directory", "")
        }}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) => void onFiles(event.target.files)}
      />
      <button
        type="button"
        onClick={() => {
          if (inputRef.current) inputRef.current.value = ""
          inputRef.current?.click()
        }}
        style={buttonStyle("#E0E0E0", "#111")}>
        {reading ? "Reading…" : folder ? "Choose a different folder" : "Choose folder"}
      </button>
      {folder && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 700 }}>
            {folder.folder}
            {folder.channel ? ` · ${folder.channel}` : ""}
          </div>
          {folder.schedule && <div>At {folder.schedule.time}, from {folder.schedule.from || "tomorrow"}</div>}
          {folder.uploads.map((upload) => (
            <div key={upload.label}>
              {upload.label} ({upload.video.name}
              {upload.needsDay ? ", next empty day" : upload.info.scheduleAt ? `, ${upload.info.scheduleAt.date} ${upload.info.scheduleAt.time}` : ""})
            </div>
          ))}
          <List items={folder.errors} color="#9f1239" />
          <List items={folder.notes} color="#9a3412" />
          <button
            type="button"
            disabled={blocked}
            onClick={() => void onStart(folder)}
            style={{ ...buttonStyle(blocked ? "#E0E0E0" : "#CC0000", blocked ? "#666" : "#fff"), marginTop: 6 }}>
            {folder.uploads.length > 1 ? `Upload ${folder.uploads.length} shorts` : "Upload"}
          </button>
        </div>
      )}
    </Card>
  )
}

function JobStatus({ job }: { job: StudioJobState }) {
  const title = { pack: "Upload from a pack", shorts: "Bulk Upload Shorts", autofill: "Autofill Shorts" }[job.kind]
  const state = { running: "running…", done: "done", failed: "stopped" }[job.status]
  return (
    <Card title={`${title} · ${job.channel}: ${state}`}>
      {job.log.slice(-6).map((line, index) => (
        <div key={index} style={{ color: "#444" }}>
          {line}
        </div>
      ))}
      {job.results.map((result, index) => (
        <div key={index} style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 700, color: result.ok ? "#166534" : "#9f1239" }}>{result.label}</div>
          <div>{result.message}</div>
          <List items={result.warnings} color="#9a3412" />
        </div>
      ))}
    </Card>
  )
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ border: "1px solid #E0E0E0", borderRadius: 6, padding: 10, marginBottom: 10 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  )
}

function List({ items, color }: { items: string[]; color: string }) {
  if (!items.length) return null
  return (
    <ul style={{ color, paddingLeft: 18, margin: "4px 0" }}>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

const inputStyle: CSSProperties = { padding: 6, border: "1px solid #ccc", borderRadius: 4, fontSize: 12, minWidth: 0 }

function buttonStyle(background: string, color: string): CSSProperties {
  return { width: "100%", padding: 9, border: "none", borderRadius: 6, background, color, cursor: "pointer", fontSize: 13 }
}
