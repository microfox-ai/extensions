import { Download, Film, Image as ImageIcon, RefreshCw } from "lucide-react"
import { useEffect, useState, type CSSProperties } from "react"

import {
  downloadsFor,
  parseInstagramUrl,
  type IgItem,
  type IgPost
} from "../lib/instagram"

const INSTAGRAM_PINK = "#E1306C"

const iconButton: CSSProperties = {
  display: "flex",
  border: "none",
  background: "transparent",
  padding: 2,
  cursor: "pointer",
  color: "#777"
}

function ItemTile({
  item,
  index,
  disabled,
  onDownload
}: {
  item: IgItem
  index: number
  disabled: boolean
  onDownload: () => void
}) {
  const [broken, setBroken] = useState(false)
  return (
    <div
      style={{
        position: "relative",
        aspectRatio: "1",
        borderRadius: 6,
        overflow: "hidden",
        background: "#f0f0f0"
      }}>
      {!broken && item.thumb ? (
        <img
          src={item.thumb}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "#aaa"
          }}>
          {item.kind === "video" ? <Film size={22} /> : <ImageIcon size={22} />}
        </div>
      )}
      <span
        style={{
          position: "absolute",
          top: 4,
          left: 4,
          display: "flex",
          alignItems: "center",
          gap: 3,
          padding: "1px 5px",
          borderRadius: 4,
          background: "rgba(0,0,0,0.6)",
          color: "#fff",
          fontSize: 10
        }}>
        {item.kind === "video" ? <Film size={10} /> : <ImageIcon size={10} />}
        {index + 1}
      </span>
      <button
        title={`Download ${item.kind}${item.width ? ` (${item.width}×${item.height})` : ""}`}
        aria-label={`Download item ${index + 1}`}
        disabled={disabled}
        onClick={onDownload}
        style={{
          position: "absolute",
          right: 4,
          bottom: 4,
          display: "flex",
          padding: 5,
          border: "none",
          borderRadius: 12,
          background: INSTAGRAM_PINK,
          color: "#fff",
          cursor: disabled ? "default" : "pointer",
          opacity: disabled ? 0.7 : 1
        }}>
        <Download size={12} />
      </button>
    </div>
  )
}

export function InstagramTab() {
  const [tabId, setTabId] = useState<number>()
  const [link, setLink] = useState("")
  const [post, setPost] = useState<IgPost | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [status, setStatus] = useState("")

  const load = (url: string, fromTab?: number) => {
    setLoading(true)
    setError("")
    setStatus("")
    chrome.runtime.sendMessage(
      { action: "instagramGetPost", url, tabId: fromTab },
      (response) => {
        setLoading(false)
        if (!response?.success) {
          setPost(null)
          setError(response?.message || "Couldn't read that post.")
          return
        }
        setPost(response.post)
      }
    )
  }

  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, ([active]) => {
      if (active?.id === undefined) return
      setTabId(active.id)
      if (parseInstagramUrl(active.url)) {
        setLink(active.url!)
        load(active.url!, active.id)
      }
    })
  }, [])

  const save = (items: IgItem[]) => {
    if (!post) return
    setSaving(true)
    setError("")
    setStatus(items.length === 1 ? "Saving…" : `Saving ${items.length} files…`)
    chrome.runtime.sendMessage(
      { action: "instagramDownload", files: downloadsFor(post, items) },
      (response) => {
        setSaving(false)
        if (!response?.success) {
          setStatus("")
          setError(response?.message || "Couldn't save the files.")
          return
        }
        setStatus(
          items.length === 1
            ? "Saved to Downloads"
            : `Saved ${items.length} files to Downloads`
        )
      }
    )
  }

  const linkValid = !!parseInstagramUrl(link)

  return (
    <div style={{ fontFamily: "system-ui, sans-serif" }}>
      <div
        style={{ border: "1px solid #e0e0e0", borderRadius: 8, padding: 12 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            marginBottom: 10
          }}>
          <Download size={15} color={INSTAGRAM_PINK} />
          <span style={{ fontWeight: 600, fontSize: 14, flex: 1 }}>
            Download from Instagram
          </span>
          {post && (
            <button
              title="Reload post"
              aria-label="Reload post"
              disabled={loading}
              style={iconButton}
              onClick={() => load(link, tabId)}>
              <RefreshCw size={13} />
            </button>
          )}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (linkValid) load(link, tabId)
          }}
          style={{ display: "flex", gap: 6 }}>
          <input
            value={link}
            onChange={(event) => setLink(event.target.value)}
            placeholder="Paste a post, reel or story link"
            style={{
              flex: 1,
              minWidth: 0,
              padding: 7,
              fontSize: 12,
              border: "1px solid #ccc",
              borderRadius: 6
            }}
          />
          <button
            type="submit"
            disabled={!linkValid || loading}
            style={{
              padding: "0 12px",
              border: "none",
              borderRadius: 6,
              background: INSTAGRAM_PINK,
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: !linkValid || loading ? "default" : "pointer",
              opacity: !linkValid || loading ? 0.6 : 1
            }}>
            {loading ? "Loading…" : "Load"}
          </button>
        </form>

        {!post && !loading && !error && (
          <div
            style={{
              fontSize: 12,
              color: "#888",
              marginTop: 10,
              lineHeight: 1.4
            }}>
            Open a post, reel or story, or paste its link. On instagram.com,
            hover any photo or video for a Download button. You need to be
            logged in to Instagram in this browser.
          </div>
        )}

        {post && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {post.username ? `@${post.username}` : "Instagram post"}
              <span style={{ fontWeight: 400, color: "#888", fontSize: 11 }}>
                {" "}
                · {post.items.length}{" "}
                {post.items.length === 1 ? "item" : "items"}
              </span>
            </div>
            {post.caption && (
              <div
                title={post.caption}
                style={{
                  fontSize: 11,
                  color: "#555",
                  marginTop: 2,
                  lineHeight: 1.35,
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden"
                }}>
                {post.caption}
              </div>
            )}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
                marginTop: 10
              }}>
              {post.items.map((item, index) => (
                <ItemTile
                  key={`${index}-${item.url}`}
                  item={item}
                  index={index}
                  disabled={saving}
                  onDownload={() => save([item])}
                />
              ))}
            </div>

            <button
              onClick={() => save(post.items)}
              disabled={saving}
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
                background: INSTAGRAM_PINK,
                color: "#fff",
                cursor: saving ? "default" : "pointer",
                opacity: saving ? 0.7 : 1,
                fontSize: 12,
                fontWeight: 600
              }}>
              <Download size={13} />
              {post.items.length === 1
                ? "Download"
                : `Download all (${post.items.length})`}
            </button>
          </div>
        )}

        {status && (
          <div
            style={{
              fontSize: 11,
              color: saving ? "#555" : "#1e8e3e",
              marginTop: 8
            }}>
            {status}
          </div>
        )}
        {error && (
          <div style={{ fontSize: 11, color: "#c5221f", marginTop: 8 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
