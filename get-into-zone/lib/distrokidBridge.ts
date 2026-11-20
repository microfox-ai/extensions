// MCP entry for DistroKid. The Node server reads the release folder and streams
// the files here in small pieces. This opens one distrokid.com/new/ tab and
// reuses the content-script port the popup already uses. It never clicks Continue
// on the release form.

import type { DistrokidAlbum } from "./distrokidPage"
import { parseDistrokidInfo, type DistrokidRelease } from "./distrokidRelease"
import {
  albumUuidOf,
  appleGenre,
  detailsJob,
  distrokidSongDetails,
  linkedRecords,
  listDistrokidReleases,
  listUploads,
  readRelease,
  recordUpload,
  syncLinks
} from "./distrokidSongs"
import { readDistrokidReleases } from "./distrokidPage"
import { openTab } from "./tabs"

type Session = {
  tabId: number
  port: chrome.runtime.Port
  release: DistrokidRelease
  lyrics: string
  /** The release folder on disk, recorded with the release once DistroKid shows its Done page. */
  folder: string
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
  "distrokid.open": async ({ infoJson, lyrics, folder }) => {
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
    sessions.set(sessionId, {
      tabId: tab.id,
      port,
      release: parsed.release,
      lyrics: typeof lyrics === "string" ? lyrics : "",
      folder: typeof folder === "string" ? folder : ""
    })
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
        lyrics: session.lyrics,
        folder: session.folder,
        trackIds: Array.isArray(trackIds) ? trackIds : [],
        coverId: String(coverId || "cover")
      })
    })
    sessions.delete(sessionId)
    return { tabId: session.tabId, ...result }
  },

  "distrokid.details": async (params) =>
    distrokidSongDetails({
      album: params?.album ? String(params.album) : undefined,
      artist: params?.artist ? String(params.artist) : undefined,
      all: params?.all === true,
      lyrics: params?.lyrics !== false,
      credits: params?.credits !== false,
      genre: params?.genre !== false,
      audio: params?.audio !== false,
      save: params?.save !== false
    }),

  "distrokid.releases": async ({ artist }) => ({
    releases: await listDistrokidReleases(artist ? String(artist) : undefined)
  }),

  /** One release's DistroKid-only details (no lyrics or credits), for the pack record. */
  "distrokid.release": async ({ album, genre }) => {
    const uuid = albumUuidOf(String(album || ""))
    if (!uuid) throw new Error("Pass a DistroKid release link or its albumuuid.")
    const found = await readRelease(uuid, { lyrics: false, credits: false })
    return { ...found, primaryGenre: genre ? await appleGenre(found.storeLinks) : "" }
  },

  "distrokid.uploads": async () => ({ uploads: await listUploads() }),

  "distrokid.syncLinks": async ({ album, dryRun }) => {
    const uuid = albumUuidOf(String(album || ""))
    if (!uuid) throw new Error("Pass a DistroKid release link or its albumuuid.")
    const records = await linkedRecords(uuid)
    if (!records.length) return { synced: false, records, message: "No MediaMake Library record is linked to this release." }
    if (dryRun) return { synced: false, records }
    const found = await readRelease(uuid, { lyrics: false, credits: false })
    return { synced: true, results: await syncLinks(found) }
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

// --- Messages from the popup's DistroKid tab and DistroKid's own pages ------------------------

export function handleDistrokidUi(
  request: any,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
) {
  const reply = (work: Promise<unknown>) => {
    work.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) })
    )
    return true
  }
  switch (request.op) {
    case "details":
      // Runs on after the popup closes; the popup follows it through the job in storage.
      distrokidSongDetails({
        album: request.album,
        artist: request.artist,
        all: request.all === true
      }).catch(() => {})
      return reply(Promise.resolve({ started: true }))
    case "job":
      return reply(detailsJob())
    case "artists":
      return reply(
        (async () => {
          const tabId = Number(request.tabId)
          const [injection] = await chrome.scripting.executeScript({
            target: { tabId },
            func: readDistrokidReleases
          })
          return injection?.result ?? []
        })()
      )
    case "linked":
      return reply(linkedRecords(String(request.albumUuid || "")))
    case "sync":
      return reply(syncLinks(request.album as DistrokidAlbum))
    case "uploaded":
      return reply(
        recordUpload({
          folder: String(request.folder || ""),
          title: String(request.title || ""),
          artist: String(request.artist || ""),
          albumUuid: String(request.albumUuid || "")
        })
      )
  }
  sendResponse({ ok: false, error: `Unknown request: ${request.op}` })
  return false
}
