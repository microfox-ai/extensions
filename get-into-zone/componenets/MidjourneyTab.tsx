import { useEffect, useState } from "react"

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

type MidjourneySubTab = "plain" | "json" | "database" | "scrape"

export function MidjourneyTab() {
    const [midjourneyTab, setMidjourneyTab] = useState<MidjourneySubTab>("plain")

    const [prompt, setPrompt] = useState("")
    const [jsonContent, setJsonContent] = useState<string>(
        JSON.stringify(exampleJson, null, 2)
    )
    const [delay, setDelay] = useState(15000)
    const [folderTag, setFolderTag] = useState("animezone")
    const [maxQueueSize, setMaxQueueSize] = useState(8)
    const [promptSuffix, setPromptSuffix] = useState("")
    const [dbRecordId, setDbRecordId] = useState("random")
    const [useLastImage, setUseLastImage] = useState(false)
    const [isLoadingMidjourney, setIsLoadingMidjourney] = useState(false)
    const [scrapedData, setScrapedData] = useState("")
    const [agentApiUrl, setAgentApiUrl] = useState("http://localhost:3000")
    const [isLoadingDb, setIsLoadingDb] = useState(false)
    const [apiKey, setApiKey] = useState("")

    useEffect(() => {
        chrome.storage.local.get(
            [
                "prompt",
                "jsonContent",
                "delay",
                "folderTag",
                "promptSuffix",
                "dbRecordId",
                "useLastImage",
                "maxQueueSize",
                "agentApiUrl",
                "apiKey"
            ],
            (result) => {
                if (typeof result.prompt === "string") {
                    setPrompt(result.prompt)
                }
                if (typeof result.jsonContent === "string") {
                    setJsonContent(result.jsonContent)
                }
                if (typeof result.delay === "number") {
                    setDelay(result.delay)
                }
                if (typeof result.folderTag === "string") {
                    setFolderTag(result.folderTag)
                }
                if (typeof result.promptSuffix === "string") {
                    setPromptSuffix(result.promptSuffix)
                }
                if (typeof result.dbRecordId === "string") {
                    setDbRecordId(result.dbRecordId)
                }
                if (typeof result.useLastImage === "boolean") {
                    setUseLastImage(result.useLastImage)
                }
                if (typeof result.maxQueueSize === "number") {
                    setMaxQueueSize(result.maxQueueSize)
                }
                if (typeof result.agentApiUrl === "string") {
                    setAgentApiUrl(result.agentApiUrl)
                }
                if (typeof result.apiKey === "string") {
                    setApiKey(result.apiKey)
                }
            }
        )
    }, [])

    const startMidjourneyWorkflow = () => {
        const finalPrompt =
            promptSuffix && prompt.trim().length > 0
                ? `${prompt.trim()} ${promptSuffix}`
                : prompt

        chrome.storage.local.set({ useLastImage }, () => {
            chrome.runtime.sendMessage({
                action: "startWorkflow",
                prompt: finalPrompt,
                useLastImage,
                folderTag
            })
        })
    }

    const startMidjourneyJsonWorkflow = () => {
        try {
            const parsedJson = JSON.parse(jsonContent)
            let prompts: any[] = []

            if (Array.isArray(parsedJson)) {
                prompts = parsedJson
            } else if (parsedJson && Array.isArray(parsedJson.prompts)) {
                prompts = parsedJson.prompts
            }

            if (prompts.length > 0) {
                chrome.storage.local.set({ useLastImage }, () => {
                    chrome.runtime.sendMessage({
                        action: "startMidjourneyJsonWorkflow",
                        prompts,
                        delay,
                        useLastImage,
                        folderTag,
                        promptSuffix,
                        maxQueueSize
                    })
                })
            }
        } catch (error) {
            console.error("Invalid JSON format:", error)
        }
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

    const loadFromDatabase = async () => {
        setIsLoadingDb(true)
        try {
            const id = (dbRecordId || "random").trim() || "random"
            const url = `${agentApiUrl}/api/midjourney-prompts/${encodeURIComponent(
                id
            )}/prompts?includeTag=true`
            const headers: HeadersInit = {}
            if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`
            }
            const res = await fetch(url, { headers })
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`)
            }

            const data = await res.json()
            if (!data || !Array.isArray(data.prompts)) {
                alert("No prompts found in response")
                return
            }

            const recordId = data.recordId || id
            const promptsForWorkflow = data.prompts.map((p: any) => ({
                ...p,
                recordId,
                dbRecordId: recordId,
                pIndex: p.pIndex
            }))

            const newJson = JSON.stringify({ prompts: promptsForWorkflow }, null, 2)
            setJsonContent(newJson)
            chrome.storage.local.set({ jsonContent: newJson })

            if (
                !folderTag &&
                data.prompts.length > 0 &&
                typeof data.prompts[0].tag === "string"
            ) {
                setFolderTag(data.prompts[0].tag)
                chrome.storage.local.set({ folderTag: data.prompts[0].tag })
            }

            setMidjourneyTab("json")
        } catch (e: any) {
            console.error("Failed to load prompts from database:", e)
            alert(
                `Failed to load prompts from database: ${e?.message || String(e)}`
            )
        } finally {
            setIsLoadingDb(false)
        }
    }

    const appendFromDatabase = async () => {
        setIsLoadingDb(true)
        try {
            const id = (dbRecordId || "random").trim() || "random"
            const url = `${agentApiUrl}/api/midjourney-prompts/${encodeURIComponent(
                id
            )}/prompts?includeTag=true`
            const headers: HeadersInit = {}
            if (apiKey) {
                headers["Authorization"] = `Bearer ${apiKey}`
            }
            const res = await fetch(url, { headers })
            if (!res.ok) {
                throw new Error(`HTTP ${res.status}: ${res.statusText}`)
            }
            const data = await res.json()
            if (!data || !Array.isArray(data.prompts)) {
                alert("No prompts found in response")
                return
            }

            const recordId = data.recordId || id
            const promptsForWorkflow = data.prompts.map((p: any) => ({
                ...p,
                recordId,
                dbRecordId: recordId,
                pIndex: p.pIndex
            }))

            let existingPrompts: any[] = []
            try {
                const parsed = JSON.parse(jsonContent)
                if (Array.isArray(parsed)) {
                    existingPrompts = parsed
                } else if (parsed && Array.isArray(parsed.prompts)) {
                    existingPrompts = parsed.prompts
                }
            } catch {
                existingPrompts = []
            }

            const merged = [...existingPrompts, ...promptsForWorkflow]
            const newJson = JSON.stringify({ prompts: merged }, null, 2)
            setJsonContent(newJson)
            chrome.storage.local.set({ jsonContent: newJson })

            if (
                !folderTag &&
                data.prompts.length > 0 &&
                typeof data.prompts[0].tag === "string"
            ) {
                setFolderTag(data.prompts[0].tag)
                chrome.storage.local.set({ folderTag: data.prompts[0].tag })
            }

            setMidjourneyTab("json")
        } catch (e: any) {
            console.error("Failed to append prompts from database:", e)
            alert(
                `Failed to append prompts from database: ${e?.message || String(e)}`
            )
        } finally {
            setIsLoadingDb(false)
        }
    }

    return (
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
                    onClick={() => setMidjourneyTab("database")}
                    style={{
                        padding: "8px 16px",
                        border: "none",
                        backgroundColor:
                            midjourneyTab === "database" ? "#6DB6FF" : "#E0E0E0",
                        color: midjourneyTab === "database" ? "white" : "black",
                        cursor: "pointer",
                        flex: 1
                    }}>
                    Database
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
                        onChange={(e) => {
                            setPrompt(e.target.value)
                            chrome.storage.local.set({ prompt: e.target.value })
                        }}
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
                            onChange={(e) => {
                                setFolderTag(e.target.value)
                                chrome.storage.local.set({ folderTag: e.target.value })
                            }}
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
                        <label>Suffix (appended to each prompt):</label>
                        <input
                            type="text"
                            value={promptSuffix}
                            onChange={(e) => {
                                setPromptSuffix(e.target.value)
                                chrome.storage.local.set({ promptSuffix: e.target.value })
                            }}
                            placeholder="e.g., --ar 16:9 --v 6.0"
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
                        <label htmlFor="useLastImage">Use last generated image</label>
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
                        onChange={(e) => {
                            setJsonContent(e.target.value)
                            chrome.storage.local.set({ jsonContent: e.target.value })
                        }}
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
                            onChange={(e) => {
                                setFolderTag(e.target.value)
                                chrome.storage.local.set({ folderTag: e.target.value })
                            }}
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
                        <label>Suffix (appended to each prompt):</label>
                        <input
                            type="text"
                            value={promptSuffix}
                            onChange={(e) => {
                                setPromptSuffix(e.target.value)
                                chrome.storage.local.set({ promptSuffix: e.target.value })
                            }}
                            placeholder="e.g., --ar 16:9 --v 6.0"
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
                            onChange={(e) => {
                                const v = Number(e.target.value)
                                setDelay(v)
                                chrome.storage.local.set({ delay: v })
                            }}
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
                            When Midjourney shows this many or more queued jobs, the next
                            prompt waits for the delay instead of running.
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
                        <label htmlFor="useLastImageJson">Use last generated image</label>
                    </div>
                    <button
                        onClick={startMidjourneyJsonWorkflow}
                        style={{ marginTop: "10px", width: "100%", padding: "10px" }}>
                        Start Workflow
                    </button>
                </div>
            )}

            {midjourneyTab === "database" && (
                <div>
                    <div style={{ marginBottom: 10 }}>
                        <label>Record ID (or "random"):</label>
                        <input
                            type="text"
                            value={dbRecordId}
                            onChange={(e) => {
                                setDbRecordId(e.target.value)
                                chrome.storage.local.set({ dbRecordId: e.target.value })
                            }}
                            placeholder="random or Mongo ObjectId"
                            style={{
                                width: "100%",
                                padding: "8px",
                                boxSizing: "border-box",
                                marginTop: "4px"
                            }}
                        />
                    </div>
                    <button
                        onClick={loadFromDatabase}
                        disabled={isLoadingDb}
                        style={{ marginTop: "10px", width: "100%", padding: "10px" }}>
                        {isLoadingDb ? "Loading..." : "Load Prompts into JSON Tab"}
                    </button>
                    <button
                        onClick={appendFromDatabase}
                        disabled={isLoadingDb}
                        style={{ marginTop: "10px", width: "100%", padding: "10px" }}>
                        {isLoadingDb ? "Adding..." : "Add Prompts to JSON Tab"}
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
    )
}


