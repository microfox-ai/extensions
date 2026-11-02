// Suno batches: many songs or covers from one tool call, like the Midjourney
// batches (midjourneyBatch.ts). The extension makes one song at a time in its
// Suno tab; the batch keeps a few in Suno at once, waits for each, records
// every take in MediaMake cloud and, with download: "all", downloads them
// into the library inbox. State goes to <folder>/state.json and run.log, so
// starting it again on the same folder resumes it. It pauses (without
// counting an attempt) when Suno asks for a captcha in the tab or the credits
// run low, and says so in waitingFor.

import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"

import type { Bridge } from "./bridge.js"
import {
  checkSong,
  clipIdOf,
  coverSong,
  createSongs,
  downloadSongs,
  type CoverKind,
  type SongParams,
  type SunoSong
} from "./suno.js"

export interface SunoBatchJob extends SongParams {
  name: string
  /** create (default), or a cover / extend… of `from`. */
  mode?: "create" | CoverKind
  from?: string
  extendFrom?: number
  rightsConfirmed?: boolean
}

export interface SunoBatchOptions {
  channel?: string
  workspace?: string
  download?: "none" | "all"
  /** Songs in Suno at once (each Create makes two). Default 2. */
  concurrency?: number
  /** Stop sending new jobs below this many credits. Default 200. */
  minCredits?: number
}

type Status = "todo" | "submitted" | "done" | "failed"

interface JobState extends SunoBatchJob {
  status: Status
  clipIds?: string[]
  attempts?: number
  error?: string
  submittedAt?: string
  doneAt?: string
  recorded?: boolean
  downloaded?: string[]
}

interface BatchState {
  options: SunoBatchOptions
  jobs: Record<string, JobState>
}

const POLL_MS = Number(process.env.BROWSE_HACK_BATCH_POLL_MS) || 20_000
const MAX_ATTEMPTS = 3
const NAME = /^[\w.-]{1,120}$/
const CONNECTION = /isn't connected|disconnected|timed out|took too long|couldn't reach|failed to fetch|network|didn't answer/i
const NEEDS_USER = /captcha|asking for a check|isn't signed in|sign in|chrome profiles|use_profile|confirm you have the rights/i
const PERMANENT = /refused|not allowed|moderat|copyright|must be|isn't one of|no suno workspace|isn't a suno song|file not found|over 200 MB|only|needs lyrics/i

const now = () => new Date().toISOString()
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const sleep = (ms: number, wake?: Promise<void>) =>
  Promise.race([new Promise<void>((r) => setTimeout(r, ms)), wake ?? new Promise<void>(() => {})])

function resolveFolder(input: string) {
  const trimmed = input.trim()
  const path = trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed
  if (!isAbsolute(path)) throw new Error(`folder must be an absolute path, got "${input}".`)
  return path
}

/** Jobs from a JSON file: an array, or { jobs: [...] }. Relative file paths in `from` are relative to it. */
export function readSunoJobsFile(file: string): SunoBatchJob[] {
  const path = resolveFolder(file)
  const data = JSON.parse(fs.readFileSync(path, "utf8"))
  const jobs: SunoBatchJob[] = Array.isArray(data) ? data : data?.jobs
  if (!Array.isArray(jobs)) throw new Error(`${path} must hold an array of jobs, or { "jobs": [...] }.`)
  return jobs.map((job) =>
    job.from && !clipIdOf(job.from) && !/^[0-9a-f]{64}$/i.test(job.from) && !isAbsolute(job.from) && !job.from.startsWith("~/")
      ? { ...job, from: resolve(dirname(path), job.from) }
      : job
  )
}

class SunoBatch {
  readonly statePath: string
  private readonly logPath: string
  private readonly lockPath: string
  state: BatchState
  phase: "running" | "pausing" | "paused" | "stopped" | "done" = "stopped"
  startedAt?: string
  waitingFor?: string
  private recentErrors: string[] = []
  private backoffUntil = 0
  private wakeUp?: () => void
  private keepAwake?: ChildProcess
  private finished = new Set<() => void>()

