import { useEffect, useState } from "react"

interface PinterestAnalysis {
  id: string
  imageUrl: string
  pageUrl: string
  imageAlt: string
  description: string
  keywords: string[]
  artStyle: string[]
  audienceKeywords: string[]
  createdAt: string
}

export function PinterestTab() {
  const [analyses, setAnalyses] = useState<PinterestAnalysis[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState("")
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadAnalyses = () => {
    setIsLoading(true)
    setError("")
    chrome.runtime.sendMessage(
      { action: "fetchPinterestAnalyses", limit: 50, offset: 0 },
      (response) => {
        setIsLoading(false)
        if (!response?.success) {
          setError(response?.message || "Failed to load analyses.")
          return
        }
        const items: PinterestAnalysis[] = response.data?.items ?? []
        setAnalyses(items)
      }
    )
  }

  useEffect(() => {
    loadAnalyses()
  }, [])

  const copyText = (id: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1800)
    })
  }

  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      })
    } catch {
      return iso
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 16 }}>📌 Pinterest AI Analyses</h2>
        <button
          onClick={loadAnalyses}
          disabled={isLoading}
          style={{
            padding: "4px 10px",
            fontSize: 11,
            background: "#E60023",
            color: "white",
            border: "none",
            borderRadius: 4,
            cursor: isLoading ? "not-allowed" : "pointer",
            opacity: isLoading ? 0.7 : 1
          }}>
          {isLoading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && (
        <p style={{ color: "#dc3545", fontSize: 12, marginBottom: 8 }}>{error}</p>
      )}

      {!isLoading && analyses.length === 0 && !error && (
        <p style={{ color: "#888", fontSize: 13, textAlign: "center", marginTop: 24 }}>
          No analyses yet. Use <strong>AI Only</strong> or <strong>Save + AI</strong> on Pinterest images.
        </p>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {analyses.map((item) => {
          const isExpanded = expandedId === item.id
          const shortDesc =
            item.description.length > 120
              ? item.description.slice(0, 120) + "…"
              : item.description

          return (
            <div
              key={item.id}
              style={{
                border: "1px solid #e0e0e0",
                borderRadius: 6,
                overflow: "hidden",
                background: "#fff"
              }}>
              {/* Top row: thumbnail + meta */}
              <div style={{ display: "flex", gap: 8, padding: "8px 8px 6px" }}>
                {/* Thumbnail */}
                <img
                  src={item.imageUrl}
                  alt={item.imageAlt || "Pinterest image"}
                  style={{
                    width: 52,
                    height: 52,
                    objectFit: "cover",
                    borderRadius: 4,
                    flexShrink: 0,
                    background: "#f0f0f0"
                  }}
                  onError={(e) => {
                    ;(e.target as HTMLImageElement).style.display = "none"
                  }}
                />

                {/* Meta */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                    {/* Pinterest redirect link */}
                    <a
                      href={item.pageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open on Pinterest"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        color: "#E60023",
                        textDecoration: "none",
                        fontSize: 13,
                        fontWeight: 600,
                        gap: 3,
                        flexShrink: 0
                      }}>
                      📌
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 12 12"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        style={{ opacity: 0.7 }}>
                        <path
                          d="M7 1h4v4M11 1L5 7M9 7v3a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1h3"
                          stroke="#E60023"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </a>
                    <span style={{ fontSize: 10, color: "#aaa", marginLeft: "auto" }}>
                      {formatDate(item.createdAt)}
                    </span>
                  </div>

                  {/* Description */}
                  <p
                    style={{
                      margin: 0,
                      fontSize: 11,
                      color: "#333",
                      lineHeight: 1.4,
                      wordBreak: "break-word"
                    }}>
                    {isExpanded ? item.description : shortDesc}
                    {item.description.length > 120 && (
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : item.id)}
                        style={{
                          background: "none",
                          border: "none",
                          color: "#4285F4",
                          fontSize: 11,
                          cursor: "pointer",
                          padding: "0 2px",
                          marginLeft: 2
                        }}>
                        {isExpanded ? "less" : "more"}
                      </button>
                    )}
                  </p>
                </div>
              </div>

              {/* Keywords row */}
              {item.keywords.length > 0 && (
                <div
                  style={{
                    padding: "0 8px 6px",
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 3
                  }}>
                  {item.keywords.slice(0, 8).map((kw) => (
                    <span
                      key={kw}
                      style={{
                        background: "#f0f0f0",
                        borderRadius: 3,
                        padding: "1px 5px",
                        fontSize: 10,
                        color: "#555"
                      }}>
                      {kw}
                    </span>
                  ))}
                  {item.keywords.length > 8 && (
                    <span style={{ fontSize: 10, color: "#aaa" }}>
                      +{item.keywords.length - 8}
                    </span>
                  )}
                </div>
              )}

              {/* Action bar */}
              <div
                style={{
                  borderTop: "1px solid #f0f0f0",
                  padding: "4px 8px",
                  display: "flex",
                  gap: 6
                }}>
                <button
                  onClick={() => copyText(item.id, item.description)}
                  style={{
                    flex: 1,
                    padding: "4px 8px",
                    fontSize: 11,
                    background: copiedId === item.id ? "#28a745" : "#f5f5f5",
                    color: copiedId === item.id ? "white" : "#333",
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    cursor: "pointer",
                    transition: "background 0.2s"
                  }}>
                  {copiedId === item.id ? "✓ Copied!" : "Copy description"}
                </button>
                <button
                  onClick={() =>
                    copyText(
                      item.id + "_kw",
                      [...item.keywords, ...item.artStyle, ...item.audienceKeywords].join(", ")
                    )
                  }
                  style={{
                    flex: 1,
                    padding: "4px 8px",
                    fontSize: 11,
                    background: copiedId === item.id + "_kw" ? "#28a745" : "#f5f5f5",
                    color: copiedId === item.id + "_kw" ? "white" : "#333",
                    border: "1px solid #ddd",
                    borderRadius: 4,
                    cursor: "pointer",
                    transition: "background 0.2s"
                  }}>
                  {copiedId === item.id + "_kw" ? "✓ Copied!" : "Copy keywords"}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
