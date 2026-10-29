// The link between this MCP server and the Browse Hack extension.
//
// The extension's service worker connects to ws://127.0.0.1:<port>. Claude
// Desktop and Claude Code each start their own copy of this server, so the
// first copy listens on the port (the hub) and later copies connect to it as
// peers; the hub forwards their requests to the extension. When the hub exits,
// a peer takes over the port.
//
// Each Chrome profile runs its own copy of the extension, so several can be
// connected at once. Each copy of this server (one per Claude session) works
// with one profile: the only one connected, or the one picked with
// useProfile. With two or more connected and none picked, calls fail with a
// message telling Claude to ask the user which profile to use.

import { WebSocket, WebSocketServer } from "ws"

// The extension retries every 30s at most, so a new hub may wait that long.
const EXTENSION_WAIT_MS = 35_000
const TAB_LOOKUP_MS = 3000
// The extension pings every 20s. One silent for longer is gone (the computer
// slept, Chrome froze): drop it so its pending calls fail now instead of
// hanging until their timeouts, and let it reconnect.
const EXTENSION_SILENCE_MS = 65_000

export interface Profile {
  // Stable per Chrome profile (stored by the extension).
  id: string
  // What to call it: the name set in the extension's Settings, else the
  // profile's Google account, else a short id.
  label: string
  name?: string
  email?: string
  version?: string
  extensionId?: string
  connectedAt: string
  // Whether the extension is signed in to Mediamake; every tool needs it.
  signedIn?: boolean
  mediamakeAccount?: string
}

interface Extension {
  ws: WebSocket
  profile: Profile
  lastHeardAt: number
}

interface Pending {
  ws: WebSocket
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

// Older extensions don't report a Mediamake sign-in.
const signInOf = (message: any): Pick<Profile, "signedIn" | "mediamakeAccount"> =>
  typeof message.signedIn === "boolean"
    ? {
        signedIn: message.signedIn,
        mediamakeAccount: typeof message.mediamakeAccount === "string" ? message.mediamakeAccount : undefined
      }
    : {}

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

// Users know their profiles by Google account, not by number, so the email leads.
const describe = (p: Profile) =>
  `- ${p.email ?? p.label}${p.name && p.name !== p.email ? ` (${p.name})` : ""} — id ${p.id}`

const chooseMessage = (profiles: Profile[]) =>
  `The Browse Hack extension is connected in ${profiles.length} Chrome profiles:\n` +
  profiles.map(describe).join("\n") +
  "\nAsk the user which profile to use for this session, naming each by its email (list_profiles shows each one's open tab), " +
  "then call use_profile with the email they pick and retry. Don't pick one yourself."

export class Bridge {
  private mode: "hub" | "peer" | null = null
  private starting?: Promise<void>
  private hub?: WebSocket
  private extensions: Extension[] = []
  // Every profile seen since the hub started, so errors can name one that left.
  private known = new Map<string, Profile>()
  private waiters = new Set<() => void>()
  private pending = new Map<number, Pending>()
  private nextId = 1
  // The profile this session uses, once picked.
  private chosen?: Profile

  constructor(
    private port: number,
    private extensionId?: string
  ) {}

