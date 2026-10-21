// Settings for the MCP bridge (see mcpBridge.ts), shared with the popup.

export const MCP_ENABLED_KEY = "mcpBridgeEnabled"
export const MCP_PORT_KEY = "mcpBridgePort"
// In chrome.storage.session, written by the background worker.
export const MCP_STATUS_KEY = "mcpBridgeStatus"
export const MCP_DEFAULT_PORT = 17892

export type McpBridgeState = "off" | "connecting" | "connected" | "disconnected"

export interface McpBridgeStatus {
  state: McpBridgeState
  port: number
  at: number
}

export const readMcpPort = (value: unknown) => {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : MCP_DEFAULT_PORT
}