  constructor(
    readonly folder: string,
    private readonly bridge: Bridge
  ) {
    fs.mkdirSync(folder, { recursive: true })
    this.statePath = join(folder, "state.json")
    this.logPath = join(folder, "run.log")
    this.lockPath = join(folder, ".batch.lock")
    this.state = fs.existsSync(this.statePath) ? JSON.parse(fs.readFileSync(this.statePath, "utf8")) : { options: {}, jobs: {} }
    this.state.options ??= {}
  }

  private save() {
    fs.writeFileSync(`${this.statePath}.tmp`, JSON.stringify(this.state, null, 1))
    fs.renameSync(`${this.statePath}.tmp`, this.statePath)
  }

  private log(...parts: unknown[]) {
    fs.appendFileSync(this.logPath, `[${now()}] ${parts.join(" ")}\n`)
  }

  private noteError(text: string) {
    this.recentErrors = [`${now()} ${text.slice(0, 300)}`, ...this.recentErrors].slice(0, 8)
    this.log("error", text.slice(0, 500))
  }

  merge(jobs: SunoBatchJob[], options: SunoBatchOptions, retryFailed: boolean) {
    const names = new Set<string>()
    for (const job of jobs) {
      if (typeof job?.name !== "string" || !NAME.test(job.name)) {
        throw new Error(`Job name "${job?.name}" must be 1-120 letters, digits, dots, dashes or underscores.`)
      }
      if (names.has(job.name)) throw new Error(`Two jobs are named ${job.name}.`)
      names.add(job.name)
      const mode = job.mode ?? "create"
      if (mode !== "create" && !job.from) throw new Error(`Job ${job.name} is a ${mode}: it needs from.`)
      const errors = checkSong(job, mode === "create")
      if (errors.length) throw new Error(`Job ${job.name}: ${errors.join(" ")}`)
    }
    for (const job of jobs) {
      const existing = this.state.jobs[job.name]
      if (!existing) this.state.jobs[job.name] = { ...job, status: "todo" }
      else if (existing.status === "todo") Object.assign(existing, job)
    }
    if (retryFailed) {
      for (const job of Object.values(this.state.jobs)) {
        if (job.status !== "failed") continue
        job.status = job.clipIds?.length ? "submitted" : "todo"
        job.attempts = 0
        delete job.error
      }
    }
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined))
    this.state.options = { ...this.state.options, ...given }
    this.save()
  }

  counts() {
    const counts: Record<Status, number> = { todo: 0, submitted: 0, done: 0, failed: 0 }
    for (const job of Object.values(this.state.jobs)) counts[job.status]++
    return counts
  }

  summary(details = false) {
    const jobs = Object.values(this.state.jobs)
    return {
      folder: this.folder,
      state: this.phase,
      startedAt: this.startedAt,
      total: jobs.length,
      ...this.counts(),
      ...(this.waitingFor ? { waitingFor: this.waitingFor } : {}),
      inSuno: jobs.filter((j) => j.status === "submitted").map((j) => ({ name: j.name, clipIds: j.clipIds, since: j.submittedAt })),
      failedJobs: jobs.filter((j) => j.status === "failed").map((j) => ({ name: j.name, error: j.error })),
      songs: jobs.filter((j) => j.status === "done").map((j) => ({ name: j.name, clipIds: j.clipIds, downloaded: j.downloaded })),
      recentErrors: this.recentErrors,
      ...(details ? { jobs } : {}),
      log: this.logPath
    }
  }

  waitForEnd(ms: number) {
    if (this.phase !== "running" && this.phase !== "pausing") return Promise.resolve()
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        this.finished.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.finished.add(done)
    })
  }

  pause() {
    if (this.phase !== "running") return
    this.phase = "pausing"
    this.log("pause requested: no new songs; the ones in Suno finish")
    this.wakeUp?.()
  }

  start() {
    if (this.phase === "running" || this.phase === "pausing") return
    this.lock()
    this.phase = "running"
    this.startedAt = now()
    this.waitingFor = undefined
    if (process.platform === "darwin") {
      this.keepAwake = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" })
      this.keepAwake.on("error", () => (this.keepAwake = undefined))
    }
    this.log("start", JSON.stringify(this.counts()))
    this.run()
      .catch((error) => this.noteError(`stopped: ${message(error)}`))
      .finally(() => {
        this.keepAwake?.kill()
        this.keepAwake = undefined
        fs.rmSync(this.lockPath, { force: true })
        const counts = this.counts()
        const left = counts.todo + counts.submitted
        this.phase = left ? "paused" : "done"
        this.log(this.phase.toUpperCase(), JSON.stringify(counts))
        this.finished.forEach((done) => done())
      })
  }

  private lock() {
    const holder = Number(fs.existsSync(this.lockPath) ? fs.readFileSync(this.lockPath, "utf8") : 0)
    if (holder && holder !== process.pid) {
      let alive = false
      try {
        process.kill(holder, 0)
        alive = true
      } catch {
        // A crashed run left the lock behind.
      }
      if (alive) throw new Error(`Another Claude session (process ${holder}) is running this batch. Pause it there first.`)
    }
    fs.writeFileSync(this.lockPath, String(process.pid))
  }

  private async run() {
    for (;;) {
      await this.poll()
      if (this.phase === "running") await this.submitMore()
      const counts = this.counts()
      if (counts.submitted === 0 && (counts.todo === 0 || this.phase === "pausing")) return
      await sleep(POLL_MS, new Promise<void>((r) => (this.wakeUp = r)))
    }
  }

  private async poll() {
    const jobs = Object.values(this.state.jobs).filter((j) => j.status === "submitted" && j.clipIds?.length)
    if (!jobs.length) return
    let songs: SunoSong[]
    try {
      songs = ((await this.bridge.call("suno.clips", { ids: jobs.flatMap((j) => j.clipIds!) }, 90_000)) as { songs: SunoSong[] }).songs
    } catch (error) {
      return this.noteError(`status: ${message(error)}`)
    }
    for (const job of jobs) {
      const mine = songs.filter((s) => job.clipIds!.includes(s.id))
      if (mine.length < job.clipIds!.length || !mine.every((s) => s.status === "complete" || s.status === "error")) continue
      job.status = "done"
      job.doneAt = now()
      this.log("done", job.name, job.clipIds!.join(" "))
      const channel = job.channel ?? this.state.options.channel
      if (!job.recorded) {
        await this.bridge
          .call("suno.record", { clips: mine, channel, kind: job.mode ?? "create" }, 60_000)
          .then(() => (job.recorded = true))
          .catch((error) => this.noteError(`record ${job.name}: ${message(error)}`))
      }
      if (this.state.options.download === "all") {
        const complete = mine.filter((s) => s.status === "complete").map((s) => s.id)
        try {
          const result = (await downloadSongs(this.bridge, { ids: complete, channel, set: job.set })) as { saved: { path: string }[] }
          job.downloaded = result.saved.map((s) => s.path)
        } catch (error) {
          this.noteError(`download ${job.name}: ${message(error)}`)
        }
      }
      this.save()
    }
  }

  private async credits() {
    const status = (await this.bridge.call("suno.status", {}, 90_000)) as { account?: { creditsLeft?: number } }
    return status.account?.creditsLeft
  }

  private async submitMore() {
    if (Date.now() < this.backoffUntil) return
    const limit = Math.min(Math.max(this.state.options.concurrency ?? 2, 1), 5)
    let room = limit - this.counts().submitted
    for (const job of Object.values(this.state.jobs)) {
      if (room <= 0 || this.phase !== "running") return
      if (job.status !== "todo") continue
      const left = await this.credits().catch(() => undefined)
      const floor = this.state.options.minCredits ?? 200
      if (left !== undefined && left < floor) {
        this.waitingFor = `Suno has ${left} credits left, under this batch's floor of ${floor}. Add credits or lower minCredits, then start it again.`
        this.log("paused: low credits", left)
        this.phase = "pausing"
        return
      }
      try {
        const params = {
          ...job,
          channel: job.channel ?? this.state.options.channel,
          workspace: job.workspace ?? this.state.options.workspace,
          wait: false,
          waitForUserMs: 120_000
        }
        const made = (job.mode ?? "create") === "create"
          ? await createSongs(this.bridge, params)
          : await coverSong(this.bridge, { ...params, from: job.from!, kind: job.mode as CoverKind })
        const ids = (made as { clipIds?: string[] }).clipIds ?? []
        Object.assign(job, { status: "submitted", clipIds: ids, submittedAt: now() })
        delete job.error
        this.waitingFor = undefined
        this.save()
        this.log("submitted", job.name, ids.join(" "))
        room--
      } catch (error) {
        const text = message(error)
        this.noteError(`submit ${job.name}: ${text}`)
        if (NEEDS_USER.test(text)) {
          this.waitingFor = text.split("\n")[0]
          this.backoffUntil = Date.now() + 60_000
          return
        }
        if (CONNECTION.test(text)) {
          this.backoffUntil = Date.now() + 30_000
          return
        }
        job.attempts = (job.attempts ?? 0) + 1
        if (PERMANENT.test(text) || job.attempts >= MAX_ATTEMPTS) {
          job.status = "failed"
          job.error = text.slice(0, 500)
        }
        this.save()
      }
    }
  }
}

