import { useEffect, useState } from "react"

import { authorizedFetch, signOut } from "../lib/mediamakeAuth"
import { McpBridgeSettings } from "./McpBridgeSettings"
import { useAuthState } from "./SignInScreen"

export function SettingsTab() {
  const auth = useAuthState()
  const apiEndpoint = auth?.endpoint
  const [tags, setTags] = useState("")
  const [projects, setProjects] = useState<{ id: string; displayName: string }[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState<string>("default")

  useEffect(() => {
    chrome.storage.local.get(["tags", "selectedProjectId"], (result) => {
      if (typeof result.tags === "string") {
        setTags(result.tags)
      }
      if (typeof result.selectedProjectId === "string") {
        setSelectedProjectId(result.selectedProjectId)
      }
    })
  }, [])

  useEffect(() => {
    if (!apiEndpoint) return

    setProjectsLoading(true)
    authorizedFetch(`${apiEndpoint}/api/project`)
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
  }, [apiEndpoint])

  const saveSettings = () => {
    chrome.storage.local.set({ tags, selectedProjectId }, () => {
      console.log("Settings saved")
    })
  }

  return (
    <div>
      <h2>Settings</h2>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: 10,
          background: "#f3f4f6",
          borderRadius: 6,
          fontSize: 12
        }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div>
            Signed in to Mediamake{auth?.account ? <> as <b>{auth.account}</b></> : null}
            {auth?.via === "api-key" ? " with an API key" : ""}
          </div>
          <div style={{ color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis" }}>
            {apiEndpoint}
          </div>
        </div>
        <button onClick={() => signOut()} style={{ padding: "6px 10px" }}>
          Sign out
        </button>
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
