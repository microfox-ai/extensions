// Repaint uses the same Editor job as outcrop (a PNG with transparency where
// Midjourney should paint). The holes are whatever the user brushes in
// tabs/midjourney-edit.tsx. This file only opens that tab and submits once
// they click Repaint.

import {
  prepareEditorImage,
  splitPrompt,
  submitEditorEdit,
  waitForJob,
  type JobResult,
  type MjMode,
  type MjSource
} from "./midjourneyApi"

const SESSIONS_KEY = "mjEditSessions"
const DB_NAME = "get-into-zone-mj-edit"
const DB_STORE = "images"
const PAINT_WAIT_MS = 600_000
const JOB_WAIT_MS = 240_000

type EditStatus = "awaiting_paint" | "submitting" | "submitted" | "cancelled" | "failed"

type EditSession = {
  id: string
  tabId?: number
  prompt: string
  extraFlags?: string
  mode?: MjMode
  private?: boolean
  width: number
  height: number
  ar: string
  createdAt: number
  status: EditStatus
  error?: string
  job?: JobResult
}

const memory = new Map<string, EditSession>()
let persistChain = Promise.resolve()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) {
        req.result.createObjectStore(DB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withDb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(DB_STORE, mode)
      const req = run(tx.objectStore(DB_STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    database.close()
  }
}

const putBlob = (id: string, blob: Blob) => withDb("readwrite", (store) => store.put(blob, id))
const getBlob = (id: string) => withDb<Blob | undefined>("readonly", (store) => store.get(id))
const deleteBlob = (id: string) => withDb("readwrite", (store) => store.delete(id)).catch(() => undefined)

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function base64ToBlob(base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  return new Blob([bytes], { type: "image/png" })
}

async function readSessions(): Promise<Record<string, EditSession>> {
  const stored = await chrome.storage.session.get(SESSIONS_KEY)
  return (stored[SESSIONS_KEY] as Record<string, EditSession> | undefined) ?? {}
}

function persist(session: EditSession) {
  memory.set(session.id, session)
  persistChain = persistChain.then(async () => {
    const sessions = await readSessions()
    sessions[session.id] = session
    await chrome.storage.session.set({ [SESSIONS_KEY]: sessions })
  })
  return persistChain
}

async function load(id: string) {
  const cached = memory.get(id)
  if (cached) return cached
  const session = (await readSessions())[id]
  if (session) memory.set(id, session)
  return session
}

async function countTransparent(blob: Blob) {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext("2d")
    if (!ctx) throw new Error("Couldn't read the brushed image.")
    ctx.drawImage(bitmap, 0, 0)
    const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
    let transparent = 0
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 16) transparent++
    }
    return { width: bitmap.width, height: bitmap.height, transparent }
  } finally {
    bitmap.close()
  }
}

const retryable = (message: string) =>
  message.startsWith("A text prompt") || message.startsWith("Brush the parts")

export async function startRepaint(params: {
  source: MjSource
  prompt: string
  mode?: MjMode
  private?: boolean
  extraFlags?: string
}) {
  const { text, flags } = splitPrompt(params.prompt, params.extraFlags)
  const fitted = await prepareEditorImage(params.source)
  const id = crypto.randomUUID()
  await putBlob(id, fitted.png)
  const session: EditSession = {
    id,
    prompt: text,
    extraFlags: flags,
    mode: params.mode,
    private: params.private,
    width: fitted.width,
    height: fitted.height,
    ar: fitted.ar,
    createdAt: Date.now(),
    status: "awaiting_paint"
  }
  await persist(session)

  const url = chrome.runtime.getURL(`tabs/midjourney-edit.html?session=${id}`)
  let tab: chrome.tabs.Tab
  try {
    tab = await chrome.tabs.create({ url, active: true })
  } catch (error) {
    session.status = "failed"
    session.error = error instanceof Error ? error.message : String(error)
    await persist(session)
    await deleteBlob(id)
    throw error
  }
  session.tabId = tab.id
  await persist(session)
  if (tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined)
  }
  return {
    status: "awaiting_paint" as const,
    sessionId: id,
    tabId: tab.id,
    width: fitted.width,
    height: fitted.height,
    note:
      "A Chrome tab is open on the image. Tell the user to brush the parts that should change, check the prompt, and click Repaint. " +
      "You cannot paint the mask. After you tell them, call midjourney_repaint_status with this sessionId."
  }
}