const batches = new Map<string, SunoBatch>()

function batchFor(bridge: Bridge, folder: string, create: boolean) {
  const path = resolveFolder(folder)
  let batch = batches.get(path)
  if (!batch) {
    if (!create && !fs.existsSync(join(path, "state.json"))) throw new Error(`No Suno batch in ${path}.`)
    batch = new SunoBatch(path, bridge)
    batches.set(path, batch)
  }
  return batch
}

export async function startSunoBatch(
  bridge: Bridge,
  params: SunoBatchOptions & { folder: string; jobs?: SunoBatchJob[]; jobsFile?: string; retryFailed?: boolean }
) {
  const jobs = [...(params.jobs ?? []), ...(params.jobsFile ? readSunoJobsFile(params.jobsFile) : [])]
  const batch = batchFor(bridge, params.folder, true)
  if (!jobs.length && !Object.keys(batch.state.jobs).length) {
    throw new Error("Pass jobs or jobsFile: this folder has no batch to resume.")
  }
  const { folder, jobs: _jobs, jobsFile: _file, retryFailed, ...options } = params
  batch.merge(jobs, options, Boolean(retryFailed))
  batch.start()
  return {
    ...batch.summary(),
    note:
      "Runs in the background in this Claude session's MCP server, one Create at a time in Browse Hack's Suno tab. " +
      "Check it with suno_batch_status (waitMs waits). If this session ends, start it again on the same folder to resume."
  }
}

export async function sunoBatchStatus(bridge: Bridge, params: { folder: string; waitMs?: number; details?: boolean }) {
  const batch = batchFor(bridge, params.folder, false)
  if (params.waitMs) await batch.waitForEnd(params.waitMs)
  return batch.summary(params.details)
}

export function pauseSunoBatch(bridge: Bridge, params: { folder: string }) {
  const batch = batchFor(bridge, params.folder, false)
  batch.pause()
  return {
    ...batch.summary(),
    note: "No new songs are sent. The ones already in Suno finish and are recorded, then the batch stops. Start it again to resume."
  }
}
