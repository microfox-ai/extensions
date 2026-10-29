import { useEffect, useState } from "react"

import { authorizedFetch } from "../lib/mediamakeAuth"

export function AgentsTab() {
  const [agents, setAgents] = useState<any[]>([])
  const [selectedAgent, setSelectedAgent] = useState<any | null>(null)
  const [agentInput, setAgentInput] = useState("")
  const [agentInputMode, setAgentInputMode] = useState<"simple" | "json">(
    "simple"
  )
  const [agentResult, setAgentResult] = useState("")
  const [isLoadingAgents, setIsLoadingAgents] = useState(false)
  const [isExecutingAgent, setIsExecutingAgent] = useState(false)
  const [agentApiUrl, setAgentApiUrl] = useState("http://localhost:3000")
  const [jsonError, setJsonError] = useState("")

  useEffect(() => {
    chrome.storage.local.get(["apiEndpoint"], (result) => {
      if (typeof result.apiEndpoint === "string") {
        setAgentApiUrl(result.apiEndpoint)
      }
    })
  }, [])

  useEffect(() => {
    if (agentApiUrl) {
      loadAgents()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentApiUrl])

  const loadAgents = async () => {
    setIsLoadingAgents(true)
    try {
      const headers: HeadersInit = {
        "Content-Type": "application/json"
      }
      const response = await authorizedFetch(`${agentApiUrl}/api/agents`, {
        headers
      })
      const data = await response.json()
      if (data.success) {
        setAgents(data.agents)
        if (data.agents.length > 0) {
          setSelectedAgent(data.agents[0])
        }
      } else {
        alert("Failed to load agents. Check API URL and key.")
      }
    } catch (error) {
      console.error("Error loading agents:", error)
      alert(
        `Failed to load agents. Make sure the API server is running at ${agentApiUrl}`
      )
    } finally {
      setIsLoadingAgents(false)
    }
  }

  const executeAgent = async () => {
    if (!selectedAgent || !agentInput) {
      alert("Please select an agent and enter input")
      return
    }

    setIsExecutingAgent(true)
    setAgentResult("Processing...")

    try {
      const headers: HeadersInit = {
        "Content-Type": "application/json"
      }

      let requestBody: any
      if (agentInputMode === "json") {
        try {
          requestBody = JSON.parse(agentInput)
          setJsonError("")
        } catch (e) {
          setJsonError("Invalid JSON format")
          setAgentResult("Error: Invalid JSON format")
          setIsExecutingAgent(false)
          return
        }
      } else {
        requestBody = {
          messages: [
            {
              role: "user",
              content: agentInput
            }
          ]
        }
      }

      const response = await authorizedFetch(
        `${agentApiUrl}/api/studio/chat/agent${selectedAgent.path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(requestBody)
        }
      )

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()
      let outputText = ""

      if (Array.isArray(data) && data.length > 0) {
        const lastMessage = data[data.length - 1]
        const parts = Array.isArray(lastMessage?.parts) ? lastMessage.parts : []
        const toolParts = parts.filter(
          (p: any) => typeof p.type === "string" && p.type.startsWith("tool-")
        )
        const lastToolPart =
          toolParts.length > 0 ? toolParts[toolParts.length - 1] : null

        if (lastToolPart && lastToolPart.output !== undefined) {
          outputText =
            typeof lastToolPart.output === "string"
              ? lastToolPart.output
              : JSON.stringify(lastToolPart.output, null, 2)
        }
      }

      if (!outputText) {
        outputText = JSON.stringify(data, null, 2)
      }

      setAgentResult(outputText)
    } catch (error: any) {
      console.error("Error executing agent:", error)
      setAgentResult(`Error: ${error?.message || String(error)}`)
    } finally {
      setIsExecutingAgent(false)
    }
  }

  return (
    <div>
      <h2>🤖 AI Agents</h2>

      {isLoadingAgents ? (
        <p>Loading agents...</p>
      ) : agents.length === 0 ? (
        <p style={{ color: "#666", fontSize: "14px" }}>
          No agents available. Check your API server.
        </p>
      ) : (
        <>
          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: "12px", fontWeight: "bold" }}>
              Select Agent:
            </label>
            <select
              value={selectedAgent?.path || ""}
              onChange={(e) => {
                const agent = agents.find((a) => a.path === e.target.value)
                setSelectedAgent(agent || null)
              }}
              style={{
                width: "100%",
                padding: "8px",
                marginTop: "4px",
                border: "1px solid #ccc",
                borderRadius: "4px"
              }}>
              {agents.map((agent) => (
                <option key={agent.path} value={agent.path}>
                  {agent.metadata?.icon || "🤖"} {agent.name}
                </option>
              ))}
            </select>
          </div>

          {selectedAgent && (
            <div
              style={{
                padding: "8px",
                background: "#f5f5f5",
                borderRadius: "4px",
                marginBottom: 12,
                fontSize: "12px"
              }}>
              <strong>Description:</strong> {selectedAgent.description}
            </div>
          )}

          <div style={{ marginBottom: 12, display: "flex", gap: 8 }}>
            <button
              onClick={() => {
                setAgentInputMode("simple")
                setJsonError("")
              }}
              style={{
                flex: 1,
                padding: "6px 12px",
                fontSize: "12px",
                background: agentInputMode === "simple" ? "#4285F4" : "#E0E0E0",
                color: agentInputMode === "simple" ? "white" : "black",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer"
              }}>
              Simple Text
            </button>
            <button
              onClick={() => {
                setAgentInputMode("json")
                if (agentInputMode === "simple" && agentInput) {
                  setAgentInput(
                    JSON.stringify(
                      {
                        messages: [
                          {
                            role: "user",
                            content: agentInput
                          }
                        ]
                      },
                      null,
                      2
                    )
                  )
                }
              }}
              style={{
                flex: 1,
                padding: "6px 12px",
                fontSize: "12px",
                background: agentInputMode === "json" ? "#4285F4" : "#E0E0E0",
                color: agentInputMode === "json" ? "white" : "black",
                border: "none",
                borderRadius: "4px",
                cursor: "pointer"
              }}>
              JSON Input
            </button>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: "12px", fontWeight: "bold" }}>
              {agentInputMode === "simple" ? "Input:" : "JSON Input:"}
            </label>
            <textarea
              value={agentInput}
              onChange={(e) => {
                setAgentInput(e.target.value)
                if (agentInputMode === "json") {
                  try {
                    JSON.parse(e.target.value)
                    setJsonError("")
                  } catch {
                    setJsonError("Invalid JSON")
                  }
                }
              }}
              placeholder={
                agentInputMode === "simple"
                  ? "Enter your prompt or query..."
                  : '{\n  "messages": [\n    {\n      "role": "user",\n      "content": "Your text here"\n    }\n  ],\n  "param1": "value1"\n}'
              }
              rows={agentInputMode === "json" ? 10 : 5}
              style={{
                width: "100%",
                padding: "8px",
                marginTop: "4px",
                boxSizing: "border-box",
                border: jsonError ? "1px solid #dc3545" : "1px solid #ccc",
                borderRadius: "4px",
                fontFamily:
                  agentInputMode === "json" ? "monospace" : "inherit",
                fontSize: agentInputMode === "json" ? "11px" : "14px"
              }}
            />
            {jsonError && agentInputMode === "json" && (
              <div
                style={{
                  color: "#dc3545",
                  fontSize: "11px",
                  marginTop: "4px"
                }}>
                ⚠️ {jsonError}
              </div>
            )}
            {agentInputMode === "json" && !jsonError && agentInput && (
              <div
                style={{
                  color: "#28a745",
                  fontSize: "11px",
                  marginTop: "4px"
                }}>
                ✓ Valid JSON
              </div>
            )}
          </div>

          <button
            onClick={executeAgent}
            disabled={isExecutingAgent}
            style={{
              width: "100%",
              padding: "10px",
              background: isExecutingAgent ? "#ccc" : "#4285F4",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: isExecutingAgent ? "not-allowed" : "pointer",
              fontWeight: "bold"
            }}>
            {isExecutingAgent ? "Processing..." : "Execute Agent"}
          </button>

          {agentResult && (
            <div style={{ marginTop: 16 }}>
              <label style={{ fontSize: "12px", fontWeight: "bold" }}>
                Result:
              </label>
              <textarea
                value={agentResult}
                readOnly
                rows={10}
                style={{
                  width: "100%",
                  padding: "8px",
                  marginTop: "4px",
                  boxSizing: "border-box",
                  background: "#f9f9f9",
                  border: "1px solid #ccc",
                  borderRadius: "4px",
                  fontSize: "12px",
                  fontFamily: "monospace"
                }}
              />
              <button
                onClick={() => {
                  navigator.clipboard.writeText(agentResult)
                  alert("Copied to clipboard!")
                }}
                style={{
                  marginTop: "8px",
                  padding: "6px 12px",
                  fontSize: "12px",
                  background: "#28a745",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer"
                }}>
                Copy Result
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}


