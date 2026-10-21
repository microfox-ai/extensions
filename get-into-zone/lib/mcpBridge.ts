// Lets the local MCP server in ../mcp drive the extension, so Claude can use
// it. The worker connects out to ws://127.0.0.1:<port>; the server sends
// { type: "request", id, method, params } and gets back
// { type: "response", id, ok, result | error }.

import { config } from "../config"
import {
  getMidjourneyQueueSize,
  startMidjourneyWorkflow
} from "../workflows/midjourney"
import {
  MCP_ENABLED_KEY,
  MCP_PORT_KEY,
  MCP_STATUS_KEY,
  readMcpPort,
  type McpBridgeState
} from "./mcp"
import { mediamakeFetch, queueSparkboardIndex } from "./mediamake"
import { parseTags, sanitizeFolder, type BulkSession } from "./pinterestBulk"
import {
  listBulkSessions,
  startBulkSession,
  stopBulkSession
} from "./pinterestBulkBackground"
import {
  SAVER_FEATURES,
  isAnySaverActive,
  isPinterestHost,
  isSaverActive,
  loadSaverRules,
  ruleMatches,
  scopeKey,
  setSaverRule,
  storeSaverRules,
  type SaverContext,
  type SaverFeature,
  type SaverScope
} from "./saverRules"
import { buildOptions, parseVideoId, type YtMode, type YtVideo } from "./youtube"
import {
  cancelJob,
  clearFinished,
  getVideo,
  listJobs,
  startDownload
} from "./youtubeBackground"

type MessageHandler = (
  request: any,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: any) => void
) => unknown

const RECONNECT_ALARM = "mcp-bridge-reconnect"
const PING_MS = 20_000
const MAX_RETRY_MS = 30_000

let handleMessage: MessageHandler
let socket: WebSocket | null = null
let pingTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retryMs = 2000

// Runs one of background.ts's message actions as if the popup had sent it.
const dispatch = (request: Record<string, unknown>, timeoutMs = 60_000) =>
  new Promise<any>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${request.action} got no answer.`)),
      timeoutMs
    )
    handleMessage(request, { id: chrome.runtime.id }, (response) => {
      clearTimeout(timer)
      if (response?.success === false) {
        reject(new Error(response.message || response.error || "Failed."))
      } else {
        resolve(response)
      }
    })
  })

const tabSummary = (tab: chrome.tabs.Tab) => ({
  id: tab.id,
  windowId: tab.windowId,
  active: tab.active,
  url: tab.url ?? tab.pendingUrl,
  title: tab.title,
  status: tab.status
})

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tab?.id) throw new Error("No active tab.")
  return tab
}

const getTab = async (tabId?: number) =>
  typeof tabId === "number" ? chrome.tabs.get(tabId) : activeTab()

const waitForTabLoad = (tabId: number, timeoutMs = 30_000) =>
  new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const done = (finish: () => void) => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      finish()
    }
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (id === tabId && info.status === "complete") done(() => resolve(tab))
    }
    const timer = setTimeout(
      () => done(() => reject(new Error("The tab took too long to load."))),
      timeoutMs
    )
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete" && !tab.pendingUrl) done(() => resolve(tab))
      },
      (error) => done(() => reject(error))
    )
  })

async function openTab(url: string, active = true, waitForLoad = true) {
  const tab = await chrome.tabs.create({ url, active })
  return waitForLoad ? waitForTabLoad(tab.id!) : tab
}

async function loadSettings() {
  return chrome.storage.local.get([
    "apiEndpoint",
    "apiKey",
    "tags",
    "selectedProjectId"
  ])
}

const projectFilter = async (projectId?: string, allProjects?: boolean) => {
  if (allProjects) return undefined
  const id = projectId ?? (await loadSettings()).selectedProjectId
  return typeof id === "string" && id && id !== "all" ? id : undefined
}

// --- Pinterest ---

async function pinterestTab(tabId?: number) {
  if (typeof tabId === "number") return tabId
  const isPinterest = (tab: chrome.tabs.Tab) => {
    try {
      return isPinterestHost(new URL(tab.url ?? "").hostname)
    } catch {
      return false
    }
  }
  const active = await activeTab().catch(() => undefined)
  if (active && isPinterest(active)) return active.id!
  const tab = (await chrome.tabs.query({})).find(isPinterest)
  if (!tab?.id) throw new Error("No Pinterest tab is open. Open one first.")
  return tab.id
}

const sessionSummary = ({ seen, pending, pages, ...session }: BulkSession) => ({
  ...session,
  pagesVisited: Object.keys(pages).length,
  queued: pending.length
})

// --- YouTube ---

async function youtubeVideo(params: { tabId?: number; url?: string }) {
  let tabId = params.tabId
  let videoId = parseVideoId(params.url)
  if (typeof tabId === "number") {
    videoId ??= parseVideoId((await chrome.tabs.get(tabId)).url)
  } else {
    videoId ??= parseVideoId((await activeTab().catch(() => undefined))?.url)
    // Any loaded YouTube page can read any video's formats.
    const [tab] = await chrome.tabs.query({
      url: "*://*.youtube.com/*",
      status: "complete",
      discarded: false
    })
    tabId =
      tab?.id ??
      (videoId
        ? (await openTab(`https://www.youtube.com/watch?v=${videoId}`, false)).id
        : undefined)
  }
  if (!videoId || tabId === undefined) {
    throw new Error("Pass a YouTube video URL, or the id of a tab playing one.")
  }
  const result: any = await getVideo(tabId, videoId)
  if (!result.success) throw new Error(result.message)
  return result.video as YtVideo
}

