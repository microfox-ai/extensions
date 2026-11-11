import { Download, Play, Square, UploadCloud } from "lucide-react"
import { useEffect, useState, type CSSProperties } from "react"

import {
  GI_DEFAULT_COUNT,
  GI_MAX_COUNT,
  GI_PREFS_KEY,
  giSessionKey,
  isGoogleImagesUrl,
  type GiDestination,
  type GiPrefs,
  type GiSession
} from "../lib/googleImages"
import { cleanFolder, localDate } from "../lib/libraryFiles"
import { parseTags, sessionFolderName } from "../lib/pinterestBulk"
import { SUNO_PREFS_KEY, readSunoPrefs } from "../lib/sunoPrefs"

const GOOGLE_BLUE = "#1a73e8"

const DESTINATIONS: { id: GiDestination; label: string }[] = [
  { id: "browser", label: "Browser downloads" },
  { id: "mediamake", label: "Mediamake" }
]

const MIN_SIZES = [0, 500, 800, 1000, 1500, 2000]

const inputStyle: CSSProperties = {
  width: "100%",
  padding: 8,
  boxSizing: "border-box",
  marginTop: 4,
  fontSize: 12
}

const labelStyle: CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "#555",
  marginTop: 10
}

const buttonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  width: "100%",
  marginTop: 10,
  padding: 9,
  borderRadius: 6,
  fontSize: 12,
  fontWeight: 600
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        flex: 1,
        textAlign: "center",
        padding: "6px 0",
        borderRadius: 6,
        background: "#f5f5f5"
      }}>
      <div style={{ fontSize: 16, fontWeight: 600 }}>{value}</div>
      <div style={{ fontSize: 10, color: "#777" }}>{label}</div>
    </div>
  )
}

