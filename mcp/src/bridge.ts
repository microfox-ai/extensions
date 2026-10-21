// The link between this MCP server and the Get into zone extension.
//
// The extension's service worker connects to ws://127.0.0.1:<port>. Claude
// Desktop and Claude Code each start their own copy of this server, so the
// first copy listens on the port (the hub) and later copies connect to it as
// peers; the hub forwards their requests to the extension. When the hub exits,
// a peer takes over the port.

import { WebSocket, WebSocketServer } from "ws"

// The extension retries every 30s at most, so a new hub may wait that long.
const EXTENSION_WAIT_MS = 35_000

interface ExtensionInfo {
  version?: string
  extensionId?: string
  connectedAt: string
}

interface Pending {
  ws: WebSocket
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const send = (ws: WebSocket, message: unknown) => {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
}

const parse = (raw: unknown) => {
  try {
    return JSON.parse(String(raw))
  } catch {
    return null
  }
}

export class Bridge {
  private mode: "hub" | "peer" | null = null
  private starting?: Promise<void>
  private hub?: WebSocket
  private extensions: { ws: WebSocket; info: ExtensionInfo }[] = []
  private waiters = new Set<() => void>()
  private pending = new Map<number, Pending>()
  private nextId = 1

  constructor(
    private port: number,
    private extensionId?: string
  ) {}

  /** Calls a method on the extension (see get-into-zone/lib/mcpBridge.ts). */
  async call(method: string, params: unknown = {}, timeoutMs = 60_000) {
    await this.ensure()
    if (this.mode === "hub") return this.callExtension(method, params, timeoutMs)
    return this.request(this.hub!, method, { params, timeoutMs }, timeoutMs + EXTENSION_WAIT_MS + 5000)
  }

  ensure(): Promise<void> {
    if (this.mode) return Promise.resolve()
    this.starting ??= this.becomeHub()
      .catch((error) => {
        if (error?.code !== "EADDRINUSE") throw error
        return this.becomePeer()
      })
      .finally(() => {
        this.starting = undefined
      })
    return this.starting
  }

  private becomeHub() {
    return new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        host: "127.0.0.1",
        port: this.port,
        // Web pages can open sockets to localhost too, but they always send
        // their own Origin. Only the extension and local processes get in.
        verifyClient: ({ origin }: { origin?: string }) =>
          !origin ||
          (this.extensionId
            ? origin === `chrome-extension://${this.extensionId}`
            : origin.startsWith("chrome-extension://"))
      })
      server.once("error", reject)
      server.once("listening", () => {
        server.off("error", reject)
        server.on("error", (error) => console.error("[bridge]", error))
        server.on("connection", (ws) => this.onConnection(ws))
        this.mode = "hub"
        console.error(`[bridge] listening on 127.0.0.1:${this.port}`)
        resolve()
      })
    })
  }

  private becomePeer() {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`)
      ws.once("error", (error) =>
        reject(new Error(`Port ${this.port} is in use by something else: ${error.message}`))
      )
      ws.once("open", () => {
        send(ws, { type: "hello", role: "peer" })
        this.hub = ws
        this.mode = "peer"
        console.error(`[bridge] using the bridge another Claude app started on port ${this.port}`)
        resolve()
      })
      ws.on("message", (raw) => this.onResponse(parse(raw)))
      ws.on("close", () => {
        if (this.hub !== ws) return
        this.hub = undefined
        this.mode = null
        this.rejectPending(ws, "Lost the connection to the bridge; try again.")
        // The hub may have exited; take over the port so the extension can reconnect.
        setTimeout(() => this.ensure().catch(() => {}), 500 + Math.random() * 500)
      })
    })
  }

  private onConnection(ws: WebSocket) {
    let role: "extension" | "peer" | null = null
    ws.on("message", (raw) => {
      const message = parse(raw)
      if (!message) return
      if (message.type === "ping") return send(ws, { type: "pong" })
      if (message.type === "hello" && !role) {
        role = message.role === "extension" ? "extension" : "peer"
        if (role === "extension") {
          this.extensions.push({
            ws,
            info: {
              version: message.version,
              extensionId: message.extensionId,
              connectedAt: new Date().toISOString()
            }
          })
          console.error(`[bridge] extension ${message.version ?? ""} connected`)
          this.waiters.forEach((wake) => wake())
        }
        return
      }
      if (role === "extension" && message.type === "response") {
        this.onResponse(message)
      } else if (role === "peer" && message.type === "request") {
        const { id, method, params, timeoutMs } = message
        this.callExtension(method, params, Number(timeoutMs) || 60_000).then(
          (result) => send(ws, { type: "response", id, ok: true, result }),
          (error: Error) => send(ws, { type: "response", id, ok: false, error: error.message })
        )
      }
    })
    ws.on("close", () => {
      this.extensions = this.extensions.filter((e) => e.ws !== ws)
      this.rejectPending(ws, "The extension disconnected (was the browser closed or the extension reloaded?).")
    })
  }

  private status() {
    return {
      port: this.port,
      bridgePid: process.pid,
      extensions: this.extensions.map((e) => e.info)
    }
  }

  private async callExtension(method: string, params: unknown, timeoutMs: number) {
    if (method === "bridge.status") return this.status()
    const ws = (await this.waitForExtension()).ws
    return this.request(ws, method, { params }, timeoutMs)
  }

  private waitForExtension() {
    const newest = () => this.extensions[this.extensions.length - 1]
    if (newest()) return Promise.resolve(newest())
    return new Promise<(typeof this.extensions)[number]>((resolve, reject) => {
      const wake = () => {
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve(newest())
      }
      const timer = setTimeout(() => {
        this.waiters.delete(wake)
        reject(
          new Error(
            "The Get into zone extension isn't connected. Open Chrome (or Edge, Brave, Arc) with the extension installed, " +
              `and check that Settings → "Let Claude use this extension" is on with port ${this.port}.`
          )
        )
      }, EXTENSION_WAIT_MS)
      this.waiters.add(wake)
    })
  }

  private request(ws: WebSocket, method: string, body: Record<string, unknown>, timeoutMs: number) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)
      this.pending.set(id, { ws, resolve, reject, timer })
      send(ws, { type: "request", id, method, ...body })
    })
  }

  private onResponse(message: any) {
    const pending = message?.type === "response" && this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.ok) pending.resolve(message.result)
    else pending.reject(new Error(message.error || "Failed."))
  }

  private rejectPending(ws: WebSocket, reason: string) {
    for (const [id, pending] of this.pending) {
      if (pending.ws !== ws) continue
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
  }
}
