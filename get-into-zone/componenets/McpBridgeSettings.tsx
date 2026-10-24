import { useEffect, useState } from "react"

import {
  MCP_DEFAULT_PORT,
  MCP_ENABLED_KEY,
  MCP_PORT_KEY,
  MCP_PROFILE_NAME_KEY,
  MCP_STATUS_KEY,
  readMcpPort,
  type McpBridgeStatus
} from "../lib/mcp"

const STATE_TEXT: Record<McpBridgeStatus["state"], [string, string]> = {
  off: ["Off", "#6b7280"],
  connecting: ["Looking for the MCP server…", "#b45309"],
  connected: ["Connected to Claude", "#15803d"],
  disconnected: ["MCP server not running", "#6b7280"]
}

// Settings for the bridge that lets Claude drive the extension (see ../mcp).
export function McpBridgeSettings() {
  const [enabled, setEnabled] = useState(true)
  const [port, setPort] = useState(String(MCP_DEFAULT_PORT))
  const [profileName, setProfileName] = useState("")
  const [status, setStatus] = useState<McpBridgeStatus | null>(null)

  useEffect(() => {
    chrome.storage.local.get(
      [MCP_ENABLED_KEY, MCP_PORT_KEY, MCP_PROFILE_NAME_KEY],
      (result) => {
        setEnabled(result[MCP_ENABLED_KEY] !== false)
        setPort(String(readMcpPort(result[MCP_PORT_KEY])))
        setProfileName(String(result[MCP_PROFILE_NAME_KEY] ?? ""))
      }
    )
    chrome.storage.session.get(MCP_STATUS_KEY, (result) =>
      setStatus(result[MCP_STATUS_KEY] ?? null)
    )
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      namespace: string
    ) => {
      if (namespace === "session" && changes[MCP_STATUS_KEY]) {
        setStatus(changes[MCP_STATUS_KEY].newValue ?? null)
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  const savePort = () => {
    const next = readMcpPort(port)
    setPort(String(next))
    chrome.storage.local.set({ [MCP_PORT_KEY]: next })
  }

  const [text, color] = STATE_TEXT[enabled ? status?.state ?? "connecting" : "off"]

  return (
    <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid #e5e7eb" }}>
      <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked)
            chrome.storage.local.set({ [MCP_ENABLED_KEY]: e.target.checked })
          }}
        />
        Let Claude use this extension (MCP)
      </label>
      <div style={{ marginTop: 6, fontSize: "12px", color }}>{text}</div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <label style={{ fontSize: "12px" }}>Port:</label>
        <input
          type="number"
          value={port}
          disabled={!enabled}
          onChange={(e) => setPort(e.target.value)}
          onBlur={savePort}
          style={{ width: 90, padding: "4px" }}
        />
      </div>
      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>
        <label style={{ fontSize: "12px" }}>Profile name:</label>
        <input
          type="text"
          value={profileName}
          disabled={!enabled}
          placeholder="e.g. Work"
          onChange={(e) => setProfileName(e.target.value)}
          onBlur={() =>
            chrome.storage.local.set({
              [MCP_PROFILE_NAME_KEY]: profileName.trim()
            })
          }
          style={{ flex: 1, padding: "4px" }}
        />
      </div>
      <div style={{ marginTop: 4, fontSize: "11px", color: "#6b7280" }}>
        When the extension is connected in more than one Chrome profile, Claude
        asks which to use by this name (or the profile's Google account).
      </div>
    </div>
  )
}
