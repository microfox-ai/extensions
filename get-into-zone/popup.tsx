import { useState, useEffect } from "react"
import "./style.css"

const exampleJson = {
  prompts: [
    {
      captionIndex: 0,
      captionText: "The taste of iron's in my mouth,",
      prompt: "perfect cell digital art full body shot",
      tag: "animezone"
    },
    {
      captionIndex: 1,
      captionText: "the roar is turning low.",
      prompt: "epic anime background, detailed environment, studio quality",
      tag: "animezone"
    }
  ]
}

function IndexPopup() {
  const [activeTab, setActiveTab] = useState("midjourney")
  const [midjourneyTab, setMidjourneyTab] = useState("plain")
  const [prompt, setPrompt] = useState("")
  const [sunoData, setSunoData] = useState("")
  const [isLoadingSuno, setIsLoadingSuno] = useState(false)
  const [isLoadingMidjourney, setIsLoadingMidjourney] = useState(false)
  const [scrapedData, setScrapedData] = useState("")
  const [jsonContent, setJsonContent] = useState<string>(
    JSON.stringify(exampleJson, null, 2)
  )
  const [delay, setDelay] = useState(15000)
  const [folderTag, setFolderTag] = useState("animezone")
  const [maxQueueSize, setMaxQueueSize] = useState(8)
  const [apiEndpoint, setApiEndpoint] = useState("")
  const [tags, setTags] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [isButtonEnabled, setIsButtonEnabled] = useState(true)
  const [useLastImage, setUseLastImage] = useState(false)

  // AI Agents tab state
  const [agents, setAgents] = useState([])
  const [selectedAgent, setSelectedAgent] = useState(null)
  const [agentInput, setAgentInput] = useState("")
  const [agentInputMode, setAgentInputMode] = useState<"simple" | "json">("simple")
  const [agentResult, setAgentResult] = useState("")
  const [isLoadingAgents, setIsLoadingAgents] = useState(false)
  const [isExecutingAgent, setIsExecutingAgent] = useState(false)
  const [agentApiUrl, setAgentApiUrl] = useState("http://localhost:3000")
  const [jsonError, setJsonError] = useState("")

  useEffect(() => {
    chrome.storage.local.get(
      [
        "apiEndpoint",
        "tags",
        "apiKey",
        "isButtonEnabled",
        "useLastImage",
        "agentApiUrl",
        "maxQueueSize"
      ],
      (result) => {
        if (result.apiEndpoint) {
          setApiEndpoint(result.apiEndpoint)
        }
        if (result.tags) {
          setTags(result.tags)
        }
        if (result.apiKey) {
          setApiKey(result.apiKey)
        }
        if (result.isButtonEnabled !== undefined) {
          setIsButtonEnabled(result.isButtonEnabled)
        }
        if (result.useLastImage !== undefined) {
          setUseLastImage(result.useLastImage)
        }
        if (result.agentApiUrl) {
          setAgentApiUrl(result.agentApiUrl)
        }
        if (typeof result.maxQueueSize === "number") {
          setMaxQueueSize(result.maxQueueSize)
        }
      }
    )

    const messageListener = (request) => {
      if (request.action === "sunoDataExtracted") {
        setSunoData(JSON.stringify(request.data, null, 2))
        setIsLoadingSuno(false)
      } else if (
        request.action === "scrapeMidjourney" &&
        request.status === "completed"
      ) {
        setScrapedData(JSON.stringify(request.data, null, 2))
        setIsLoadingMidjourney(false)
      }
    }
    chrome.runtime.onMessage.addListener(messageListener)

    return () => {
      chrome.runtime.onMessage.removeListener(messageListener)
    }
  }, [])

  useEffect(() => {
    if (activeTab === "agents" && agentApiUrl) {
      loadAgents()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  const loadAgents = async () => {
    setIsLoadingAgents(true)
    try {
      const headers: HeadersInit = {
        "Content-Type": "application/json"
      }

      // Add API key if available
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`
      }

      const response = await fetch(`${agentApiUrl}/api/agents`, {
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
      alert(`Failed to load agents. Make sure the API server is running at ${agentApiUrl}`)
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

      // Add API key if available
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`
      }

      let requestBody: any

      if (agentInputMode === "json") {
        // Parse JSON input
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
        // Simple text mode - wrap in messages array
        requestBody = {
          messages: [
            {
              role: "user",
              content: agentInput
            }
          ]
        }
      }

      const response = await fetch(
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

      // Handle streaming response
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let result = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        result += decoder.decode(value, { stream: true })
        setAgentResult(result)
      }
    } catch (error) {
      console.error("Error executing agent:", error)
      setAgentResult(`Error: ${error.message}`)
    } finally {
      setIsExecutingAgent(false)
    }
  }

  const saveAgentApiUrl = () => {
    chrome.storage.local.set({ agentApiUrl }, () => {
      alert("API URL saved!")
    })
  }

  const saveSettings = () => {
    chrome.storage.local.set(
      { apiEndpoint, tags, apiKey, isButtonEnabled, maxQueueSize },
      () => {
        console.log("Settings saved")
      }
    )
  }

  const startMidjourneyWorkflow = () => {
    chrome.storage.local.set({ useLastImage }, () => {
      chrome.runtime.sendMessage({
        action: "startWorkflow",
        prompt: prompt,
        useLastImage: useLastImage,
        folderTag: folderTag
      })
    })
  }

  const startMidjourneyJsonWorkflow = () => {
    try {
      const parsedJson = JSON.parse(jsonContent)
      let prompts = []

      if (Array.isArray(parsedJson)) {
        prompts = parsedJson
      } else if (parsedJson && Array.isArray(parsedJson.prompts)) {
        prompts = parsedJson.prompts
      }

      if (prompts.length > 0) {
        chrome.storage.local.set({ useLastImage }, () => {
          chrome.runtime.sendMessage({
            action: "startMidjourneyJsonWorkflow",
            prompts: prompts,
            delay: delay,
            useLastImage: useLastImage,
            folderTag: folderTag,
            maxQueueSize: maxQueueSize
          })
        })
      }
    } catch (error) {
      console.error("Invalid JSON format:", error)
      // Optionally, provide user feedback about the invalid JSON
    }
  }

  const startSunoWorkflow = () => {
    setIsLoadingSuno(true)
    setSunoData("")
    chrome.runtime.sendMessage({ action: "startSunoWorkflow" })
  }

  const startMidjourneyScrape = () => {
    setIsLoadingMidjourney(true)
    setScrapedData("")
    chrome.runtime.sendMessage(
      { action: "scrapeMidjourney" },
      (response) => {
        if (response && response.status === "completed") {
          setScrapedData(JSON.stringify(response.data, null, 2))
        } else {
          setScrapedData("Failed to scrape data.")
        }
        setIsLoadingMidjourney(false)
      }
    )
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        padding: 16,
        width: 400
      }}>
      <div style={{ display: "flex", marginBottom: 16, flexWrap: "wrap", gap: 4 }}>
        <button
          onClick={() => setActiveTab("midjourney")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "midjourney" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "midjourney" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          Midjourney
        </button>
        <button
          onClick={() => setActiveTab("suno")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "suno" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "suno" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          Suno
        </button>
        <button
          onClick={() => setActiveTab("agents")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "agents" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "agents" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          AI Agents
        </button>
        <button
          onClick={() => setActiveTab("settings")}
          style={{
            padding: "8px 12px",
            border: "none",
            backgroundColor: activeTab === "settings" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "settings" ? "white" : "black",
            cursor: "pointer",
            flex: 1,
            minWidth: "80px",
            fontSize: "12px"
          }}>
          Settings
        </button>
      </div>

      {activeTab === "midjourney" && (
        <div>
          <h2>Midjourney Automation</h2>
          <div style={{ display: "flex", marginBottom: 16 }}>
            <button
              onClick={() => setMidjourneyTab("plain")}
              style={{
                padding: "8px 16px",
                border: "none",
                backgroundColor:
                  midjourneyTab === "plain" ? "#6DB6FF" : "#E0E0E0",
                color: midjourneyTab === "plain" ? "white" : "black",
                cursor: "pointer",
                flex: 1
              }}>
              Plain Text
            </button>
            <button
              onClick={() => setMidjourneyTab("json")}
              style={{
                padding: "8px 16px",
                border: "none",
                backgroundColor:
                  midjourneyTab === "json" ? "#6DB6FF" : "#E0E0E0",
                color: midjourneyTab === "json" ? "white" : "black",
                cursor: "pointer",
                flex: 1
              }}>
              JSON
            </button>
            <button
              onClick={() => setMidjourneyTab("scrape")}
              style={{
                padding: "8px 16px",
                border: "none",
                backgroundColor:
                  midjourneyTab === "scrape" ? "#6DB6FF" : "#E0E0E0",
                color: midjourneyTab === "scrape" ? "white" : "black",
                cursor: "pointer",
                flex: 1
              }}>
              Scrape
            </button>
          </div>
          {midjourneyTab === "plain" && (
            <div>
              <p>Enter your prompt below:</p>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter your prompt here..."
                rows={5}
                style={{
                  width: "100%",
                  padding: "8px",
                  boxSizing: "border-box"
                }}
              />
              <div style={{ marginTop: 10 }}>
                <label>Folder tag (optional):</label>
                <input
                  type="text"
                  value={folderTag}
                  onChange={(e) => setFolderTag(e.target.value)}
                  placeholder="e.g., kidtales"
                  style={{
                    width: "100%",
                    padding: "8px",
                    boxSizing: "border-box",
                    marginTop: "4px"
                  }}
                />
              </div>
              <div style={{ marginTop: 10, display: "flex", alignItems: "center" }}>
                <input
                  type="checkbox"
                  id="useLastImage"
                  checked={useLastImage}
                  onChange={(e) => setUseLastImage(e.target.checked)}
                  style={{ marginRight: "8px" }}
                />
                <label htmlFor="useLastImage">
                  Use last generated image
                </label>
              </div>
              <button
                onClick={startMidjourneyWorkflow}
                style={{ marginTop: "10px", width: "100%", padding: "10px" }}>
                Start Workflow
              </button>
            </div>
          )}
          {midjourneyTab === "json" && (
            <div>
              <textarea
                value={jsonContent}
                onChange={(e) => setJsonContent(e.target.value)}
                rows={15}
                style={{
                  width: "100%",
                  padding: "8px",
                  boxSizing: "border-box"
                }}
              />
              <div style={{ marginTop: 10 }}>
                <label>Folder tag (optional):</label>
                <input
                  type="text"
                  value={folderTag}
                  onChange={(e) => setFolderTag(e.target.value)}
                  placeholder="e.g., kidtales"
                  style={{
                    width: "100%",
                    padding: "8px",
                    boxSizing: "border-box",
                    marginTop: "4px"
                  }}
                />
              </div>
              <div style={{ marginTop: 10 }}>
                <label>Delay (ms):</label>
                <input
                  type="number"
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                  style={{ marginLeft: 10, padding: "4px" }}
                />
              </div>
              <div style={{ marginTop: 10 }}>
                <label>Max queued jobs before pausing:</label>
                <input
                  type="number"
                  value={maxQueueSize}
                  onChange={(e) =>
                    setMaxQueueSize(Math.max(1, Number(e.target.value) || 1))
                  }
                  style={{ marginLeft: 10, padding: "4px", width: "60px" }}
                />
                <span style={{ marginLeft: 6, fontSize: "11px", color: "#666" }}>
                  When Midjourney shows this many or more queued jobs, the next prompt
                  waits for the delay instead of running.
                </span>
              </div>
              <div style={{ marginTop: 10, display: "flex", alignItems: "center" }}>
                <input
                  type="checkbox"
                  id="useLastImageJson"
                  checked={useLastImage}
                  onChange={(e) => setUseLastImage(e.target.checked)}
                  style={{ marginRight: "8px" }}
                />
                <label htmlFor="useLastImageJson">
                  Use last generated image
                </label>
              </div>
              <button
                onClick={startMidjourneyJsonWorkflow}
                style={{ marginTop: "10px", width: "100%", padding: "10px" }}>
                Start Workflow
              </button>
            </div>
          )}
          {midjourneyTab === "scrape" && (
            <div>
              <button
                onClick={startMidjourneyScrape}
                disabled={isLoadingMidjourney}
                style={{ marginTop: "10px", width: "100%", padding: "10px" }}>
                {isLoadingMidjourney ? "Scraping..." : "Scrape Midjourney"}
              </button>
              {scrapedData && (
                <div style={{ marginTop: 16 }}>
                  <h3>Scraped Data:</h3>
                  <textarea
                    value={scrapedData}
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
          )}
        </div>
      )}

      {activeTab === "suno" && (
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
      )}
      {activeTab === "agents" && (
        <div>
          <h2>🤖 AI Agents</h2>

          {/* API URL Configuration */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: "12px", color: "#666" }}>API Server URL:</label>
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <input
                type="text"
                value={agentApiUrl}
                onChange={(e) => setAgentApiUrl(e.target.value)}
                placeholder="http://localhost:3000"
                style={{
                  flex: 1,
                  padding: "6px 8px",
                  fontSize: "12px",
                  border: "1px solid #ccc",
                  borderRadius: "4px"
                }}
              />
              <button
                onClick={saveAgentApiUrl}
                style={{
                  padding: "6px 12px",
                  fontSize: "12px",
                  background: "#28a745",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer"
                }}>
                Save
              </button>
              <button
                onClick={loadAgents}
                style={{
                  padding: "6px 12px",
                  fontSize: "12px",
                  background: "#007bff",
                  color: "white",
                  border: "none",
                  borderRadius: "4px",
                  cursor: "pointer"
                }}>
                Refresh
              </button>
            </div>
          </div>

          {/* Agent Selector */}
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
                    setSelectedAgent(agent)
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

              {/* Agent Description */}
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

              {/* Input Mode Toggle */}
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
                      // Convert simple text to JSON template
                      setAgentInput(JSON.stringify({
                        messages: [
                          {
                            role: "user",
                            content: agentInput
                          }
                        ]
                      }, null, 2))
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
                {agentInputMode === "json" && (
                  <button
                    onClick={() => {
                      setAgentInput(JSON.stringify({
                        messages: [
                          {
                            role: "user",
                            content: "Your prompt here"
                          }
                        ],
                        param1: "value1",
                        param2: "value2"
                      }, null, 2))
                      setJsonError("")
                    }}
                    style={{
                      padding: "6px 12px",
                      fontSize: "12px",
                      background: "#28a745",
                      color: "white",
                      border: "none",
                      borderRadius: "4px",
                      cursor: "pointer",
                      whiteSpace: "nowrap"
                    }}>
                    📋 Example
                  </button>
                )}
              </div>

              {/* Input Area */}
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
                      } catch (err) {
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
                    fontFamily: agentInputMode === "json" ? "monospace" : "inherit",
                    fontSize: agentInputMode === "json" ? "11px" : "14px"
                  }}
                />
                {jsonError && agentInputMode === "json" && (
                  <div style={{ color: "#dc3545", fontSize: "11px", marginTop: "4px" }}>
                    ⚠️ {jsonError}
                  </div>
                )}
                {agentInputMode === "json" && !jsonError && agentInput && (
                  <div style={{ color: "#28a745", fontSize: "11px", marginTop: "4px" }}>
                    ✓ Valid JSON
                  </div>
                )}
              </div>

              {/* Execute Button */}
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

              {/* Result Area */}
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
      )}
      {activeTab === "settings" && (
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
            <label htmlFor="enableButton">
              Enable "Save" button on images/videos
            </label>
          </div>
        </div>
      )}
    </div>
  )
}

export default IndexPopup