const MODES: YtMode[] = ["both", "video", "audio"]

const optionSummary = (video: YtVideo, mode: YtMode) =>
  buildOptions(video, mode).map(({ streams, ...option }) => ({
    ...option,
    height: streams[0].height
  }))

async function youtubeDownload(params: {
  tabId?: number
  url?: string
  mode?: YtMode
  optionId?: string
  maxHeight?: number
}) {
  const video = await youtubeVideo(params)
  const mode = params.mode && MODES.includes(params.mode) ? params.mode : "both"
  const options = buildOptions(video, mode)
  const option = params.optionId
    ? options.find((o) => o.id === params.optionId)
    : options.find(
        (o) =>
          mode === "audio" ||
          !params.maxHeight ||
          (o.streams[0].height ?? 0) <= params.maxHeight
      )
  if (!option) {
    throw new Error("No matching format. Call youtube_get_video to see the options.")
  }
  const result: any = await startDownload({
    streams: option.streams,
    ext: option.ext,
    title: video.title,
    videoId: video.videoId,
    label: option.label
  })
  if (!result.success) throw new Error(result.message)
  return { jobId: result.jobId, title: video.title, option: option.label }
}

// --- Saver overlays ---

async function saverContext(params: { tabId?: number; url?: string }) {
  if (params.url && typeof params.tabId !== "number") return { url: params.url }
  const tab = await getTab(params.tabId)
  return { url: params.url ?? tab.url, windowId: tab.windowId }
}

async function saverState(ctx: SaverContext) {
  const rules = await loadSaverRules()
  return {
    url: ctx.url,
    anyOverlayShown: isAnySaverActive(rules, ctx),
    enabled: Object.fromEntries(
      SAVER_FEATURES.map((f) => [f, isSaverActive(rules, f, ctx)])
    ),
    rulesForThisPage: rules.filter((r) => ruleMatches(r, ctx)),
    allRules: rules
  }
}

// --- Midjourney ---

async function midjourneyTab() {
  const [tab] = await chrome.tabs.query({ url: `${config.midjourneyUrl}*` })
  if (!tab) throw new Error(`Open ${config.midjourneyUrl} in a tab first.`)
  return tab
}

async function midjourneyQueue(params: {
  limit?: number
  projectId?: string
  allProjects?: boolean
}) {
  const query = new URLSearchParams({ limit: String(params.limit ?? 10) })
  const projectId = await projectFilter(params.projectId, params.allProjects)
  if (projectId) query.set("projectId", projectId)
  const data = await mediamakeFetch(`/api/midjourney-queue/pending?${query}`)
  return (Array.isArray(data) ? data : []).sort(
    (a: any, b: any) =>
      b.priority - a.priority ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  )
}

