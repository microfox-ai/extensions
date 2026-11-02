// Keeps Browse Hack up to date by itself: this MCP server (released to the
// MediaMake catalog as mcp/browse-hack) and the Chrome extension (GitHub
// Releases of microfox-ai/extensions, browse-hack-chrome.zip).
//
// The first install (MediaMake's install.md) leaves:
//   ~/.mediamake/config.json          { url, updateToken (or apiKey), autoUpdate? }
//   ~/.mediamake/mcp/browse-hack/     the unpacked .mcpb Claude Code runs
//   ~/Extensions/browse-hack-chrome/  the extension, loaded unpacked in Chrome
// A minute after start and then every few hours, one server process (each
// Claude session runs its own; the lock picks one) checks both:
//   - MCP: asks the catalog for the live version. When it is newer than the
//     folder's, downloads the package, checks its sha256 and swaps the new
//     files in. Running servers keep the code they started with; the next
//     Claude session runs the new one.
//   - Extension: picks the newest vX.Y.Z release with the zip. When it is
//     newer than the folder's, checks the zip's digest, swaps the folder's
//     files (the same folder keeps the extension id and its settings) and
//     reloads the extension in each Chrome profile that loads that folder.
//     Chrome can't update unpacked extensions itself. While one of them is
//     busy (downloads, Claude calls in flight) it waits and tries again.
// What happened is kept in ~/.mediamake/updates/browse-hack.json, which
// get_status and update_browse_hack report.

import { createHash } from "node:crypto"
import {
  closeSync,
  cpSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"

import { readTarGz, readZip, writeFiles, type ArchiveFile } from "./archive.js"
import type { Profile } from "./bridge.js"

export const MCP_ITEM = "mcp/browse-hack"
const MCP_NAME = "browse-hack"
const EXTENSION_NAME = "Browse Hack"
const EXTENSION_REPO = "microfox-ai/extensions"
const EXTENSION_ASSET = "browse-hack-chrome.zip"
const DEFAULT_MEDIAMAKE_URL = "https://mediamake.microfox.app"

const CHECK_EVERY_MS = 6 * 60 * 60_000
// How soon to try again while the extension is busy.
const BUSY_RETRY_MS = 15 * 60_000
const TICK_MS = 15 * 60_000
const FIRST_CHECK_MS = 60_000
const LOCK_STALE_MS = 15 * 60_000
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024
const RECONNECT_WAIT_MS = 30_000

export interface Release {
  version: string
  publishedAt?: string
  notes?: string
}

export interface ProfileReport {
  /** The profile's Google account email (or its name). */
  profile: string
  version?: string
  loadedFrom: "this folder" | "another folder"
  reloaded?: boolean
  note?: string
}

export interface PartState {
  /** The version on disk. */
  installed?: string
  /** The live version, as last seen. */
  latest?: string
  /** When the last update was installed, the version it replaced, and its release notes. */
  updatedAt?: string
  from?: string
  notes?: Release[]
  /** Why it isn't checked (not installed from MediaMake, no credential). */
  skipped?: string
  /** Why the extension update is waiting (busy), or what the user needs to do. */
  waiting?: string
  error?: string
  profiles?: ProfileReport[]
}

export interface UpdateState {
  checkedAt?: string
  mcp: PartState
  extension: PartState
}

export interface UpdateBridge {
  status(): Promise<{ profiles?: Profile[] }>
  callIn(profileId: string, method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
}

export interface UpdaterOptions {
  bridge: UpdateBridge
  /** The version of the server running here, and the folder it runs from (with manifest.json). */
  runningVersion: string
  runningFrom?: string
  home?: string
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => number
  githubApi?: string
  platform?: NodeJS.Platform
  reconnectWaitMs?: number
}

export interface CheckOptions {
  /** Check now, even when the last check was recent or auto-update is off. */
  force?: boolean
  /** Reload the extension even while it's busy. */
  reloadBusy?: boolean
}

// --- Small helpers -----------------------------------------------------------

const readJson = (path: string | URL): any => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

const writeJson = (path: string, value: unknown, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined)
  renameSync(temp, path)
}

const parseVersion = (version?: string) => {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version ?? "")
  return match ? match.slice(1, 4).map(Number) : undefined
}

