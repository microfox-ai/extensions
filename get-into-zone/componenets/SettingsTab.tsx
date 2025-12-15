import { useEffect, useState } from "react"

export function SettingsTab() {
  const [apiEndpoint, setApiEndpoint] = useState("")
  const [tags, setTags] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [isButtonEnabled, setIsButtonEnabled] = useState(true)

  useEffect(() => {
    chrome.storage.local.get(
      ["apiEndpoint", "tags", "apiKey", "isButtonEnabled"],
      (result) => {
        if (typeof result.apiEndpoint === "string") {
          setApiEndpoint(result.apiEndpoint)
        }
        if (typeof result.tags === "string") {
          setTags(result.tags)
        }
        if (typeof result.apiKey === "string") {
          setApiKey(result.apiKey)
        }
        if (typeof result.isButtonEnabled === "boolean") {
          setIsButtonEnabled(result.isButtonEnabled)
        }
      }
    )
  }, [])

  const saveSettings = () => {
    chrome.storage.local.set(
      { apiEndpoint, tags, apiKey, isButtonEnabled },
      () => {
        console.log("Settings saved")
      }
    )
  }

  return (
    <div>
      <h2>Settings</h2>
      <div>
        <label>API Endpoint:</label>
        <input
          type="text"
          value={apiEndpoint}
          onChange={(e) => setApiEndpoint(e.target.value)}
          placeholder="https://your-api.com/endpoint"
          style={{
            width: "100%",
            padding: "8px",
            boxSizing: "border-box",
            marginTop: "4px"
          }}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <label>Tags (comma-separated):</label>
        <input
          type="text"
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="e.g., art, design, inspiration"
          style={{
            width: "100%",
            padding: "8px",
            boxSizing: "border-box",
            marginTop: "4px"
          }}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <label>API Key:</label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter your API key"
          style={{
            width: "100%",
            padding: "8px",
            boxSizing: "border-box",
            marginTop: "4px"
          }}
        />
      </div>
      <button
        onClick={saveSettings}
        style={{ marginTop: "10px", width: "100%", padding: "10px" }}>
        Save Settings
      </button>
      <div style={{ marginTop: 10, display: "flex", alignItems: "center" }}>
        <input
          type="checkbox"
          id="enableButton"
          checked={isButtonEnabled}
          onChange={(e) => setIsButtonEnabled(e.target.checked)}
          style={{ marginRight: "8px" }}
        />
        <label htmlFor="enableButton">Enable "Save" button on images/videos</label>
      </div>
    </div>
  )
}


