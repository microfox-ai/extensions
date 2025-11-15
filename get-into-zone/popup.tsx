import { useState, useEffect } from "react"
import "./style.css"

const exampleJson = {
  prompts: [
    {
      captionIndex: 0,
      captionText: "The taste of iron's in my mouth,",
      prompt:
        "Muhammad Ali, mid-fight, grimacing, blood slightly visible on his lip, sweat dripping, close-up shot of his exhausted yet determined face, boxing ring ropes blurred in the background, dramatic cinematic lighting, photographic black and white, high contrast photojournalism, gritty and raw, a moment of profound struggle."
    },
    {
      captionIndex: 1,
      captionText: "the roar is turning low.",
      prompt:
        "Muhammad Ali, dazed and momentarily unfocused, looking slightly disoriented in the boxing ring, the crowd in the background blurred and indistinct, a sense of fading awareness, cinematic wide shot, photographic black and white, subtle light, high contrast, capturing a moment of vulnerability before resolve."
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
  const [apiEndpoint, setApiEndpoint] = useState("")
  const [tags, setTags] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [isButtonEnabled, setIsButtonEnabled] = useState(true)
  const [useLastImage, setUseLastImage] = useState(false)

  useEffect(() => {
    chrome.storage.local.get(
      ["apiEndpoint", "tags", "apiKey", "isButtonEnabled", "useLastImage"],
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

  const saveSettings = () => {
    chrome.storage.local.set(
      { apiEndpoint, tags, apiKey, isButtonEnabled },
      () => {
        console.log("Settings saved")
        // Optionally, provide user feedback that settings have been saved
      }
    )
  }

  const startMidjourneyWorkflow = () => {
    chrome.storage.local.set({ useLastImage }, () => {
      chrome.runtime.sendMessage({
        action: "startWorkflow",
        prompt: prompt,
        useLastImage: useLastImage
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
            useLastImage: useLastImage
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
      <div style={{ display: "flex", marginBottom: 16 }}>
        <button
          onClick={() => setActiveTab("midjourney")}
          style={{
            padding: "8px 16px",
            border: "none",
            backgroundColor: activeTab === "midjourney" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "midjourney" ? "white" : "black",
            cursor: "pointer",
            flex: 1
          }}>
          Midjourney
        </button>
        <button
          onClick={() => setActiveTab("suno")}
          style={{
            padding: "8px 16px",
            border: "none",
            backgroundColor: activeTab === "suno" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "suno" ? "white" : "black",
            cursor: "pointer",
            flex: 1
          }}>
          Suno Extractor
        </button>
        <button
          onClick={() => setActiveTab("settings")}
          style={{
            padding: "8px 16px",
            border: "none",
            backgroundColor: activeTab === "settings" ? "#4285F4" : "#E0E0E0",
            color: activeTab === "settings" ? "white" : "black",
            cursor: "pointer",
            flex: 1
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
                <label>Delay (ms):</label>
                <input
                  type="number"
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                  style={{ marginLeft: 10, padding: "4px" }}
                />
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