/** Whether `a` is a higher version than `b` (anything beats an unknown `b`). */
export function isNewer(a?: string, b?: string) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x) return false
  if (!y) return true
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * The id Chrome gives an extension loaded unpacked from `folder` (one without
 * a "key" in its manifest): the first 32 hex digits of the SHA-256 of its
 * absolute path, written with the letters a-p. Checked against Chrome.
 */
export function unpackedExtensionId(folder: string, platform: NodeJS.Platform = process.platform) {
  const bytes =
    platform === "win32"
      ? Buffer.from(folder.replace(/^[a-z]:/, (drive) => drive.toUpperCase()), "utf16le")
      : Buffer.from(folder, "utf8")
  const hex = createHash("sha256").update(bytes).digest("hex").slice(0, 32)
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("")
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    return error?.code === "EPERM"
  }
}

/**
 * Swaps `folder`'s files for `files`: they are written next to it first, then
 * the folders are renamed, so a failure leaves the old copy in place. Where a
 * folder can't be renamed while in use (Windows), its contents are replaced.
 */
export function replaceFolder(folder: string, files: ArchiveFile[]) {
  const staging = join(dirname(folder), `.${basename(folder)}.new-${process.pid}`)
  const old = join(dirname(folder), `.${basename(folder)}.old-${process.pid}`)
  rmSync(staging, { recursive: true, force: true })
  rmSync(old, { recursive: true, force: true })
  writeFiles(staging, files)
  try {
    renameSync(folder, old)
  } catch (error: any) {
    if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code)) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
    for (const entry of readdirSync(folder)) rmSync(join(folder, entry), { recursive: true, force: true })
    cpSync(staging, folder, { recursive: true })
    rmSync(staging, { recursive: true, force: true })
    return
  }
  try {
    renameSync(staging, folder)
  } catch (error) {
    renameSync(old, folder)
    rmSync(staging, { recursive: true, force: true })
    throw error
  }
  rmSync(old, { recursive: true, force: true })
}

// GitHub's generated notes follow the install steps the release workflow writes.
const releaseNotes = (body?: string) => {
  const text = String(body ?? "")
  const changes = text.indexOf("## What's Changed")
  const notes = (changes >= 0 ? text.slice(changes) : text).trim()
  return notes ? notes.slice(0, 2000) : undefined
}

// --- The updater -------------------------------------------------------------

export class Updater {
  private home: string
  private env: NodeJS.ProcessEnv
  private fetch: typeof fetch
  private now: () => number
  private githubApi: string
  private platform: NodeJS.Platform
  private reconnectWaitMs: number
  private running?: Promise<UpdateState>
  private noticeShown = false

  constructor(private options: UpdaterOptions) {
    this.home = options.home ?? homedir()
    this.env = options.env ?? process.env
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.githubApi = (options.githubApi ?? "https://api.github.com").replace(/\/$/, "")
    this.platform = options.platform ?? process.platform
    this.reconnectWaitMs = options.reconnectWaitMs ?? RECONNECT_WAIT_MS
  }

  get paths() {
    const mediamake = join(this.home, ".mediamake")
    return {
      config: join(mediamake, "config.json"),
      installed: join(mediamake, "installed.json"),
      state: join(mediamake, "updates", "browse-hack.json"),
      lock: join(mediamake, "updates", "browse-hack.lock"),
      mcp: join(mediamake, "mcp", MCP_NAME),
      extension: join(this.home, "Extensions", "browse-hack-chrome")
    }
  }

  private config() {
    const config = readJson(this.paths.config) ?? {}
    const off = /^(0|false|off|no)$/i.test(this.env.BROWSE_HACK_AUTO_UPDATE ?? "")
    return {
      url: String(config.url || this.env.MEDIAMAKE_URL || DEFAULT_MEDIAMAKE_URL).replace(/\/$/, ""),
      auth: (config.updateToken || config.apiKey || this.env.MEDIAMAKE_API_KEY) as string | undefined,
      autoUpdate: config.autoUpdate !== false && !off
    }
  }

  get autoUpdate() {
    return this.config().autoUpdate
  }

