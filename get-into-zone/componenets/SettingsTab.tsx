import { useEffect, useState } from "react"

import { McpBridgeSettings } from "./McpBridgeSettings"

const DEFAULT_API_ENDPOINT =
  process.env.NODE_ENV === "production"
    ? "https://mediamake.microfox.app"
    : "http://localhost:3000"

export function SettingsTab() {
  const [apiEndpoint, setApiEndpoint] = useState(DEFAULT_API_ENDPOINT)
  const [tags, setTags] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [projects, setProjects] = useState<{ id: string; displayName: string }[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string>("default")

  useEffect(() => {
    chrome.storage.local.get(
      ["apiEndpoint", "tags", "apiKey", "selectedProjectId"],
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
        if (typeof result.selectedProjectId === "string") {
          setSelectedProjectId(result.selectedProjectId)
        }
      }
    )
  }, [])

  useEffect(() => {
    if (!apiEndpoint || typeof apiEndpoint !== "string") return

    setProjectsLoading(true)
    const headers: HeadersInit = {}
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`
    }

    fetch(`${apiEndpoint}/api/project`, { headers })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setProjects(
            data.map((p: any) => ({
              id: p.id,
              displayName: p.displayName
            }))
          )
        } else {
          setProjects([])
        }
      })
      .catch((err) => {
        console.error("Failed to load projects:", err)
        setProjects([])
      })
      .finally(() => {
        setProjectsLoading(false)
      })
  }, [apiEndpoint, apiKey])

  const saveSettings = () => {
    chrome.storage.local.set(
      {
        apiEndpoint,
        tags,
        apiKey,
        selectedProjectId
      },
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
          placeholder={DEFAULT_API_ENDPOINT}
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
      <div style={{ marginTop: 10 }}>
        <label>Default Project:</label>
        <select
          value={selectedProjectId}
          onChange={(e) => {
            const value = e.target.value
            setSelectedProjectId(value)
            chrome.storage.local.set({ selectedProjectId: value })
          }}
          disabled={projectsLoading}
          style={{
            width: "100%",
            padding: "8px",
            boxSizing: "border-box",
            marginTop: "4px"
          }}>
          {projectsLoading ? (
            <option>Loading projects...</option>
          ) : projects.length === 0 ? (
            <option value="default">No projects found</option>
          ) : (
            projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))
          )}
        </select>
      </div>
      <McpBridgeSettings />
      <p style={{ marginTop: 16, fontSize: "12px", color: "#666" }}>
        Turn the on-page Save and AI overlays on or off from the Saver tab.
      </p>
    </div>
  )
}
