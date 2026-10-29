// Midjourney batches: hundreds of prompts from one tool call. A batch keeps a
// few jobs in Midjourney at a time, waits for each, and saves its images as
// <name>-<index>.png in the batch folder.
//
// It runs in this server process, in the background, and writes every step to
// <folder>/state.json. A lost extension (Chrome closed or restarted, the
// computer asleep) only pauses it: calls time out, are retried without
// counting against the job, and jobs already in Midjourney are picked up
// again. Starting a batch on the same folder resumes it, also after this
// process ends.

import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

import type { Bridge } from "./bridge.js"
import { toSource } from "./sources.js"

export interface BatchJobInput {
  name: string
  prompt: string
  imagePrompts?: string[]
  styleReferences?: string[]
  omniReferences?: string[]
  extraFlags?: string
}

export interface BatchOptions {
  mode?: "relaxed" | "fast" | "turbo"
  private?: boolean
  extraFlags?: string
  concurrency?: number
}

type Status = "todo" | "submitted" | "completed" | "downloaded" | "failed"

interface JobState extends BatchJobInput {
  status: Status
  jobId?: string
  sentPrompt?: string
  // Midjourney refusals and failed renders; connection trouble doesn't count.
  attempts?: number
  downloadAttempts?: number
  percentage?: number
  files?: string[]
  error?: string
  submittedAt?: string
  completedAt?: string
}

interface BatchState {
  options: BatchOptions
  jobs: Record<string, JobState>
}

// The env var is for tests.
const POLL_MS = Number(process.env.BROWSE_HACK_BATCH_POLL_MS) || 15_000
const SUBMIT_TIMEOUT_MS = 5 * 60_000
const STATUS_TIMEOUT_MS = 60_000
const DOWNLOAD_TIMEOUT_MS = 3 * 60_000
const MAX_ATTEMPTS = 4
const MAX_DOWNLOAD_ATTEMPTS = 5
const DEFAULT_CONCURRENCY = 6
const MAX_CONCURRENCY = 12
const NAME = /^[\w.-]{1,120}$/

// The extension or Chrome went away, or the call took too long: wait, then retry.
const CONNECTION = /isn't connected|disconnected|timed out|lost the connection|took too long|couldn't reach|failed to fetch|network/i
// Someone has to act first (sign in, pick a profile); retried every minute.
const NEEDS_USER = /isn't signed in|sign in to midjourney|chrome profiles|choose|use_profile/i
// Midjourney is busy: wait longer, without counting an attempt.
const BUSY = /queue|concurren|too many|rate.?limit|slow down|\b429\b|try again in a minute/i
// The prompt or its images can't work: fail the job right away.
const PERMANENT = /moderat|banned|blocked|not allowed|community guidelines|invalid|unrecogni|unknown (parameter|argument|flag|option)|not compatible|file not found|only png|must be under|isn't a url/i

const now = () => new Date().toISOString()
const sleep = (ms: number, wake?: Promise<void>) =>
  Promise.race([new Promise<void>((r) => setTimeout(r, ms)), wake ?? new Promise<void>(() => {})])
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function resolveFolder(input: string) {
  const trimmed = input.trim()
  const path = trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : trimmed
  if (!isAbsolute(path)) throw new Error(`folder must be an absolute path, got "${input}".`)
  return path
}

const isLocalRelative = (value: string) =>
  !/^(https?:|file:|mj:|~\/)/i.test(value) && !isAbsolute(value) && !/^\d{3,}$/.test(value)

/** Jobs from a JSON file: an array, or { jobs: [...] }. Relative image paths are relative to the file. */
export function readJobsFile(file: string): BatchJobInput[] {
  const path = resolveFolder(file)
  const data = JSON.parse(fs.readFileSync(path, "utf8"))
  const jobs: BatchJobInput[] = Array.isArray(data) ? data : data?.jobs
  if (!Array.isArray(jobs)) throw new Error(`${path} must hold an array of jobs, or { "jobs": [...] }.`)
  const fix = (refs?: string[]) =>
    refs?.map((ref) => (typeof ref === "string" && isLocalRelative(ref) ? resolve(dirname(path), ref) : ref))
  return jobs.map((job) => ({
    ...job,
    imagePrompts: fix(job.imagePrompts),
    styleReferences: fix(job.styleReferences),
    omniReferences: fix(job.omniReferences)
  }))
}