  /** Turns automatic updates on or off in ~/.mediamake/config.json. */
  setAutoUpdate(on: boolean) {
    const config = readJson(this.paths.config) ?? {}
    if (on) delete config.autoUpdate
    else config.autoUpdate = false
    writeJson(this.paths.config, config, 0o600)
  }

  readState(): UpdateState {
    const state = readJson(this.paths.state)
    return { mcp: {}, extension: {}, ...(state && typeof state === "object" ? state : {}) }
  }

  /** Checks a minute after start, then every TICK_MS (each check is throttled). */
  start() {
    const run = () =>
      this.check().catch((error) => console.error("[update]", message(error)))
    setTimeout(run, FIRST_CHECK_MS).unref()
    setInterval(run, TICK_MS).unref()
  }

  private isDue(state: UpdateState) {
    if (!state.checkedAt) return true
    const since = this.now() - Date.parse(state.checkedAt)
    return since >= CHECK_EVERY_MS || (Boolean(state.extension.waiting) && since >= BUSY_RETRY_MS)
  }

  /** Checks for updates and installs them, when due (or forced). Returns the state after. */
  check(options: CheckOptions = {}): Promise<UpdateState> {
    this.running ??= this.checkOnce(options).finally(() => {
      this.running = undefined
    })
    return this.running
  }

  private async checkOnce({ force, reloadBusy }: CheckOptions) {
    if (!force && (!this.autoUpdate || !this.isDue(this.readState()))) return this.readState()
    const release = this.lock()
    if (!release) {
      if (force) throw new Error("Another Browse Hack server is installing an update right now; try again in a minute.")
      return this.readState()
    }
    try {
      // Another process may have checked while this one waited for the lock.
      const before = this.readState()
      if (!force && !this.isDue(before)) return before
      const [mcp, extension] = await Promise.all([
        this.updateMcp(before.mcp).catch((error) => ({ ...before.mcp, error: message(error) })),
        this.updateExtension(before.extension, Boolean(reloadBusy)).catch((error) => ({
          ...before.extension,
          error: message(error)
        }))
      ])
      const state: UpdateState = { checkedAt: new Date(this.now()).toISOString(), mcp, extension }
      writeJson(this.paths.state, state)
      return state
    } finally {
      release()
    }
  }