  /** Calls a method on the extension (see get-into-zone/lib/mcpBridge.ts). */
  async call(method: string, params: any = {}, timeoutMs = 60_000) {
    await this.ensure()
    if (method === "bridge.status") {
      return { ...((await this.forward(method)) as object), sessionProfile: this.chosen ?? null }
    }
    if (method === "bridge.profiles") {
      const profiles = (await this.forward(method)) as Profile[]
      return profiles.map((p) => ({ ...p, usedByThisSession: p.id === this.chosen?.id }))
    }
    if (method === "bridge.useProfile") return this.useProfile(params?.profile)
    return this.forward(method, params, timeoutMs, await this.target())
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

  /** The profile id to send a call to, or undefined to use the only one. */
  private async target() {
    if (this.chosen) return this.chosen.id
    const profiles = await this.connectedProfiles()
    if (profiles.length > 1) throw new Error(chooseMessage(profiles))
    return undefined
  }

  private async connectedProfiles() {
    const { profiles } = (await this.forward("bridge.status")) as { profiles?: Profile[] }
    if (!profiles) {
      throw new Error(
        `The bridge on port ${this.port} was started by an older copy of this server. Quit and reopen the Claude apps using it.`
      )
    }
    return profiles
  }

  private async useProfile(query: unknown) {
    const profiles = await this.connectedProfiles()
    const text = String(query ?? "").trim().toLowerCase()
    if (!text) throw new Error("Pass the profile to use (email, name, id or number from list_profiles).")
    const index = /^\d+$/.test(text) ? Number(text) - 1 : -1
    const match =
      profiles[index] ??
      profiles.find((p) => p.id.toLowerCase() === text) ??
      profiles.find((p) => [p.label, p.name, p.email].some((v) => v?.toLowerCase() === text)) ??
      profiles.find((p) => [p.label, p.name, p.email].some((v) => v?.toLowerCase().includes(text)))
    if (!match) {
      throw new Error(
        profiles.length
          ? `No connected profile matches "${query}". Connected:\n${profiles.map(describe).join("\n")}`
          : "No Chrome profile has the extension connected right now."
      )
    }
    this.chosen = match
    return { using: match, note: "Every tool in this session now runs in this Chrome profile only." }
  }

  /** Sends a call to the hub's extension handling, here or over the peer socket. */
  private forward(method: string, params: unknown = {}, timeoutMs = 60_000, profile?: string) {
    if (this.mode === "hub") return this.callExtension(method, params, timeoutMs, profile)
    return this.request(
      this.hub!,
      method,
      { params, timeoutMs, profile },
      timeoutMs + EXTENSION_WAIT_MS + 5000
    )
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
        setInterval(() => this.dropSilentExtensions(), 15_000).unref()
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
      const extension = this.extensions.find((e) => e.ws === ws)
      if (extension) extension.lastHeardAt = Date.now()
      if (message.type === "ping") return send(ws, { type: "pong" })
      if (message.type === "hello" && !role) {
        role = message.role === "extension" ? "extension" : "peer"
        if (role === "extension") this.addExtension(ws, message)
        return
      }
      if (role === "extension" && message.type === "response") {
        this.onResponse(message)
      } else if (role === "extension" && message.type === "status" && extension) {
        Object.assign(extension.profile, signInOf(message))
      } else if (role === "peer" && message.type === "request") {
        const { id, method, params, timeoutMs, profile } = message
        this.callExtension(method, params, Number(timeoutMs) || 60_000, profile || undefined).then(
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

  private addExtension(ws: WebSocket, hello: any) {
    // Older extensions don't send a profile id; each connection is its own profile then.
    const id = String(hello.profileId || `connection-${this.nextId++}`)
    const name = typeof hello.profileName === "string" && hello.profileName.trim() ? hello.profileName.trim() : undefined
    const email = typeof hello.email === "string" && hello.email ? hello.email : undefined
    const profile: Profile = {
      id,
      label: name ?? email ?? `Profile ${id.slice(0, 8)}`,
      name,
      email,
      version: hello.version,
      extensionId: hello.extensionId,
      connectedAt: new Date().toISOString(),
      ...signInOf(hello)
    }
    // The same profile reconnecting (its worker restarted) replaces the old socket.
    for (const old of this.extensions.filter((e) => e.profile.id === id)) old.ws.close()
    this.extensions = this.extensions.filter((e) => e.profile.id !== id)
    this.extensions.push({ ws, profile, lastHeardAt: Date.now() })
    this.known.set(id, profile)
    console.error(`[bridge] extension ${profile.version ?? ""} connected (${profile.label})`)
    this.waiters.forEach((wake) => wake())
  }

  private dropSilentExtensions() {
    for (const { ws, profile, lastHeardAt } of this.extensions) {
      if (Date.now() - lastHeardAt < EXTENSION_SILENCE_MS) continue
      console.error(`[bridge] no word from the extension (${profile.label}) for a minute; dropping it`)
      // Closes the socket at once; the close handler fails its pending calls.
      ws.terminate()
    }
  }

  private status() {
    return {
      port: this.port,
      bridgePid: process.pid,
      profiles: this.extensions.map((e) => e.profile)
    }
  }

  /** Each connected profile with its active tab, to help the user tell them apart. */
  private profiles() {
    return Promise.all(
      this.extensions.map(async ({ ws, profile }, i) => {
        const tabs = (await this.request(ws, "tabs.list", { params: {} }, TAB_LOOKUP_MS).catch(() => [])) as {
          active?: boolean
          title?: string
          url?: string
        }[]
        const active = tabs.find((tab) => tab.active)
        return {
          number: i + 1,
          ...profile,
          openTabs: tabs.length,
          activeTab: active ? { title: active.title, url: active.url } : undefined
        }
      })
    )
  }

  private async callExtension(method: string, params: any, timeoutMs: number, profileId?: string) {
    if (method === "bridge.status") return this.status()
    if (method === "bridge.profiles") return this.profiles()
    const extension = await this.extensionFor(profileId)
    return this.request(extension.ws, method, { params }, timeoutMs)
  }

  /** The extension of the given profile, or the only one connected; waits for it to connect. */
  private async extensionFor(profileId?: string): Promise<Extension> {
    const find = () => (profileId ? this.extensions.find((e) => e.profile.id === profileId) : this.extensions[0])
    if (!find()) await this.waitForExtension(() => Boolean(find()), profileId)
    if (!profileId && this.extensions.length > 1) {
      throw new Error(chooseMessage(this.extensions.map((e) => e.profile)))
    }
    return find()!
  }

  private waitForExtension(ready: () => boolean, profileId?: string) {
    return new Promise<void>((resolve, reject) => {
      const wake = () => {
        if (!ready()) return
        clearTimeout(timer)
        this.waiters.delete(wake)
        resolve()
      }
      const timer = setTimeout(() => {
        this.waiters.delete(wake)
        reject(new Error(profileId ? this.missingProfileMessage(profileId) : this.notConnectedMessage()))
      }, EXTENSION_WAIT_MS)
      this.waiters.add(wake)
    })
  }

  private notConnectedMessage() {
    return (
      "The Browse Hack extension isn't connected. Open Chrome (or Edge, Brave, Arc) with the extension installed, " +
      `and check that Settings → "Let Claude use this extension" is on with port ${this.port}.`
    )
  }

  private missingProfileMessage(profileId: string) {
    const label = this.known.get(profileId)?.label ?? profileId
    const others = this.extensions.map((e) => e.profile)
    return (
      `The Chrome profile chosen for this session ("${label}") isn't connected. Ask the user to open a window of that ` +
      "profile, or whether to switch to another profile with use_profile." +
      (others.length ? `\nConnected now:\n${others.map(describe).join("\n")}` : "")
    )
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