export async function repaintStatus(params: {
  sessionId: string
  wait?: boolean
  paintTimeoutMs?: number
  timeoutMs?: number
}) {
  const id = String(params.sessionId || "")
  let session = await load(id)
  if (!session) throw new Error("No repaint with that id. Start again with midjourney_repaint.")

  const paintMs = params.paintTimeoutMs ?? PAINT_WAIT_MS
  const deadline = Date.now() + (params.wait === false ? 0 : paintMs)
  while (session.status === "awaiting_paint" || session.status === "submitting") {
    if (Date.now() >= deadline) {
      return {
        status: session.status,
        sessionId: session.id,
        tabId: session.tabId,
        width: session.width,
        height: session.height,
        note:
          session.status === "submitting"
            ? "The edit is being sent to Midjourney. Call midjourney_repaint_status again."
            : "The user hasn't clicked Repaint yet. The tab is still open. Ask them to brush the parts to change and click Repaint, then call midjourney_repaint_status again."
      }
    }
    // Touch a Chrome API each pass so the service worker is not stopped while
    // the user is still brushing. Memory wins over storage: a submit in this
    // worker updates memory before the write lands.
    await sleep(1000)
    const stored = (await readSessions())[id]
    session = memory.get(id) ?? stored
    if (!session) throw new Error("That repaint is gone. Start again with midjourney_repaint.")
    if (session.status === "awaiting_paint" && session.tabId) {
      const tab = await chrome.tabs.get(session.tabId).catch(() => undefined)
      if (!tab) {
        session.status = "cancelled"
        session.error = "The edit tab was closed before Repaint was clicked."
        await persist(session)
        await deleteBlob(session.id)
      }
    }
  }

  if (session.status === "cancelled") {
    return {
      status: "cancelled" as const,
      sessionId: session.id,
      error: session.error || "The edit tab was closed before Repaint was clicked."
    }
  }
  if (session.status === "failed") throw new Error(session.error || "Midjourney didn't start the edit.")

  const job = session.job
  if (!job) throw new Error("The edit finished without a job id.")
  if (
    params.wait === false ||
    (job.status === "completed" && job.imageUrls.length > 0) ||
    job.status === "error" ||
    job.status === "cancelled" ||
    job.status === "canceled"
  ) {
    return { ...job, sessionId: session.id }
  }

  const waited = await waitForJob(job.jobId, 4, params.timeoutMs ?? JOB_WAIT_MS)
  const result = { ...job, ...waited, sessionId: session.id }
  session.job = result
  await persist(session)
  return result
}

async function onGet(sessionId: string) {
  const session = await load(sessionId)
  if (!session || session.status === "cancelled") {
    throw new Error("This edit is no longer open. Start it again from the chat.")
  }
  const blob = await getBlob(sessionId)
  if (!blob) throw new Error("This edit's image is gone. Start it again from the chat.")
  return {
    ok: true as const,
    imageBase64: await blobToBase64(blob),
    prompt: session.prompt,
    width: session.width,
    height: session.height
  }
}

async function onSubmit(sessionId: string, pngBase64: string, prompt: string) {
  const session = await load(sessionId)
  if (!session) throw new Error("This edit is no longer open. Start it again from the chat.")
  if (session.status === "submitted" && session.job) {
    return { ok: true as const, jobId: session.job.jobId }
  }
  if (session.status === "submitting") throw new Error("This edit is already being sent.")

  const png = base64ToBlob(pngBase64)
  const painted = await countTransparent(png)
  if (painted.width !== session.width || painted.height !== session.height) {
    throw new Error("The brushed image doesn't match the editor frame. Reload the edit tab and try again.")
  }
  if (painted.transparent < 12) {
    throw new Error("Brush the parts to change before clicking Repaint.")
  }

  session.status = "submitting"
  session.prompt = prompt
  await persist(session)
  try {
    const job = await submitEditorEdit(png, session.ar, prompt, {
      mode: session.mode,
      private: session.private,
      extraFlags: session.extraFlags,
      wait: false
    })
    session.status = "submitted"
    session.job = job
    await persist(session)
    await deleteBlob(session.id)
    return { ok: true as const, jobId: job.jobId }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    session.status = retryable(message) ? "awaiting_paint" : "failed"
    session.error = message
    await persist(session)
    return { ok: false as const, error: message, retryable: retryable(message) }
  }
}

async function onCancel(sessionId: string) {
  const session = await load(sessionId)
  if (!session || session.status === "submitted" || session.status === "submitting") return { ok: true as const }
  session.status = "cancelled"
  session.error = "Cancelled from the edit tab."
  await persist(session)
  await deleteBlob(session.id)
  return { ok: true as const }
}

function fromEditorPage(sender: chrome.runtime.MessageSender) {
  return sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""))
}

const closedEarly = "The edit tab was closed before Repaint was clicked."

export function initMidjourneyEdit() {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      const live = [...memory.values()].find((session) => session.tabId === tabId)
      if (live) {
        if (live.status !== "awaiting_paint") return
        live.status = "cancelled"
        live.error = closedEarly
        await persist(live)
        await deleteBlob(live.id)
        return
      }
      const stored = Object.values(await readSessions()).find((session) => session.tabId === tabId)
      if (!stored || stored.status !== "awaiting_paint") return
      stored.status = "cancelled"
      stored.error = closedEarly
      await persist(stored)
      await deleteBlob(stored.id)
    })()
  })

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message?.action
    if (typeof action !== "string" || !action.startsWith("midjourneyEdit.")) return
    if (!fromEditorPage(sender)) return
    const sessionId = String(message.sessionId || "")
    const run = async () => {
      if (action === "midjourneyEdit.get") return onGet(sessionId)
      if (action === "midjourneyEdit.submit") {
        return onSubmit(sessionId, String(message.pngBase64 || ""), String(message.prompt || ""))
      }
      if (action === "midjourneyEdit.cancel") return onCancel(sessionId)
      throw new Error(`Unknown edit action: ${action}`)
    }
    run().then(sendResponse, (error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: retryable(error instanceof Error ? error.message : String(error))
      })
    )
    return true
  })
}