// Bulk download from the Google Images search in the active tab: the
// original image behind each result, up to a count, into the library inbox
// (with a .source.json beside each) or any folder in Downloads, or Mediamake.
function GoogleImagesBulkDownload() {
  const [tab, setTab] = useState<{ id: number; url: string; isImages: boolean } | null>(null)
  const [session, setSession] = useState<GiSession | null>(null)
  const [destination, setDestination] = useState<GiDestination>("browser")
  const [count, setCount] = useState(String(GI_DEFAULT_COUNT))
  const [minSize, setMinSize] = useState(0)
  // Empty means the default folder (defaultFolder).
  const [folder, setFolder] = useState("")
  const [inbox, setInbox] = useState("_INBOX")
  const [tags, setTags] = useState("google-images")
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)

  useEffect(() => {
    chrome.storage.local.get([GI_PREFS_KEY, SUNO_PREFS_KEY, "tags"], (result) => {
      const prefs = result[GI_PREFS_KEY] as Partial<GiPrefs> | undefined
      if (prefs?.destination === "browser" || prefs?.destination === "mediamake") {
        setDestination(prefs.destination)
      }
      if (typeof prefs?.count === "number" && prefs.count > 0) setCount(String(prefs.count))
      if (typeof prefs?.minSize === "number") setMinSize(prefs.minSize)
      const savedTags = prefs?.tags || (typeof result.tags === "string" ? result.tags : "")
      if (savedTags.trim()) setTags(savedTags)
      setInbox(readSunoPrefs(result[SUNO_PREFS_KEY]).inboxFolder)
    })

    chrome.tabs.query({ active: true, currentWindow: true }, ([active]) => {
      if (active?.id === undefined) return
      const url = active.url ?? ""
      setTab({ id: active.id, url, isImages: isGoogleImagesUrl(url) })
      const key = giSessionKey(active.id)
      chrome.storage.session.get(key, (result) => setSession(result[key] ?? null))
    })
  }, [])

  useEffect(() => {
    if (!tab) return
    const key = giSessionKey(tab.id)
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, namespace: string) => {
      if (namespace === "session" && changes[key]) setSession(changes[key].newValue ?? null)
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [tab])

  const defaultFolder = tab
    ? `${cleanFolder(inbox) || "_INBOX"}/google-images/${sessionFolderName(tab.url, localDate())}`
    : ""

  const start = () => {
    if (!tab) return
    const total = Math.min(GI_MAX_COUNT, Math.max(1, Math.floor(Number(count) || GI_DEFAULT_COUNT)))
    setCount(String(total))
    const target = cleanFolder(folder) || defaultFolder
    const inboxRoot = cleanFolder(inbox) || "_INBOX"
    const prefs: GiPrefs = { destination, count: total, minSize, tags }
    chrome.storage.local.set({ [GI_PREFS_KEY]: prefs })

    setBusy(true)
    setNotice(null)
    chrome.runtime.sendMessage(
      {
        action: "googleImagesBulkStart",
        tabId: tab.id,
        destination,
        folder: target,
        // Inside the library inbox, MediaMake's `media ingest` reads where each came from.
        sidecars: target === inboxRoot || target.startsWith(`${inboxRoot}/`),
        tags: parseTags(tags),
        count: total,
        minWidth: minSize,
        minHeight: minSize
      },
      (response) => {
        setBusy(false)
        if (!response?.success) {
          setNotice({ text: response?.message || "Could not start the download.", error: true })
        }
      }
    )
  }

  const stop = () => {
    if (!tab) return
    setNotice(null)
    chrome.runtime.sendMessage({ action: "googleImagesBulkStop", tabId: tab.id })
  }

  const running = Boolean(session?.active)

  const renderRunning = (s: GiSession) => {
    const done = Math.min(s.saved, s.count)
    return (
      <>
        <div style={{ fontSize: 12, color: "#444", marginBottom: 8 }}>
          {s.destination === "browser" ? (
            <>
              Saving <strong>{s.query || "this search"}</strong> to <strong>Downloads/{s.folder}</strong>
            </>
          ) : (
            <>
              Uploading <strong>{s.query || "this search"}</strong> to Mediamake
            </>
          )}
          {s.minWidth || s.minHeight ? ` · at least ${s.minWidth}×${s.minHeight}px` : ""}
        </div>

        <div style={{ height: 6, borderRadius: 3, background: "#e8eaed", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${(done / Math.max(1, s.count)) * 100}%`,
              background: GOOGLE_BLUE,
              transition: "width 0.3s"
            }}
          />
        </div>
        <div style={{ fontSize: 11, color: "#555", margin: "4px 0 8px" }}>
          {done} of {s.count} saved
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <Stat label="Saved" value={s.saved} />
          <Stat label="Queued" value={s.pending.length} />
          <Stat label="Failed" value={s.failed} />
          <Stat label="Too small" value={s.tooSmall} />
          {s.skipping ? <Stat label="Library has" value={s.skippedInLibrary} /> : null}
        </div>

        {s.failed > 0 && s.lastError && (
          <div style={{ fontSize: 11, color: "#c5221f", marginTop: 6 }}>Last error: {s.lastError}</div>
        )}

        <button onClick={stop} style={{ ...buttonStyle, border: "1px solid #ddd", background: "#fff", cursor: "pointer" }}>
          <Square size={12} /> Stop
        </button>
      </>
    )
  }

  const renderForm = () => (
    <>
      <div style={{ fontSize: 12, color: "#555" }}>Save to</div>
      <div style={{ display: "flex", gap: 2, padding: 3, marginTop: 4, borderRadius: 8, background: "#f1f3f4" }}>
        {DESTINATIONS.map((d) => {
          const selected = d.id === destination
          return (
            <button
              key={d.id}
              onClick={() => setDestination(d.id)}
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                padding: "6px 0",
                border: "none",
                borderRadius: 6,
                fontSize: 12,
                cursor: "pointer",
                background: selected ? "#fff" : "transparent",
                color: selected ? "#202124" : "#555",
                fontWeight: selected ? 600 : 400,
                boxShadow: selected ? "0 1px 2px rgba(0,0,0,0.15)" : "none"
              }}>
              {d.id === "browser" ? <Download size={13} /> : <UploadCloud size={13} />}
              {d.label}
            </button>
          )
        })}
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <label style={{ ...labelStyle, flex: 1 }}>
          How many images
          <input
            type="number"
            min={1}
            max={GI_MAX_COUNT}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ ...labelStyle, flex: 1 }}>
          Smallest side
          <select value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} style={inputStyle}>
            {MIN_SIZES.map((size) => (
              <option key={size} value={size}>
                {size ? `${size}px or more` : "Any size"}
              </option>
            ))}
          </select>
        </label>
      </div>

      {destination === "browser" ? (
        <>
          <label style={labelStyle}>
            Folder (inside Downloads)
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder={defaultFolder}
              style={inputStyle}
            />
          </label>
          <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
            Inside {cleanFolder(inbox) || "_INBOX"}, each image gets a .source.json (its page and this search) for
            MediaMake's library.
          </div>
        </>
      ) : (
        <label style={labelStyle}>
          Tags (comma-separated)
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="google-images, moodboard"
            style={inputStyle}
          />
        </label>
      )}

      {session && (
        <div style={{ fontSize: 11, color: "#777", marginTop: 8 }}>
          Last run in this tab: {session.saved} saved
          {session.failed > 0 ? `, ${session.failed} failed` : ""}
          {session.endReason ? `. ${session.endReason}` : "."}
        </div>
      )}

      <button
        onClick={start}
        disabled={busy}
        style={{
          ...buttonStyle,
          border: "none",
          background: GOOGLE_BLUE,
          color: "#fff",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.7 : 1
        }}>
        <Play size={12} /> {busy ? "Starting..." : `Download ${Number(count) || GI_DEFAULT_COUNT} images`}
      </button>
    </>
  )

  return (
    <div
      style={{
        border: "1px solid #e0e0e0",
        borderRadius: 8,
        padding: 12,
        marginBottom: 16,
        fontFamily: "system-ui, sans-serif"
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <Download size={15} color={GOOGLE_BLUE} />
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>Bulk download</span>
        {running && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "2px 8px",
              borderRadius: 10,
              background: "#e6f4ea",
              color: "#1e8e3e"
            }}>
            Running
          </span>
        )}
      </div>

      {!tab ? null : !tab.isImages && !running ? (
        <div style={{ fontSize: 12, color: "#888" }}>
          Open a Google Images search in this tab (Google, then Images) to download the full-size image behind each
          result.
        </div>
      ) : running && session ? (
        renderRunning(session)
      ) : (
        renderForm()
      )}

      {notice && (
        <div style={{ fontSize: 11, marginTop: 8, color: notice.error ? "#c5221f" : "#1a4fa0" }}>{notice.text}</div>
      )}
    </div>
  )
}

export function GoogleImagesTab() {
  return <GoogleImagesBulkDownload />
}