const commands: Record<string, (params: any) => Promise<unknown>> = {
  "extension.info": async () => ({
    name: chrome.runtime.getManifest().name,
    version: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id
  }),

  "tabs.list": async ({ urlPattern }) =>
    (await chrome.tabs.query(urlPattern ? { url: urlPattern } : {})).map(
      tabSummary
    ),
  "tabs.open": async ({ url, active, waitForLoad }) =>
    tabSummary(await openTab(url, active !== false, waitForLoad !== false)),

  "settings.get": async () => {
    const settings = await loadSettings()
    return {
      apiEndpoint: settings.apiEndpoint ?? "",
      apiKeySet: Boolean(settings.apiKey),
      tags: settings.tags ?? "",
      selectedProjectId: settings.selectedProjectId ?? ""
    }
  },
  "settings.update": async (params) => {
    const keys = ["apiEndpoint", "apiKey", "tags", "selectedProjectId"]
    const update = Object.fromEntries(
      keys
        .filter((key) => typeof params[key] === "string")
        .map((key) => [key, params[key].trim()])
    )
    await chrome.storage.local.set(update)
    return commands["settings.get"]({})
  },
  "projects.list": async () => {
    const data = await mediamakeFetch("/api/project")
    return (Array.isArray(data) ? data : []).map((p: any) => ({
      id: p.id,
      displayName: p.displayName
    }))
  },

  "mediamake.save": async (params) => {
    const result = await queueSparkboardIndex({
      sourceUrl: params.sourceUrl,
      contentType: params.contentType,
      contentMimeType: params.mimeType,
      contentSubType: "general",
      contentSource: "web",
      contentSourceUrl: params.sourceUrl,
      fileName: params.fileName,
      tags: params.tags ?? (await loadSettings()).tags,
      projectId: params.projectId,
      metadata: {
        platform: "web",
        platformId: "web",
        platformUrl: params.pageUrl,
        src: params.sourceUrl,
        alt: params.alt
      },
      analyzeImage: params.analyzeImage,
      generateDescription: params.generateDescription,
      generateKeywords: params.generateKeywords
    })
    if (!result.success) throw new Error(result.message || "Upload failed.")
    return result.data
  },

  "pinterest.bulkStart": async (params) => {
    const tabId = await pinterestTab(params.tabId)
    const folder = sanitizeFolder(
      params.folder || `pinterest-${new Date().toISOString().slice(0, 10)}`
    )
    const tags = Array.isArray(params.tags)
      ? params.tags
      : parseTags(String((await loadSettings()).tags || "pinterest"))
    const result: any = await startBulkSession({
      tabId,
      destination: params.destination,
      folder,
      includeVideos: params.includeVideos,
      videoFolder: params.videoFolder,
      tags,
      perPageLimit: params.perPageLimit
    })
    if (!result.success) throw new Error(result.message)
    return { tabId, folder, message: result.message }
  },
  "pinterest.bulkStop": async ({ tabId }) => {
    const id = await pinterestTab(tabId)
    await stopBulkSession(id)
    return { tabId: id, stopped: true }
  },
  "pinterest.bulkStatus": async ({ tabId }) =>
    (await listBulkSessions())
      .filter((s) => typeof tabId !== "number" || s.tabId === tabId)
      .map(sessionSummary),
  "pinterest.analyzeImage": async (params) =>
    (
      await dispatch(
        {
          action: "analyzePinterestImage",
          imageUrl: params.imageUrl,
          pageUrl: params.pageUrl,
          imageAlt: params.imageAlt,
          prompt: params.prompt,
          tags: params.tags
        },
        180_000
      )
    ).data,
  "pinterest.saveAnalysis": async (params) =>
    (await dispatch({ ...params, action: "savePinterestAnalysis" })).data,
  "pinterest.listAnalyses": async ({ limit, offset }) =>
    (await dispatch({ action: "fetchPinterestAnalyses", limit, offset })).data,

  "youtube.getVideo": async (params) => {
    const video = await youtubeVideo(params)
    const { formats, ...details } = video
    return {
      ...details,
      options: Object.fromEntries(MODES.map((m) => [m, optionSummary(video, m)]))
    }
  },
  "youtube.download": youtubeDownload,
  "youtube.listDownloads": async () =>
    (await listJobs()).map(({ blobUrl, ...job }) => job),
  "youtube.cancelDownload": async ({ jobId }) => cancelJob(String(jobId)),
  "youtube.clearFinished": async () => clearFinished(),

  "saver.get": async (params) => saverState(await saverContext(params)),
  "saver.set": async (params) => {
    const ctx = await saverContext(params)
    const scope = params.scope as SaverScope
    if (scopeKey(scope, ctx) === null) {
      throw new Error(`The "${scope}" scope doesn't apply to this page.`)
    }
    const rules = await loadSaverRules()
    await storeSaverRules(
      setSaverRule(
        rules,
        params.feature as SaverFeature,
        scope,
        ctx,
        Boolean(params.enabled)
      )
    )
    return saverState(ctx)
  },
  "saver.removeRule": async ({ feature, scope, key }) => {
    const rules = await loadSaverRules()
    const next = rules.filter(
      (r) => !(r.feature === feature && r.scope === scope && r.key === key)
    )
    await storeSaverRules(next)
    return { removed: rules.length - next.length }
  },
  "saver.reset": async () => {
    await storeSaverRules([])
    return { reset: true }
  },

  "suno.uploadTrack": async (params) =>
    dispatch({
      action: "uploadSunoTrackToMediamake",
      audioUrl: params.audioUrl,
      title: params.title,
      sunoLyrics: params.lyrics,
      tags: params.tags,
      language: params.language
    }),

  "midjourney.submitPrompts": async (params) => {
    const prompts = Array.isArray(params.prompts) ? params.prompts : []
    if (prompts.length === 0) throw new Error("Pass at least one prompt.")
    if (prompts.length === 1 && typeof prompts[0] === "string") {
      const suffix = String(params.promptSuffix ?? "").trim()
      startMidjourneyWorkflow(
        suffix ? `${prompts[0]} ${suffix}` : prompts[0],
        Boolean(params.useLastImage),
        params.folderTag ?? ""
      )
      return { status: "Midjourney prompt submitted" }
    }
    await activeTab()
    return dispatch({
      action: "startMidjourneyJsonWorkflow",
      prompts,
      delay: params.delayMs ?? 15_000,
      useLastImage: Boolean(params.useLastImage),
      folderTag: params.folderTag ?? "",
      promptSuffix: params.promptSuffix ?? "",
      maxQueueSize: params.maxQueueSize
    })
  },
  "midjourney.scrape": async () => {
    await midjourneyTab()
    return (await dispatch({ action: "scrapeMidjourney" }, 180_000)).data
  },
  "midjourney.queueSize": async () => {
    await midjourneyTab()
    return {
      queued: await new Promise((resolve) => getMidjourneyQueueSize(resolve))
    }
  },
  "midjourney.listQueue": midjourneyQueue,
  "midjourney.runQueue": async (params) => {
    const requests = await midjourneyQueue(params)
    if (requests.length === 0) return { started: 0 }
    await activeTab()
    await dispatch({
      action: "startMidjourneyQueueBatch",
      requests,
      delay: params.delayMs ?? 15_000,
      useLastImage: Boolean(params.useLastImage),
      folderTag: params.folderTag ?? "",
      overwriteQueueFolder: Boolean(params.overwriteQueueFolder),
      maxQueueSize: params.maxQueueSize
    })
    return { started: requests.length, ids: requests.map((r: any) => r.id) }
  },
  "midjourney.loadPrompts": async ({ recordId }) => {
    const id = encodeURIComponent(String(recordId || "random"))
    return mediamakeFetch(`/api/midjourney-prompts/${id}/prompts?includeTag=true`)
  }
}

