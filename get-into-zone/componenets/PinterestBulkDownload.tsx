import { Download, Play, Square, UploadCloud } from "lucide-react"
import { useEffect, useState, type CSSProperties } from "react"

import {
  BULK_PREFS_KEY,
  bulkSessionKey,
  parseTags,
  sanitizeFolder,
  type BulkDestination,
  type BulkPrefs,
  type BulkSession
} from "../lib/pinterestBulk"
import { isPinterestHost } from "../lib/saverRules"

const PINTEREST_RED = "#E60023"
const DEFAULT_LIMIT = "25"

const DESTINATIONS: { id: BulkDestination; label: string }[] = [
  { id: "browser", label: "Browser downloads" },
  { id: "mediamake", label: "Mediamake" }
]

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

export function PinterestBulkDownload() {
  const [tab, setTab] = useState<{ id: number; isPinterest: boolean } | null>(
    null
  )
  const [session, setSession] = useState<BulkSession | null>(null)
  const [destination, setDestination] = useState<BulkDestination>("browser")
  const [folder, setFolder] = useState(
    `pinterest-${new Date().toISOString().slice(0, 10)}`
  )
  const [includeVideos, setIncludeVideos] = useState(true)
  // Empty means "<folder>/videos".
  const [videoFolder, setVideoFolder] = useState("")
  const [tags, setTags] = useState("pinterest")
  const [limit, setLimit] = useState(DEFAULT_LIMIT)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(
    null
  )

  useEffect(() => {
    chrome.storage.local.get([BULK_PREFS_KEY, "tags"], (result) => {
      const prefs = result[BULK_PREFS_KEY] as Partial<BulkPrefs> | undefined
      if (prefs?.destination === "browser" || prefs?.destination === "mediamake") {
        setDestination(prefs.destination)
      }
      if (prefs?.folder) setFolder(prefs.folder)
      if (typeof prefs?.includeVideos === "boolean") {
        setIncludeVideos(prefs.includeVideos)
      }
      if (prefs?.videoFolder) setVideoFolder(prefs.videoFolder)
      if (typeof prefs?.perPageLimit === "number") {
        setLimit(prefs.perPageLimit > 0 ? String(prefs.perPageLimit) : "")
      }
      const savedTags =
        prefs?.tags || (typeof result.tags === "string" ? result.tags : "")
      if (savedTags.trim()) setTags(savedTags)
    })

    chrome.tabs.query({ active: true, currentWindow: true }, ([active]) => {
      if (active?.id === undefined) return
      let hostname = ""
      try {
        hostname = new URL(active.url ?? "").hostname
      } catch {
        // Not a web page.
      }
      setTab({ id: active.id, isPinterest: isPinterestHost(hostname) })
      const key = bulkSessionKey(active.id)
      chrome.storage.session.get(key, (result) => setSession(result[key] ?? null))
    })
  }, [])

  useEffect(() => {
    if (!tab) return
    const key = bulkSessionKey(tab.id)
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      namespace: string
    ) => {
      if (namespace === "session" && changes[key]) {
        setSession(changes[key].newValue ?? null)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [tab])

  const start = () => {
    if (!tab) return
    const perPageLimit = Math.max(0, Math.floor(Number(limit) || 0))
    const cleanFolder = sanitizeFolder(folder)
    const cleanVideoFolder = videoFolder.trim() ? sanitizeFolder(videoFolder) : ""
    setFolder(cleanFolder)
    setVideoFolder(cleanVideoFolder)
    const prefs: BulkPrefs = {
      destination,
      folder: cleanFolder,
      includeVideos,
      videoFolder: cleanVideoFolder,
      tags,
      perPageLimit
    }
    chrome.storage.local.set({ [BULK_PREFS_KEY]: prefs })

    setBusy(true)
    setNotice(null)
    chrome.runtime.sendMessage(
      {
        action: "pinterestBulkStart",
        tabId: tab.id,
        destination,
        folder: cleanFolder,
        includeVideos,
        videoFolder: cleanVideoFolder,
        tags: parseTags(tags),
        perPageLimit
      },
      (response) => {
        setBusy(false)
        if (!response?.success) {
          setNotice({
            text: response?.message || "Could not start the download.",
            error: true
          })
          return
        }
        if (response.message) setNotice({ text: response.message })
      }
    )
  }

  const stop = () => {
    if (!tab) return
    setNotice(null)
    chrome.runtime.sendMessage({ action: "pinterestBulkStop", tabId: tab.id })
  }

  const running = Boolean(session?.active)
  const pageCount = session ? Object.keys(session.pages).length : 0

  const renderRunning = (s: BulkSession) => {
    const current = s.currentPage
    const counts = current ? s.pages[current] : undefined
    const progress = (taken = 0) =>
      s.perPageLimit > 0 ? `${taken} / ${s.perPageLimit}` : String(taken)
    return (
      <>
        <div style={{ fontSize: 12, color: "#444", marginBottom: 8 }}>
          {s.destination === "browser" ? (
            <>
              Images to <strong>Downloads/{s.folder}</strong>
              {s.includeVideos && (
                <>
                  , videos to <strong>Downloads/{s.videoFolder}</strong>
                </>
              )}
            </>
          ) : (
            <>
              Uploading {s.includeVideos ? "images and videos" : "images"} to
              Mediamake with tags{" "}
              <strong>{s.tags.length > 0 ? s.tags.join(", ") : "pinterest"}</strong>
            </>
          )}
          {" · "}
          {s.perPageLimit > 0
            ? `up to ${s.perPageLimit} ${s.includeVideos ? "of each " : ""}per page`
            : "no per-page limit"}
        </div>

        <div style={{ display: "flex", gap: 6 }}>
          <Stat label="Images" value={s.saved} />
          {s.includeVideos && <Stat label="Videos" value={s.savedVideos} />}
          <Stat label="Queued" value={s.pending.length} />
          <Stat label="Failed" value={s.failed} />
          <Stat label="Pages" value={pageCount} />
        </div>

        {current && (
          <div
            title={current}
            style={{
              fontSize: 11,
              color: "#777",
              marginTop: 8,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}>
            This page ({current}):{" "}
            {s.currentPageRevisited
              ? "visited earlier, skipped"
              : `${progress(counts?.images)} images` +
                (s.includeVideos ? `, ${progress(counts?.videos)} videos` : "")}
          </div>
        )}

        {s.failed > 0 && s.lastError && (
          <div style={{ fontSize: 11, color: "#c5221f", marginTop: 6 }}>
            Last error: {s.lastError}
          </div>
        )}

        <button
          onClick={stop}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            width: "100%",
            marginTop: 10,
            padding: 9,
            border: "1px solid #ddd",
            borderRadius: 6,
            background: "#fff",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600
          }}>
          <Square size={12} /> Stop
        </button>
      </>
    )
  }

  const renderForm = () => (
    <>
      <div style={{ fontSize: 12, color: "#555" }}>Save to</div>
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: 3,
          marginTop: 4,
          borderRadius: 8,
          background: "#f1f3f4"
        }}>
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

      <label
        style={{
          ...labelStyle,
          display: "flex",
          alignItems: "center",
          gap: 6,
          cursor: "pointer"
        }}>
        <input
          type="checkbox"
          checked={includeVideos}
          onChange={(e) => setIncludeVideos(e.target.checked)}
        />
        Also download videos
      </label>

      {destination === "browser" ? (
        <>
          <label style={labelStyle}>
            Images folder (inside Downloads)
            <input
              type="text"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="pinterest"
              style={inputStyle}
            />
          </label>
          {includeVideos && (
            <label style={labelStyle}>
              Videos folder (inside Downloads)
              <input
                type="text"
                value={videoFolder}
                onChange={(e) => setVideoFolder(e.target.value)}
                placeholder={`${sanitizeFolder(folder)}/videos`}
                style={inputStyle}
              />
            </label>
          )}
        </>
      ) : (
        <label style={labelStyle}>
          Tags (comma-separated)
          <input
            type="text"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="pinterest, moodboard"
            style={inputStyle}
          />
        </label>
      )}

      <label style={labelStyle}>
        Max {includeVideos ? "images, and videos," : "images"} per page
        <input
          type="number"
          min={0}
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          placeholder="No limit"
          style={inputStyle}
        />
      </label>
      <div style={{ fontSize: 11, color: "#888", marginTop: 4 }}>
        Leave empty for no limit. Pages you go back to aren't downloaded again.
      </div>

      {session && (
        <div style={{ fontSize: 11, color: "#777", marginTop: 8 }}>
          Last run in this tab: {session.saved} images
          {session.savedVideos > 0 ? `, ${session.savedVideos} videos` : ""}
          {session.failed > 0 ? `, ${session.failed} failed` : ""} from{" "}
          {pageCount} page{pageCount === 1 ? "" : "s"}.
        </div>
      )}

      <button
        onClick={start}
        disabled={busy}
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
          background: PINTEREST_RED,
          color: "#fff",
          cursor: busy ? "default" : "pointer",
          opacity: busy ? 0.7 : 1,
          fontSize: 12,
          fontWeight: 600
        }}>
        <Play size={12} /> {busy ? "Starting..." : "Start downloading this tab"}
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 10
        }}>
        <Download size={15} color={PINTEREST_RED} />
        <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>
          Bulk download
        </span>
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

      {!tab ? null : !tab.isPinterest && !running ? (
        <div style={{ fontSize: 12, color: "#888" }}>
          Open a Pinterest page in this tab to download every pin image you
          browse.
        </div>
      ) : running && session ? (
        renderRunning(session)
      ) : (
        renderForm()
      )}

      {notice && (
        <div
          style={{
            fontSize: 11,
            marginTop: 8,
            color: notice.error ? "#c5221f" : "#1a4fa0"
          }}>
          {notice.text}
        </div>
      )}
    </div>
  )
}