class Batch {
  readonly statePath: string
  private readonly logPath: string
  private readonly lockPath: string
  private readonly downloadFolder: string
  state: BatchState
  phase: "running" | "pausing" | "paused" | "stopped" | "done" = "stopped"
  startedAt?: string
  private recentErrors: string[] = []
  private waitingFor?: string
  private backoffUntil = 0
  private stopNow = false
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
    this.state = fs.existsSync(this.statePath)
      ? JSON.parse(fs.readFileSync(this.statePath, "utf8"))
      : { options: {}, jobs: {} }
    this.state.options ??= {}
    for (const [name, job] of Object.entries(this.state.jobs)) job.name ??= name
    // Chrome saves only inside its Downloads folder; files saved elsewhere are moved here.
    const rel = relative(join(homedir(), "Downloads"), folder)
    this.downloadFolder =
      rel && !rel.startsWith("..") && !isAbsolute(rel)
        ? rel
        : `browse-hack-batches/${basename(folder)}-${createHash("sha1").update(folder).digest("hex").slice(0, 8)}`
  }

  private save() {
    // Write, then rename: stopping at any moment never leaves a half-written file.
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

  /** Adds new jobs and updates ones not sent yet; sent and finished jobs keep their state. */
  merge(jobs: BatchJobInput[], options: BatchOptions, retryFailed: boolean) {
    const names = new Set<string>()
    for (const job of jobs) {
      if (typeof job?.name !== "string" || !NAME.test(job.name)) {
        throw new Error(`Job name "${job?.name}" must be 1-120 letters, digits, dots, dashes or underscores.`)
      }
      if (typeof job.prompt !== "string" || !job.prompt.trim()) throw new Error(`Job ${job.name} has no prompt.`)
      if (names.has(job.name)) throw new Error(`Two jobs are named ${job.name}.`)
      names.add(job.name)
    }
    for (const job of jobs) {
      const existing = this.state.jobs[job.name]
      if (!existing) this.state.jobs[job.name] = { ...job, status: "todo" }
      else if (existing.status === "todo") Object.assign(existing, job)
    }
    if (retryFailed) {
      for (const job of Object.values(this.state.jobs)) {
        if (job.status !== "failed") continue
        // Jobs that rendered but couldn't be saved only need the download again.
        job.status = job.jobId && job.error?.startsWith("download:") ? "completed" : "todo"
        job.attempts = 0
        job.downloadAttempts = 0
        delete job.error
      }
    }
    const given = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined))
    this.state.options = { ...this.state.options, ...given }
    this.save()
  }

  counts() {
    const counts: Record<Status, number> = { todo: 0, submitted: 0, completed: 0, downloaded: 0, failed: 0 }
    for (const job of Object.values(this.state.jobs)) counts[job.status]++
    return counts
  }

  summary(details = false) {
    const jobs = Object.values(this.state.jobs)
    const counts = this.counts()
    return {
      folder: this.folder,
      state: this.phase,
      startedAt: this.startedAt,
      total: jobs.length,
      ...counts,
      ...(this.waitingFor ? { waitingFor: this.waitingFor } : {}),
      inMidjourney: jobs
        .filter((j) => j.status === "submitted")
        .map((j) => ({ name: j.name, jobId: j.jobId, since: j.submittedAt, percentage: j.percentage })),
      failedJobs: jobs.filter((j) => j.status === "failed").map((j) => ({ name: j.name, error: j.error })),
      recentErrors: this.recentErrors,
      ...(details ? { jobs } : {}),
      files: `${this.folder}/<name>-<index>.png`,
      log: this.logPath
    }
  }

  /** Waits until the batch stops running or `ms` passes. */
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

  pause(now: boolean) {
    if (this.phase !== "running" && this.phase !== "pausing") return
    this.phase = "pausing"
    this.stopNow ||= now
    this.log(now ? "stop requested" : "pause requested: finishing the jobs already in Midjourney")
    this.wakeUp?.()
  }

  start() {
    if (this.phase === "running" || this.phase === "pausing") return
    this.lock()
    this.phase = "running"
    this.stopNow = false
    this.startedAt = now()
    this.waitingFor = undefined
    this.backoffUntil = 0
    if (process.platform === "darwin") {
      // Keeps the Mac from sleeping while this process runs the batch.
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
        const left = counts.todo + counts.submitted + counts.completed
        if (this.phase === "running" && left === 0) this.phase = "done"
        else if (this.phase === "pausing" || this.phase === "running") this.phase = left ? "paused" : "done"
        this.log(this.phase.toUpperCase(), JSON.stringify(counts))
        this.finished.forEach((done) => done())
      })
  }

  // One process at a time per folder, across Claude sessions too.
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
      if (alive) {
        throw new Error(
          `Another Claude session (process ${holder}) is running this batch. Check it with midjourney_batch_status there, or pause it first.`
        )
      }
    }
    fs.writeFileSync(this.lockPath, String(process.pid))
  }

  private async run() {
    for (;;) {
      if (this.stopNow) return
      const jobs = Object.values(this.state.jobs)
      for (const job of jobs.filter((j) => j.status === "completed")) {
        if (this.stopNow) return
        await this.download(job)
      }
      await this.poll(jobs.filter((j) => j.status === "submitted"))
      if (this.phase === "running") await this.submitMore()

      const counts = this.counts()
      const busy = counts.submitted + counts.completed
      if (busy === 0 && (counts.todo === 0 || this.phase === "pausing")) return
      await sleep(POLL_MS, new Promise<void>((r) => (this.wakeUp = r)))
    }
  }

  private async call(method: string, params: unknown, timeoutMs: number) {
    try {
      const result = await this.bridge.call(method, params, timeoutMs)
      this.waitingFor = undefined
      return result as any
    } catch (error) {
      const text = message(error)
      if (NEEDS_USER.test(text)) this.waitingFor = text.split("\n")[0]
      throw error
    }
  }

  private async submitMore() {
    if (Date.now() < this.backoffUntil) return
    const limit = Math.min(Math.max(this.state.options.concurrency ?? DEFAULT_CONCURRENCY, 1), MAX_CONCURRENCY)
    let room = limit - this.counts().submitted
    for (const job of Object.values(this.state.jobs)) {
      if (room <= 0 || this.phase !== "running") return
      if (job.status !== "todo") continue
      try {
        const { mode, private: stealth, extraFlags } = this.state.options
        const result = await this.call(
          "midjourney.generate",
          {
            prompt: job.prompt,
            extraFlags: [extraFlags, job.extraFlags].filter(Boolean).join(" ") || undefined,
            imagePrompts: await Promise.all((job.imagePrompts ?? []).map((v) => toSource(v))),
            styleReferences: await Promise.all(
              (job.styleReferences ?? []).map((v) => toSource(v, { allowStyleCode: true }))
            ),
            omniReferences: await Promise.all((job.omniReferences ?? []).map((v) => toSource(v))),
            mode: mode ?? "relaxed",
            private: stealth,
            wait: false
          },
          SUBMIT_TIMEOUT_MS
        )
        Object.assign(job, {
          status: "submitted",
          jobId: result.jobId,
          sentPrompt: result.prompt,
          submittedAt: now(),
          percentage: 0
        })
        delete job.error
        this.save()
        this.log("submitted", job.name, result.jobId)
        room--
      } catch (error) {
        const text = message(error)
        this.noteError(`submit ${job.name}: ${text}`)
        if (CONNECTION.test(text) || NEEDS_USER.test(text)) {
          // Not the job's fault. (A submit cut off after Midjourney took it can run twice.)
          this.backoffUntil = Date.now() + (NEEDS_USER.test(text) ? 60_000 : 30_000)
          return
        }
        if (BUSY.test(text) && !PERMANENT.test(text)) {
          this.backoffUntil = Date.now() + 90_000
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

  private async poll(jobs: JobState[]) {
    if (!jobs.length) return
    const ids = jobs.map((j) => j.jobId!)
    let statuses: { id: string; status?: string; percentage?: number }[]
    try {
      statuses = (await this.call("midjourney.jobStatuses", { jobIds: ids }, STATUS_TIMEOUT_MS)) ?? []
    } catch (error) {
      const text = message(error)
      if (!/unknown method/i.test(text)) return this.noteError(`status: ${text}`)
      // An older extension: one call per job.
      statuses = []
      for (const id of ids) {
        try {
          const one = await this.call("midjourney.jobStatus", { jobId: id }, STATUS_TIMEOUT_MS)
          statuses.push({ id, status: one.status, percentage: one.percentage })
        } catch (e) {
          return this.noteError(`status: ${message(e)}`)
        }
      }
    }
    for (const job of jobs) {
      const status = statuses.find((s) => s.id === job.jobId)
      if (!status) continue
      if (typeof status.percentage === "number") job.percentage = status.percentage
      if (status.status === "completed") {
        job.status = "completed"
        job.completedAt = now()
        this.log("completed", job.name, job.jobId)
      } else if (["error", "failed", "failure", "cancelled", "canceled"].includes(status.status ?? "")) {
        job.attempts = (job.attempts ?? 0) + 1
        job.error = `Midjourney ${status.status} on job ${job.jobId}`
        // Midjourney errors are often passing; send it again unless it keeps failing.
        job.status = job.attempts >= MAX_ATTEMPTS ? "failed" : "todo"
        this.noteError(`${job.name}: ${job.error}`)
      }
    }
    this.save()
  }

  private async download(job: JobState) {
    try {
      const result = await this.call(
        "midjourney.downloadImages",
        { jobId: job.jobId, folder: this.downloadFolder, name: job.name },
        DOWNLOAD_TIMEOUT_MS
      )
      const files: string[] = []
      for (const file of (result?.files ?? []) as string[]) {
        const target = join(this.folder, basename(file))
        if (resolve(file) !== target) moveFile(file, target)
        files.push(basename(target))
      }
      if (!files.length) throw new Error("no files were saved")
      Object.assign(job, { status: "downloaded", files })
      delete job.error
      this.save()
      this.log("downloaded", job.name, files.join(" "))
    } catch (error) {
      const text = message(error)
      this.noteError(`download ${job.name}: ${text}`)
      // Not on the CDN yet, or the extension went away: try again on the next round.
      if (CONNECTION.test(text) || NEEDS_USER.test(text) || /cdn yet/i.test(text)) return
      job.downloadAttempts = (job.downloadAttempts ?? 0) + 1
      if (job.downloadAttempts >= MAX_DOWNLOAD_ATTEMPTS) {
        job.status = "failed"
        job.error = `download: ${text.slice(0, 480)}`
      }
      this.save()
    }
  }
}

function moveFile(from: string, to: string) {
  try {
    fs.renameSync(from, to)
  } catch (error: any) {
    if (error?.code !== "EXDEV") throw error
    fs.copyFileSync(from, to)
    fs.unlinkSync(from)
  }
}

const batches = new Map<string, Batch>()

function batchFor(bridge: Bridge, folder: string, create: boolean) {
  const path = resolveFolder(folder)
  let batch = batches.get(path)
  if (!batch) {
    if (!create && !fs.existsSync(join(path, "state.json"))) throw new Error(`No batch in ${path}.`)
    batch = new Batch(path, bridge)
    batches.set(path, batch)
  }
  return batch
}

export async function startBatch(
  bridge: Bridge,
  params: BatchOptions & { folder: string; jobs?: BatchJobInput[]; jobsFile?: string; retryFailed?: boolean }
) {
  const jobs = [...(params.jobs ?? []), ...(params.jobsFile ? readJobsFile(params.jobsFile) : [])]
  const batch = batchFor(bridge, params.folder, true)
  if (!jobs.length && !Object.keys(batch.state.jobs).length) {
    throw new Error("Pass jobs or jobsFile: this folder has no batch to resume.")
  }
  // Fails early when the extension isn't connected, or is signed out, or a profile must be picked.
  const auth: any = await bridge.call("auth.status", {}, 30_000).catch((error) => {
    if (/unknown method/i.test(message(error))) return { signedIn: true }
    throw error
  })
  if (!auth?.signedIn) {
    throw new Error(
      "Browse Hack isn't signed in to Mediamake. Ask the user to sign in from the Browse Hack popup " +
        "(or call sign_in_to_mediamake), then start the batch again."
    )
  }
  batch.merge(jobs, params, Boolean(params.retryFailed))
  batch.start()
  return {
    ...batch.summary(),
    note:
      "Runs in the background in this Claude session's MCP server. Check it with midjourney_batch_status (waitMs waits for it). " +
      "If this session ends, run midjourney_batch_start on the same folder to resume. Keep Chrome open with the extension."
  }
}

export async function batchStatus(
  bridge: Bridge,
  params: { folder: string; waitMs?: number; details?: boolean }
) {
  const batch = batchFor(bridge, params.folder, false)
  if (params.waitMs) await batch.waitForEnd(params.waitMs)
  return batch.summary(params.details)
}

export function pauseBatch(bridge: Bridge, params: { folder: string; now?: boolean }) {
  const batch = batchFor(bridge, params.folder, false)
  batch.pause(Boolean(params.now))
  return {
    ...batch.summary(),
    note: params.now
      ? "Stopped. Jobs already in Midjourney keep rendering and are saved when the batch is started again."
      : "No new jobs are sent. The ones already in Midjourney finish and are saved, then the batch stops. Start it again to resume."
  }
}
