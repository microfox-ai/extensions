// MCP entry for DistroKid. The Node server reads the release folder and streams
// the files here in small pieces. This opens one distrokid.com/new/ tab and
// reuses the content-script port the popup already uses. It never clicks Continue.

import { parseDistrokidInfo, type DistrokidRelease } from "./distrokidRelease"
import { openTab } from "./tabs"

type Session = {
  tabId: number
  port: chrome.runtime.Port
  release: DistrokidRelease
}

const sessions = new Map<string, Session>()

async function pingReady(tabId: number): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: "giz-distrokid-ping" })
    return !!response?.ok && !!response?.ready
  } catch {
    return false
  }
}

async function waitUntilReady(tabId: number) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if (await pingReady(tabId)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(
    "DistroKid's upload form is not on this tab. Log in at https://distrokid.com/new/ and try again."
  )
}

function takeSession(sessionId: unknown): Session {
  const session = sessions.get(String(sessionId || ""))
  if (!session) throw new Error("That DistroKid tab is no longer being filled. Start that folder again.")
  return session
}

export const distrokidCommands: Record<string, (params: any) => Promise<unknown>> = {
  "distrokid.open": async ({ infoJson }) => {
    let parsed: ReturnType<typeof parseDistrokidInfo>
    try {
      parsed = parseDistrokidInfo(JSON.parse(String(infoJson ?? "").replace(/^\uFEFF/, "")))
    } catch {
      throw new Error("info.json is not valid JSON.")
    }
    if (parsed.errors.length) throw new Error(parsed.errors.join("\n"))

    const tab = await openTab("https://distrokid.com/new/", false, true)
    if (!tab.id) throw new Error("Chrome did not open a DistroKid tab.")
    try {
      await waitUntilReady(tab.id)
    } catch (error) {
      const message = error instanceof Error ? error.message : "DistroKid did not load."
      throw new Error(`${message} (tab ${tab.id})`)
    }
    const port = chrome.tabs.connect(tab.id, { name: "giz-distrokid" })
    const sessionId = crypto.randomUUID()
    sessions.set(sessionId, { tabId: tab.id, port, release: parsed.release })
    port.onDisconnect.addListener(() => {
      const current = sessions.get(sessionId)
      if (current?.port === port) sessions.delete(sessionId)
    })
    return { sessionId, tabId: tab.id }
  },

  "distrokid.chunk": async ({ sessionId, fileId, name, mime, index, total, base64 }) => {
    const session = takeSession(sessionId)
    const id = String(fileId)
    if (index === 0 || total === 0) {
      session.port.postMessage({
        type: "file-start",
        id,
        name: String(name || "file"),
        mime: String(mime || ""),
        total: Number(total) || 0
      })
    }
    if (Number(total) > 0 && base64) {
      session.port.postMessage({
        type: "chunk",
        id,
        index: Number(index) || 0,
        // Ports serialize to JSON, so the chunk stays base64 text.
        base64: String(base64)
      })
    }
    return { ok: true }
  },

  "distrokid.commit": async ({ sessionId, trackIds, coverId }) => {
    const session = takeSession(sessionId)
    const result = await new Promise<any>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(
        () => finish(() => reject(new Error("DistroKid took too long to fill the form."))),
        120_000
      )
      const finish = (done: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        session.port.onMessage.removeListener(onMessage)
        done()
      }
      const onMessage = (msg: any) => {
        if (msg?.type === "result" && msg.result) {
          finish(() => resolve(msg.result))
        }
      }
      session.port.onMessage.addListener(onMessage)
      session.port.onDisconnect.addListener(() => {
        finish(() => reject(new Error("Lost the DistroKid tab before the form was filled.")))
      })
      session.port.postMessage({
        type: "fill",
        release: session.release,
        trackIds: Array.isArray(trackIds) ? trackIds : [],
        coverId: String(coverId || "cover")
      })
    })
    sessions.delete(sessionId)
    return { tabId: session.tabId, ...result }
  },

  "distrokid.abort": async ({ sessionId }) => {
    const id = String(sessionId || "")
    const session = sessions.get(id)
    if (!session) return { aborted: false }
    sessions.delete(id)
    session.port.disconnect()
    return { aborted: true, tabId: session.tabId }
  }
}