  /** Takes the update lock; undefined when a live process holds it. */
  private lock() {
    const file = this.paths.lock
    mkdirSync(dirname(file), { recursive: true })
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, "wx")
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date(this.now()).toISOString() }))
        closeSync(fd)
        return () => {
          if (readJson(file)?.pid === process.pid) unlinkSync(file)
        }
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error
        // A lock whose owner is gone, or that is very old, is stale. One that
        // can't be read yet is being written: it counts as held.
        const held = readJson(file)
        const age = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0)
        const ownerGone = Number.isInteger(held?.pid) && !isAlive(held.pid)
        if (!ownerGone && age < LOCK_STALE_MS) return undefined
        rmSync(file, { force: true })
      }
    }
    return undefined
  }

  private async get(url: string, headers: Record<string, string> = {}) {
    const res = await this.fetch(url, { headers: { "User-Agent": "browse-hack-mcp", ...headers } })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(`${new URL(url).pathname} answered ${res.status}${body?.error ? `: ${body.error}` : ""}`)
    }
    return res
  }

  private async download(url: string) {
    const res = await this.get(url)
    if (Number(res.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) throw new Error("The download is too large.")
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length > MAX_DOWNLOAD_BYTES) throw new Error("The download is too large.")
    return data
  }

  // --- MCP ---

  private async updateMcp(previous: PartState): Promise<PartState> {
    const folder = this.paths.mcp
    const manifest = readJson(join(folder, "manifest.json"))
    if (manifest?.name !== MCP_NAME) {
      return { skipped: `Not installed from MediaMake (nothing at ${folder}), so it isn't updated here.` }
    }
    const installed = String(manifest.version)
    const kept = { updatedAt: previous.updatedAt, from: previous.from, notes: previous.notes }
    const { url, auth } = this.config()
    if (!auth) {
      return {
        ...kept,
        installed,
        skipped:
          "No MediaMake update token on this machine. Say \"update browse hack\" once with an install prompt " +
          "copied from Browse Hack's page on MediaMake; after that it updates by itself."
      }
    }
    const headers = { Authorization: `Bearer ${auth}` }
    const versions = await (await this.get(`${url}/api/catalog/versions?items=${MCP_ITEM}`, headers)).json()
    const item = versions?.items?.find((entry: any) => entry?.id === MCP_ITEM)
    if (!item?.version) throw new Error(`MediaMake doesn't list ${MCP_ITEM} for this account.`)
    const latest = String(item.version)
    if (!isNewer(latest, installed)) return { ...kept, installed, latest }

    const plan = await (await this.get(`${url}/api/catalog/install?item=${MCP_ITEM}`, headers)).json()
    const step = plan?.steps?.find((s: any) => s?.type === "item" && s.id === MCP_ITEM)
    if (!step?.downloadUrl || !/^[a-f0-9]{64}$/.test(step.sha256 ?? "")) throw new Error("The install plan has no package.")
    const archive = await this.download(step.downloadUrl)
    if (sha256(archive) !== step.sha256) throw new Error(`The ${MCP_ITEM}@${step.version} package failed its sha256 check.`)

    const entry = step.entry ?? "browse-hack.mcpb"
    const bundle = readTarGz(archive).find((file) => file.path === entry || basename(file.path) === entry)
    if (!bundle) throw new Error(`The package has no ${entry}.`)
    const files = readZip(bundle.data)
    const next = JSON.parse(files.find((file) => file.path === "manifest.json")?.data.toString("utf8") ?? "null")
    const entryPoint = next?.server?.entry_point ?? "server/index.js"
    if (next?.name !== MCP_NAME || next.version !== step.version || !files.some((file) => file.path === entryPoint)) {
      throw new Error(`The package isn't Browse Hack ${step.version}.`)
    }
    // Claude Code was registered with the old launch settings; a change there
    // needs `claude mcp add` again, which is the user's to run.
    if (JSON.stringify(next.server?.mcp_config) !== JSON.stringify(manifest.server?.mcp_config)) {
      return {
        ...kept,
        installed,
        latest,
        waiting:
          `Browse Hack ${latest} starts differently, so it has to be registered again: say "update browse hack" ` +
          "and Claude follows MediaMake's install.md."
      }
    }

    replaceFolder(folder, files)
    this.recordInstall(String(step.version), step.title)
    console.error(`[update] installed Browse Hack MCP ${step.version} (was ${installed})`)
    const releases: Release[] = Array.isArray(item.releases) ? item.releases : []
    return {
      installed: String(step.version),
      latest,
      updatedAt: new Date(this.now()).toISOString(),
      from: installed,
      notes: releases.filter((r) => isNewer(r.version, installed) && !isNewer(r.version, step.version))
    }
  }

  /** Keeps MediaMake's ~/.mediamake/installed.json in step. */
  private recordInstall(version: string, title?: string) {
    const installed = readJson(this.paths.installed) ?? {}
    const items = installed.items && typeof installed.items === "object" ? installed.items : {}
    items[MCP_ITEM] = {
      ...items[MCP_ITEM],
      version,
      title: title ?? items[MCP_ITEM]?.title ?? EXTENSION_NAME,
      method: "mcpb",
      path: this.paths.mcp,
      installedAt: new Date(this.now()).toISOString()
    }
    writeJson(this.paths.installed, { ...installed, items })
  }

  // --- Extension ---

  private async latestExtension() {
    const res = await this.get(`${this.githubApi}/repos/${EXTENSION_REPO}/releases?per_page=30`, {
      Accept: "application/vnd.github+json"
    })
    const releases = ((await res.json()) as any[])
      .filter((r) => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(r.tag_name ?? ""))
      .map((r) => ({
        version: String(r.tag_name).slice(1),
        publishedAt: r.published_at,
        notes: releaseNotes(r.body),
        asset: (r.assets ?? []).find((a: any) => a.name === EXTENSION_ASSET)
      }))
      .filter((r) => r.asset)
      .sort((a, b) => (isNewer(a.version, b.version) ? -1 : isNewer(b.version, a.version) ? 1 : 0))
    if (!releases.length) throw new Error(`No ${EXTENSION_ASSET} release found in ${EXTENSION_REPO}.`)
    return releases
  }

  private async updateExtension(previous: PartState, reloadBusy: boolean): Promise<PartState> {
    const manifest = readJson(join(this.paths.extension, "manifest.json"))
    const connected = (await this.options.bridge.status().catch(() => ({ profiles: [] }))).profiles ?? []
    if (manifest?.name !== EXTENSION_NAME) {
      return {
        skipped: `Not installed from MediaMake (nothing at ${this.paths.extension}), so it isn't updated here.`,
        profiles: connected.map((p) => this.report(p, false))
      }
    }
    // The real folder: its path is what the extension id comes from.
    const folder = realpathSync(this.paths.extension)
    const id = unpackedExtensionId(folder, this.platform)
    const here = connected.filter((p) => p.extensionId === id)
    const installed = String(manifest.version)
    const kept = { updatedAt: previous.updatedAt, from: previous.from, notes: previous.notes }

    const releases = await this.latestExtension()
    const newest = releases[0]
    const latest = newest.version
    // The folder is current, but a profile may still run an older copy from it.
    const stale = here.filter((p) => isNewer(installed, p.version))
    if (!isNewer(latest, installed) && !stale.length) {
      return { ...kept, installed, latest, profiles: connected.map((p) => this.report(p, here.includes(p))) }
    }

    const upgrade = isNewer(latest, installed)
    const version = upgrade ? latest : installed
    const targets = upgrade ? here : stale
    const busy = await this.busy(targets)
    if (busy.length && !reloadBusy) {
      return {
        ...kept,
        installed,
        latest,
        waiting: `Waiting to update the extension until it's idle: ${busy.join("; ")}. It tries again in 15 minutes.`,
        profiles: connected.map((p) => this.report(p, here.includes(p)))
      }
    }

    let update: PartState = kept
    if (upgrade) {
      const zip = await this.download(newest.asset.browser_download_url)
      const digest = /^sha256:([a-f0-9]{64})$/.exec(newest.asset.digest ?? "")?.[1]
      if (!digest) throw new Error(`GitHub gave no sha256 digest for ${EXTENSION_ASSET} ${newest.version}.`)
      if (sha256(zip) !== digest) throw new Error(`${EXTENSION_ASSET} ${newest.version} failed its sha256 check.`)
      const files = readZip(zip)
      const next = JSON.parse(files.find((file) => file.path === "manifest.json")?.data.toString("utf8") ?? "null")
      if (next?.name !== EXTENSION_NAME || next.version !== latest) {
        throw new Error(`${EXTENSION_ASSET} ${latest} isn't Browse Hack ${latest}.`)
      }
      replaceFolder(folder, files)
      console.error(`[update] installed the Browse Hack extension ${latest} (was ${installed})`)
      update = {
        updatedAt: new Date(this.now()).toISOString(),
        from: installed,
        notes: releases
          .filter((r) => isNewer(r.version, installed))
          .map(({ version, publishedAt, notes }) => ({ version, publishedAt, notes }))
      }
    }

    const reloaded = await this.reload(targets, version)
    const needsClick = [...reloaded.values()].filter((p) => !p.reloaded)
    return {
      ...update,
      installed: version,
      latest,
      profiles: connected.map((p) => reloaded.get(p.id) ?? this.report(p, here.includes(p))),
      waiting: needsClick.length
        ? `Reload Browse Hack on chrome://extensions in ${needsClick.map((p) => p.profile).join(", ")} ` +
          `(the reload icon on its card) to run ${version}; later updates reload by themselves.`
        : undefined
    }
  }

  private report(profile: Profile, fromHere: boolean): ProfileReport {
    return {
      profile: profile.email ?? profile.label,
      version: profile.version,
      loadedFrom: fromHere ? "this folder" : "another folder",
      note: fromHere
        ? undefined
        : `Loaded from another folder (extension id ${profile.extensionId}), so it isn't updated automatically.`
    }
  }

  /** What keeps each profile busy, as "<email>: <what>". Older extensions can't say. */
  private async busy(profiles: Profile[]) {
    const busy: string[] = []
    for (const profile of profiles) {
      const status = (await this.options.bridge
        .callIn(profile.id, "extension.status", {}, 10_000)
        .catch(() => undefined)) as { busy?: string[] } | undefined
      if (status?.busy?.length) busy.push(`${profile.email ?? profile.label}: ${status.busy.join(", ")}`)
    }
    return busy
  }

  /** Reloads the extension in each profile and waits for it to come back on `version`. */
  private async reload(profiles: Profile[], version: string) {
    const reports = new Map<string, ProfileReport>()
    for (const profile of profiles) {
      const report = this.report(profile, true)
      try {
        await this.options.bridge.callIn(profile.id, "extension.reload", {}, 10_000)
        report.reloaded = await this.waitForVersion(profile.id, version)
        report.version = report.reloaded ? version : report.version
        if (!report.reloaded) report.note = `Reloaded, but it hasn't reconnected on ${version} yet.`
      } catch (error) {
        report.reloaded = false
        report.note = /Unknown method/.test(message(error))
          ? "This copy is too old to reload itself."
          : `Couldn't reload it: ${message(error)}`
      }
      reports.set(profile.id, report)
    }
    return reports
  }

  private async waitForVersion(profileId: string, version: string) {
    const until = Date.now() + this.reconnectWaitMs
    while (Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const { profiles = [] } = await this.options.bridge.status().catch(() => ({ profiles: [] as Profile[] }))
      if (profiles.some((p) => p.id === profileId && p.version === version)) return true
    }
    return false
  }

  // --- Reporting ---

  /** Versions and what happened, for get_status and update_browse_hack. */
  summary(state = this.readState()) {
    const running = this.options.runningVersion
    const installed = this.installedMcp()
    const elsewhere = this.runsElsewhere()
    return {
      autoUpdate: this.autoUpdate,
      checkedAt: state.checkedAt ?? null,
      mcp: {
        runningVersion: running,
        installedVersion: installed ?? null,
        liveVersion: state.mcp.latest ?? null,
        ...(elsewhere
          ? {
              note:
                `This session runs Browse Hack from ${this.options.runningFrom}, not from MediaMake's install ` +
                `(${this.paths.mcp}), so updates there don't reach it.`
            }
          : isNewer(installed, running)
            ? { note: `Browse Hack MCP ${installed} is installed; this session runs ${running}. Start a new Claude session to use it.` }
            : {}),
        ...this.details(state.mcp)
      },
      extension: {
        folder: this.paths.extension,
        installedVersion: readJson(join(this.paths.extension, "manifest.json"))?.version ?? null,
        liveVersion: state.extension.latest ?? null,
        ...this.details(state.extension)
      }
    }
  }

  private installedMcp(): string | undefined {
    const manifest = readJson(join(this.paths.mcp, "manifest.json"))
    return manifest?.name === MCP_NAME ? manifest.version : undefined
  }

  /** Whether this server runs from somewhere other than MediaMake's install (a checkout, Claude Desktop). */
  private runsElsewhere() {
    const real = (path: string) => {
      try {
        return realpathSync(path)
      } catch {
        return path
      }
    }
    return Boolean(this.options.runningFrom) && real(this.options.runningFrom!) !== real(this.paths.mcp)
  }

  private details({ updatedAt, from, notes, skipped, waiting, error, profiles }: PartState) {
    return {
      ...(updatedAt ? { lastUpdate: { at: updatedAt, from, releaseNotes: notes ?? [] } } : {}),
      ...(skipped ? { skipped } : {}),
      ...(waiting ? { waiting } : {}),
      ...(error ? { error } : {}),
      ...(profiles ? { profiles } : {})
    }
  }

  /** Once per process: the line to add to a tool result when a newer MCP is installed. */
  notice() {
    if (this.noticeShown || this.runsElsewhere()) return undefined
    const installed = this.installedMcp()
    if (!isNewer(installed, this.options.runningVersion)) return undefined
    this.noticeShown = true
    return (
      `Browse Hack MCP ${installed} is installed (this session runs ${this.options.runningVersion}). ` +
      "Tell the user a new Claude session picks it up; get_status shows what changed."
    )
  }
}

/** The version in the manifest.json next to this server (../manifest.json from dist/ or server/). */
export function serverVersion(url = import.meta.url) {
  const manifest = readJson(new URL("../manifest.json", url))
  return typeof manifest?.version === "string" ? manifest.version : "0.0.0"
}
