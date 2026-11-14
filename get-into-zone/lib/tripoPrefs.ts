// Browse Hack's Tripo settings, in chrome.storage.local: the library inbox
// models download to (the MCP server passes it on from ~/.mediamake/config.json)
// and the last generate jobs.

export const TRIPO_PREFS_KEY = "tripoPrefs"
const MAX_JOBS = 20

export interface TripoJobRecord {
  projectId?: string
  operatorId?: string
  mode?: "text" | "image"
  prompt?: string
  model?: string
  price?: number
  creditsBefore?: number
  startedAt: string
  status?: string
  finishedAt?: string
}

export interface TripoPrefs {
  /** The library inbox, relative to Downloads. */
  inboxFolder: string
  jobs: TripoJobRecord[]
}

export const DEFAULT_TRIPO_PREFS: TripoPrefs = {
  inboxFolder: "_INBOX",
  jobs: []
}

const text = (value: unknown, max = 500) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined)

export function readTripoPrefs(value: unknown): TripoPrefs {
  const v = (value && typeof value === "object" ? value : {}) as Partial<TripoPrefs>
  return {
    inboxFolder: text(v.inboxFolder) ?? DEFAULT_TRIPO_PREFS.inboxFolder,
    jobs: Array.isArray(v.jobs)
      ? v.jobs.filter((j): j is TripoJobRecord => Boolean(j && typeof j === "object" && typeof j.startedAt === "string")).slice(-MAX_JOBS)
      : []
  }
}

/** The jobs with one added or updated (by project id, else operator id). */
export function withJob(jobs: TripoJobRecord[], job: TripoJobRecord) {
  const same = (j: TripoJobRecord) => (job.projectId && j.projectId === job.projectId) || (job.operatorId && j.operatorId === job.operatorId)
  const i = jobs.findIndex(same)
  const next = i >= 0 ? jobs.map((j, k) => (k === i ? { ...j, ...job } : j)) : [...jobs, job]
  return next.slice(-MAX_JOBS)
}

export async function loadTripoPrefs() {
  const stored = await chrome.storage.local.get(TRIPO_PREFS_KEY)
  return readTripoPrefs(stored[TRIPO_PREFS_KEY])
}

let chain: Promise<unknown> = Promise.resolve()

/** Read-modify-write in turn, so two updates at once are both kept. */
export function updateTripoPrefs(change: (prefs: TripoPrefs) => Partial<TripoPrefs>) {
  const next = chain.then(async () => {
    const prefs = await loadTripoPrefs()
    const updated = readTripoPrefs({ ...prefs, ...change(prefs) })
    await chrome.storage.local.set({ [TRIPO_PREFS_KEY]: updated })
    return updated
  })
  chain = next.catch(() => undefined)
  return next
}
