import { useEffect, useState } from "react"

export function SunoTab() {
  const [sunoData, setSunoData] = useState("")
  const [isLoadingSuno, setIsLoadingSuno] = useState(false)
  const [tag, setTag] = useState("")
  const [language, setLanguage] = useState("en")
  const [isUploading, setIsUploading] = useState(false)
  const [statusMessage, setStatusMessage] = useState("")

  useEffect(() => {
    const listener = (request: any) => {
      if (request.action === "sunoDataExtracted") {
        setSunoData(JSON.stringify(request.data, null, 2))
        setIsLoadingSuno(false)
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => {
      chrome.runtime.onMessage.removeListener(listener)
    }
  }, [])

  const startSunoWorkflow = () => {
    setIsLoadingSuno(true)
    setSunoData("")
    chrome.runtime.sendMessage({ action: "startSunoWorkflow" })
  }

  return (
    <div>
      <h2>Suno Music Extractor</h2>
      <button
        onClick={startSunoWorkflow}
        disabled={isLoadingSuno}
        style={{ width: "100%", padding: "10px" }}>
        {isLoadingSuno ? "Extracting..." : "Start Extraction"}
      </button>
      <div style={{ marginTop: 16 }}>
        <h3>Upload current remix to Mediamake</h3>
        <div style={{ marginTop: 8 }}>
          <label>Tag:</label>
          <input
            type="text"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="e.g., suno-remix"
            style={{
              width: "100%",
              padding: "8px",
              boxSizing: "border-box",
              marginTop: "4px"
            }}
          />
        </div>
        <div style={{ marginTop: 8 }}>
          <label>Language:</label>
          <input
            type="text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="en"
            style={{
              width: "100%",
              padding: "8px",
              boxSizing: "border-box",
              marginTop: "4px"
            }}
          />
        </div>
        <button
          onClick={() => {
            setIsUploading(true)
            setStatusMessage("Uploading to Mediamake...")
            chrome.runtime.sendMessage(
              {
                action: "uploadSunoTrackToMediamake",
                tag: tag.trim() || undefined,
                language: language.trim() || "en"
              },
              (response) => {
                setIsUploading(false)
                if (!response || !response.success) {
                  setStatusMessage(
                    response?.message || "Failed to upload to Mediamake."
                  )
                  return
                }
                setStatusMessage("Uploaded to Mediamake successfully.")
              }
            )
          }}
          disabled={isUploading}
          style={{ width: "100%", padding: "10px", marginTop: "10px" }}>
          {isUploading ? "Uploading..." : "Upload to Mediamake"}
        </button>
        {statusMessage && (
          <p style={{ marginTop: 8, fontSize: 12 }}>{statusMessage}</p>
        )}
      </div>
      {sunoData && (
        <div style={{ marginTop: 16 }}>
          <h3>Extracted Data:</h3>
          <textarea
            value={sunoData}
            readOnly
            rows={15}
            style={{
              width: "100%",
              padding: "8px",
              boxSizing: "border-box",
              backgroundColor: "#f5f5f5"
            }}
          />
        </div>
      )}
    </div>
  )
}


