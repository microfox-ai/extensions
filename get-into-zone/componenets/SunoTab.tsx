import { useEffect, useState } from "react"

export function SunoTab() {
  const [sunoData, setSunoData] = useState("")
  const [isLoadingSuno, setIsLoadingSuno] = useState(false)

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