// --- Connection ---

const setStatus = (state: McpBridgeState, port: number) =>
  chrome.storage.session.set({
    [MCP_STATUS_KEY]: { state, port, at: Date.now() }
  })

async function loadPrefs() {
  const prefs = await chrome.storage.local.get([MCP_ENABLED_KEY, MCP_PORT_KEY])
  return {
    enabled: prefs[MCP_ENABLED_KEY] !== false,
    port: readMcpPort(prefs[MCP_PORT_KEY])
  }
}

const send = (ws: WebSocket, message: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

async function onFrame(ws: WebSocket, raw: unknown) {
  let message: any
  try {
    message = JSON.parse(String(raw))
  } catch {
    return
  }
  if (message?.type !== "request") return
  const command = commands[message.method]
  try {
    if (!command) throw new Error(`Unknown method: ${message.method}`)
    const result = await command(message.params ?? {})
    send(ws, { type: "response", id: message.id, ok: true, result })
  } catch (error) {
    send(ws, {
      type: "response",
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer)
  retryTimer = setTimeout(connect, retryMs)
  retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
}

async function connect() {
  clearTimeout(retryTimer)
  if (socket) return
  const { enabled, port } = await loadPrefs()
  if (!enabled) {
    setStatus("off", port)
    return
  }
  if (socket) return

  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  socket = ws
  setStatus("connecting", port)
  ws.onopen = () => {
    retryMs = 2000
    setStatus("connected", port)
    send(ws, {
      type: "hello",
      role: "extension",
      version: chrome.runtime.getManifest().version,
      extensionId: chrome.runtime.id
    })
    // Traffic every 20s keeps the service worker alive while connected.
    pingTimer = setInterval(() => send(ws, { type: "ping" }), PING_MS)
  }
  ws.onmessage = (event) => onFrame(ws, event.data)
  ws.onclose = () => {
    clearInterval(pingTimer)
    if (socket !== ws) return
    socket = null
    setStatus("disconnected", port)
    scheduleRetry()
  }
}

function disconnect() {
  const ws = socket
  socket = null
  clearInterval(pingTimer)
  clearTimeout(retryTimer)
  ws?.close()
}

export function initMcpBridge(handler: MessageHandler) {
  handleMessage = handler

  // The worker stops when idle; the alarm wakes it to reconnect once the MCP
  // server is running.
  chrome.alarms.get(RECONNECT_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 })
  })
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === RECONNECT_ALARM) connect()
  })

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace !== "local") return
    if (changes[MCP_ENABLED_KEY] || changes[MCP_PORT_KEY]) {
      disconnect()
      retryMs = 2000
      connect()
    }
  })

  connect()
}
