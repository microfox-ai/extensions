// Phrasly's AI humanizer for the MCP server (phrasly_humanize, phrasly_settings,
// phrasly_status) and the popup's Phrasly tab. Used only when the user asks to
// humanize text or to use Phrasly.
//
// Everything happens one job at a time in Browse Hack's own Phrasly tab
// (https://phrasly.ai/dashboard/humanizer), opened in the background the first
// time and reused, so the user's own Phrasly tabs are never touched. A run is
// what a person does by hand: paste the text, press Humanize, wait for the
// output to settle, then press "Next draft" for each further draft (up to
// five). The output is watched from here (contents/phrasly.ts answers what the
// page shows at once), since a background tab's own timers are slowed.
//
// Pacing, learned on the live site (olympus-bridge-daemon/humanizer.mjs):
// one job a minute, start to start, whatever asks; a job may take 300 s.
// If Phrasly shows a captcha, nothing is pressed: the tab comes forward and
// the call answers needsUser: "captcha". The user verifies in the tab, and
// the next call with the same text picks up where this one stopped, with the
// drafts made so far.
//
// Settings: the page's own are read on the first run and kept as the defaults
// (lib/phraslyPrefs.ts). A run's overrides are put on the page for that run
// and put back after it, so Phrasly's saved settings never change.

import { HUMANIZER_URL, PHRASLY } from "./phrasly/selectors"
import {
  MAX_DRAFTS,
  addDraft,
  checkWords,
  startWatch,
  watchStep,
  type PhraslyDraft,
  type WatchObservation
} from "./phrasly/text"
import {
  loadPhraslyPrefs,
  loadUsage,
  readSettings,
  recordRun,
  savePhraslyPrefs,
  settingsFor,
  settingsToChange,
  ultraWarning,
  usageToday,
  type PhraslyDefaults,
  type PhraslySettings,
  type SettingKey
} from "./phraslyPrefs"
import { openTab, waitForTabLoad } from "./tabs"

/**
 * Browse Hack's Phrasly tab, in chrome.storage.local: kept across extension
 * updates (session storage is cleared by them, which would leave the old tab
 * behind and open another one each time), forgotten when Chrome starts.
 */
const WORKER_KEY = "phraslyWorkerTab"
/** The run in progress, or the last one: its drafts so far, for resuming. */
const JOB_KEY = "phraslyJob"
/** When the next job may start (ms). */
const PACE_KEY = "phraslyNextStart"
/** Settings a run changed on the page and hasn't put back yet (a captcha cut it short). */
const RESTORE_KEY = "phraslyRestore"
/** The last captcha seen. */
const CAPTCHA_KEY = "phraslyCaptcha"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type PageState = {
  ok?: boolean
  ready?: boolean
  url?: string
  title?: string
  onHumanizer?: boolean
  signedIn?: boolean
  captcha?: string | null
  busy?: boolean
  draft?: number | null
  /** Dialogs Browse Hack opened on this page load (see tidyTab). */
  dialogsOpened?: number
}

interface Job {
  /** The text and the settings it runs with: a later call resumes only the same pair. */
  key: string
  text: string
  words: number
  want: number
  drafts: PhraslyDraft[]
  settings: PhraslySettings
  startedAt: number
  updatedAt: number
  done: boolean
  stoppedBy?: string
}

// --- Tabs ----------------------------------------------------------------------------

async function ping(tabId: number): Promise<PageState | null> {
  try {
    return await chrome.tabs.sendMessage(tabId, { action: "giz-phrasly-ping" })
  } catch {
    return null
  }
}

async function livePhraslyTab(id: unknown) {
  if (typeof id !== "number") return undefined
  const tab = await chrome.tabs.get(id).catch(() => undefined)
  return tab?.url?.startsWith(PHRASLY) ? tab : undefined
}

/** Waits for the page to show either the humanizer, the sign-in page or a captcha. */
async function waitSettled(tabId: number, timeoutMs = 45_000) {
  const start = Date.now()
  let last: PageState | null = null
  while (Date.now() - start < timeoutMs) {
    last = await ping(tabId)
    if (last?.ok && last.ready && (last.captcha || last.signedIn === false || (last.onHumanizer && last.signedIn))) return last
    await sleep(500)
  }
  if (last?.ok) return last
  throw new Error(`phrasly.ai didn't finish loading in tab ${tabId}${last?.url ? ` (${last.url})` : ""}.`)
}

async function storedWorker() {
  return livePhraslyTab((await chrome.storage.local.get(WORKER_KEY))[WORKER_KEY])
}

/** Tab ids don't survive a Chrome restart: forget the old one then. */
export function initPhraslyBridge() {
  chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.remove(WORKER_KEY).catch(() => {})
  })
}

/** Browse Hack's own Phrasly tab on the humanizer, opened in the background the first time. */
async function workerTab() {
  let tab = await storedWorker()
  if (tab?.id && !(await ping(tab.id))) {
    // An extension update left the tab without its page script: reloading brings it back.
    await chrome.tabs.reload(tab.id).catch(() => {})
    await sleep(600)
    await waitForTabLoad(tab.id, 45_000).catch(() => {})
  }
  if (!tab?.id) {
    tab = await openTab(HUMANIZER_URL, false, true)
    if (!tab.id) throw new Error("Chrome didn't open a phrasly.ai tab.")
    await chrome.storage.local.set({ [WORKER_KEY]: tab.id })
  }
  const tabId = tab.id!
  // Chrome may discard a background tab it thinks is idle; this one keeps the drafts.
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {})
  let state = await waitSettled(tabId)
  if (!state.captcha && state.signedIn !== false && !state.onHumanizer) {
    await chrome.tabs.update(tabId, { url: HUMANIZER_URL })
    await sleep(600)
    await waitForTabLoad(tabId, 45_000).catch(() => {})
    state = await waitSettled(tabId)
  }
  return { tabId, state }
}

/**
 * A dialog opened in a background tab never finishes its opening animation
 * (Chrome runs no animation frames there), so it stays in the page, invisible,
 * after Done: it would pop up when the tab comes forward. A run that opened
 * one reloads the tab once it's done with the page.
 */
async function tidyTab(tabId: number) {
  const state = await ping(tabId)
  if (!state?.dialogsOpened) return
  await chrome.tabs.reload(tabId).catch(() => {})
  await sleep(600)
  await waitForTabLoad(tabId, 45_000).catch(() => {})
}

async function send<T = any>(tabId: number, msg: Record<string, unknown>, timeoutMs = 60_000): Promise<T> {
  const reply: any = await Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    sleep(timeoutMs).then(() => ({ ok: false, error: `The Phrasly tab took too long (${msg.action}).` }))
  ])
  if (!reply?.ok) throw new Error(reply?.error || "The Phrasly tab didn't answer. Reload it and try again.")
  return reply.result as T
}

async function focus(tabId: number) {
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => undefined)
  if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
}

// One job at a time, whoever asks.
let chain: Promise<unknown> = Promise.resolve()
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => {})
  return run
}

// --- What a run is doing, for phrasly_status ----------------------------------------------

let current: { step: string; since: number; words: number; draftsWanted: number; draftsDone: number; tabId?: number } | null = null
const step = (text: string) => {
  if (current) current = { ...current, step: text, since: Date.now() }
}

// --- Pacing ---------------------------------------------------------------------------------

async function nextStart() {
  return Number((await chrome.storage.session.get(PACE_KEY))[PACE_KEY]) || 0
}

/** Waits for the next start Phrasly's pacing allows, then books the one after. */
async function pace(gapSeconds: number) {
  const wait = (await nextStart()) - Date.now()
  if (wait > 0) {
    step(`waiting ${Math.ceil(wait / 1000)} s (one Phrasly job a minute)`)
    await sleep(wait)
  }
  await chrome.storage.session.set({ [PACE_KEY]: Date.now() + gapSeconds * 1000 })
}

// --- Asking the user ------------------------------------------------------------------------

async function needsCaptcha(tabId: number, detail: string, job?: Job, want?: number) {
  await focus(tabId)
  await chrome.storage.session.set({ [CAPTCHA_KEY]: { at: Date.now(), detail } })
  const drafts = job?.drafts ?? []
  return {
    ok: false,
    needsUser: "captcha" as const,
    message:
      `Phrasly is asking for a captcha ("${detail}"). Browse Hack brought its Phrasly tab to the front: ask the user to ` +
      `complete the check there (Browse Hack never solves one), then call phrasly_humanize again with the same text and ` +
      `settings to pick up where this stopped${drafts.length ? ` (${drafts.length} draft${drafts.length === 1 ? "" : "s"} kept)` : ""}.`,
    tabId,
    captcha: detail,
    drafts,
    ...(want ?? job?.want ? { draftsWanted: want ?? job?.want } : {})
  }
}

async function needsSignIn(tabId: number) {
  await focus(tabId)
  return {
    ok: false,
    needsUser: "signin" as const,
    message:
      "Phrasly isn't signed in in this Chrome profile. Browse Hack brought its Phrasly tab to the front: ask the user to " +
      "sign in there, then call phrasly_humanize again.",
    tabId
  }
}

// --- Settings ---------------------------------------------------------------------------------

type PageSettings = { settings: PhraslySettings; other?: Record<string, boolean>; notes: string[] }

const readPage = (tabId: number, deep: false | "cached" | "fresh") =>
  send<PageSettings>(tabId, { action: "giz-phrasly-read", deep }, 30_000)

type Applied = { before: PhraslySettings; changed: SettingKey[]; failed: string[]; captcha?: boolean }

const applyOnPage = (tabId: number, settings: PhraslySettings, keys: SettingKey[]) =>
  send<Applied>(tabId, { action: "giz-phrasly-apply", settings, keys }, 45_000)

/** Puts back what a run changed on the page; kept for later while a captcha shows. */
async function putBack(tabId: number, before: PhraslySettings) {
  const keys = (Object.keys(before) as SettingKey[]).filter((k) => before[k])
  if (!keys.length) {
    await chrome.storage.session.remove(RESTORE_KEY)
    return []
  }
  await chrome.storage.session.set({ [RESTORE_KEY]: { tabId, settings: before } })
  const r = await applyOnPage(tabId, before, keys).catch((e) => ({ before: {}, changed: [], failed: [message(e)], captcha: false }))
  if (r.captcha) return [`Phrasly's own settings (${keys.join(", ")}) are put back on the next call: a captcha showed.`]
  await chrome.storage.session.remove(RESTORE_KEY)
  return r.failed.length ? [`Couldn't put Phrasly's own ${keys.join(", ")} back (${r.failed.join("; ")}): check its settings by hand.`] : []
}

/** A run cut short left the page on its settings: put the page's own back first. */
async function restorePending(tabId: number) {
  const pending = (await chrome.storage.session.get(RESTORE_KEY))[RESTORE_KEY]
  if (!pending?.settings || pending.tabId !== tabId) {
    await chrome.storage.session.remove(RESTORE_KEY)
    return []
  }
  return putBack(tabId, readSettings(pending.settings))
}

async function storeDefaults(tabId: number) {
  const page = await readPage(tabId, "fresh")
  const defaults: PhraslyDefaults = {
    ...page.settings,
    ...(page.other && Object.keys(page.other).length ? { other: page.other } : {}),
    readAt: new Date().toISOString()
  }
  await savePhraslyPrefs({ defaults })
  return { defaults, notes: page.notes }
}

// --- Usage ---------------------------------------------------------------------------------------

async function usage() {
  const prefs = await loadPhraslyPrefs()
  const today = usageToday(await loadUsage(), Date.now())
  const warning = ultraWarning(today.ultraToday, prefs.ultraWarnAt)
  return { ...today, ultraWarnAt: prefs.ultraWarnAt, ...(warning ? { warning } : {}) }
}

// --- A run -----------------------------------------------------------------------------------------

type Started =
  | { started: true; before: string; beforeDraft: number | null; inWords: number; note: string }
  | { captcha: string }
  | { error: string }
  | { fallback: string }

/** Watches the output settle, asking the page what it shows once a second. */
async function watchRun(tabId: number, started: { before: string; beforeDraft: number | null; inWords: number }, timeoutMs: number, canRepress: boolean) {
  let state = startWatch(started, Date.now())
  let misses = 0
  for (;;) {
    await sleep(1000)
    let obs: WatchObservation
    try {
      obs = await send<WatchObservation>(tabId, { action: "giz-phrasly-observe" }, 15_000)
      misses = 0
    } catch (error) {
      if (!(await chrome.tabs.get(tabId).catch(() => undefined))) throw new Error("The Phrasly tab was closed during the run.")
      if (++misses >= 20) throw new Error(`The Phrasly tab stopped answering during the run (${message(error)}).`)
      continue
    }
    const next = watchStep(state, obs, Date.now(), { timeoutMs, canRepress })
    if (next.kind === "repress") await send(tabId, { action: "giz-phrasly-press" }).catch(() => {})
    if (next.kind === "wait" || next.kind === "repress") {
      state = next.state
      continue
    }
    return next
  }
}

const jobKey = (text: string, settings: PhraslySettings) => JSON.stringify([text.replace(/\s+/g, " ").trim(), readSettings(settings)])

async function loadJob(): Promise<Job | undefined> {
  return (await chrome.storage.session.get(JOB_KEY))[JOB_KEY]
}
const saveJob = (job: Job) => chrome.storage.session.set({ [JOB_KEY]: { ...job, updatedAt: Date.now() } })

export interface HumanizeParams {
  text: string
  /** 1..5 drafts of the text (default 3). */
  drafts?: number
  /** Overrides for this run only: model, mode, sentences. */
  settings?: PhraslySettings
}

export function humanize(p: HumanizeParams) {
  const text = String(p.text ?? "")
  const words = checkWords(text)
  if (!words.ok) return Promise.reject(new Error(words.error))
  const want = Math.min(Math.max(Math.round(Number(p.drafts) || 3), 1), MAX_DRAFTS)
  return exclusive(async () => {
    current = { step: "opening Browse Hack's Phrasly tab", since: Date.now(), words: words.words, draftsWanted: want, draftsDone: 0 }
    try {
      return await run(text, words.words, want, p.settings)
    } finally {
      current = null
    }
  })
}

async function run(text: string, words: number, want: number, overrides: unknown) {
  const prefs = await loadPhraslyPrefs()
  const notes: string[] = []
  const { tabId, state } = await workerTab()
  if (current) current.tabId = tabId
  const key = jobKey(text, settingsFor(prefs.defaults, overrides).wanted)
  const stored = await loadJob()
  const resumable = stored && stored.key === key && !stored.done ? stored : undefined
  if (state.captcha) return needsCaptcha(tabId, state.captcha, resumable, want)
  if (state.signedIn === false) return needsSignIn(tabId)
  await chrome.storage.session.remove(CAPTCHA_KEY)

  notes.push(...(await restorePending(tabId)))

  // The first run reads the page's own settings and keeps them as the defaults.
  let defaults = prefs.defaults
  let defaultsRead = false
  if (!defaults) {
    step("reading Phrasly's settings (first run)")
    const read = await storeDefaults(tabId)
    defaults = read.defaults
    defaultsRead = true
    notes.push(...read.notes)
  }
  const { wanted, overridden } = settingsFor(defaults, overrides)

  // Put the run's settings on the page where it has others.
  step("checking the settings")
  const page = await readPage(tabId, wanted.sentences ? "cached" : false)
  const keys = settingsToChange(page.settings, wanted)
  let restore: PhraslySettings = {}
  if (keys.length) {
    const applied = await applyOnPage(tabId, wanted, keys)
    if (applied.captcha) return needsCaptcha(tabId, (await ping(tabId))?.captcha || "a captcha", resumable, want)
    restore = applied.before
    if (Object.keys(restore).length) await chrome.storage.session.set({ [RESTORE_KEY]: { tabId, settings: restore } })
    if (applied.failed.length) {
      const back = await putBack(tabId, restore)
      await tidyTab(tabId)
      throw new Error(
        `A setting couldn't be put on Phrasly's page (${applied.failed.join("; ")}): nothing was humanized.${back.length ? ` ${back.join(" ")}` : ""} ` +
          "phrasly_settings with refresh shows what the page offers."
      )
    }
  }
  const used = (await readPage(tabId, wanted.sentences ? "cached" : false)).settings
  const pageDiffered = !defaultsRead && settingsToChange(page.settings, readSettings(defaults)).length > 0

  const job: Job =
    resumable ?? { key, text, words, want, drafts: [], settings: wanted, startedAt: Date.now(), updatedAt: Date.now(), done: false }
  const resumedWith = job.drafts.length
  job.want = want
  job.stoppedBy = undefined
  await saveJob(job)

  const timeoutMs = prefs.jobTimeoutSeconds * 1000
  let incomplete: string | undefined
  let fresh = job.drafts.length === 0
  while (job.drafts.length < want) {
    if (current) current.draftsDone = job.drafts.length
    const live = await ping(tabId)
    if (live?.captcha) {
      job.stoppedBy = "captcha"
      await saveJob(job)
      return needsCaptcha(tabId, live.captcha, job)
    }
    await pace(prefs.minGapSeconds)
    step(fresh ? "pasting the text and pressing Humanize" : `asking for draft ${job.drafts.length + 1}`)
    let started = await send<Started>(tabId, { action: fresh ? "giz-phrasly-humanize" : "giz-phrasly-draft", text }, 60_000)
    let repress = fresh
    if ("fallback" in started) {
      notes.push(`${started.fallback}: humanized it afresh for draft ${job.drafts.length + 1}`)
      started = await send<Started>(tabId, { action: "giz-phrasly-humanize", text }, 60_000)
      repress = true
    }
    if ("captcha" in started) {
      job.stoppedBy = "captcha"
      await saveJob(job)
      return needsCaptcha(tabId, started.captcha, job)
    }
    if ("error" in started) {
      incomplete = started.error
      break
    }
    if (!("started" in started)) break
    step(`waiting for draft ${job.drafts.length + 1} of ${want}`)
    const result = await watchRun(tabId, started, timeoutMs, repress)
    if (result.kind === "captcha") {
      job.stoppedBy = "captcha"
      await saveJob(job)
      return needsCaptcha(tabId, result.detail, job)
    }
    if (result.kind !== "done") {
      incomplete = result.kind === "refused" ? `Phrasly says: ${result.detail}` : result.detail
      break
    }
    job.drafts = addDraft(job.drafts, result.output, result.draft)
    fresh = false
    await recordRun(used.model)
    await saveJob(job)
  }

  step("putting Phrasly's own settings back")
  const back = await putBack(tabId, restore)
  notes.push(...back)
  await tidyTab(tabId)
  if (!job.drafts.length) throw new Error(`Phrasly gave no draft: ${incomplete ?? "nothing came back"}. Nothing was kept.`)
  job.done = !incomplete
  job.stoppedBy = incomplete ? "error" : undefined
  await saveJob(job)
  const drafts = job.drafts
  return {
    ok: true,
    wordsIn: words,
    draftsWanted: want,
    drafts,
    settingsUsed: used,
    defaults: readSettings(defaults),
    ...(overridden.length ? { overridden } : {}),
    pageSettingsRestored: back.length === 0,
    ...(defaultsRead ? { defaultsRead: "Phrasly's own settings were read on this first run and kept as the defaults (phrasly_settings)." } : {}),
    ...(pageDiffered ? { pageDiffered: "Phrasly's page had other settings than the stored defaults; this run used the defaults. phrasly_settings with refresh keeps the page's instead." } : {}),
    ...(resumedWith ? { resumed: `Picked up an earlier run of this text: ${resumedWith} draft${resumedWith === 1 ? "" : "s"} came from it.` } : {}),
    ...(incomplete ? { incomplete: `Stopped after ${job.drafts.length} of ${want} drafts: ${incomplete}` } : {}),
    ...(drafts.some((d) => d.sameAs) ? { repeats: "Some drafts repeat an earlier one word for word (sameAs)." } : {}),
    ...(await usage()),
    ...(notes.length ? { notes } : {})
  }
}

// --- Status and settings --------------------------------------------------------------------------

async function status() {
  const prefs = await loadPhraslyPrefs()
  const tab = await storedWorker()
  const page = tab?.id ? await ping(tab.id) : null
  const job = await loadJob()
  const lastCaptcha = (await chrome.storage.session.get(CAPTCHA_KEY))[CAPTCHA_KEY]
  const wait = (await nextStart()) - Date.now()
  return {
    tab: tab?.id
      ? { id: tab.id, url: page?.url ?? tab.url, signedIn: page?.signedIn ?? null, onHumanizer: page?.onHumanizer ?? null, answering: Boolean(page?.ok) }
      : null,
    captcha: page?.captcha ?? null,
    ...(page?.captcha ? { needsUser: "captcha", message: "Phrasly is asking for a captcha in Browse Hack's Phrasly tab: the user completes it there." } : {}),
    ...(lastCaptcha ? { lastCaptcha: { at: new Date(lastCaptcha.at).toISOString(), detail: lastCaptcha.detail } } : {}),
    job: current
      ? { running: true, step: current.step, forSeconds: Math.round((Date.now() - current.since) / 1000), words: current.words, draftsWanted: current.draftsWanted, draftsDone: current.draftsDone }
      : null,
    lastJob: job
      ? {
          words: job.words,
          draftsWanted: job.want,
          draftsDone: job.drafts.length,
          finished: job.done,
          ...(job.stoppedBy ? { stoppedBy: job.stoppedBy, resumable: !job.done } : {}),
          at: new Date(job.updatedAt).toISOString(),
          preview: `${job.text.slice(0, 80)}${job.text.length > 80 ? "…" : ""}`
        }
      : null,
    nextStartInSeconds: Math.max(0, Math.ceil(wait / 1000)),
    pacing: { minGapSeconds: prefs.minGapSeconds, jobTimeoutSeconds: prefs.jobTimeoutSeconds },
    defaults: prefs.defaults ?? null,
    ...(await usage())
  }
}

async function settings(params: { refresh?: boolean }) {
  if (!params.refresh) {
    const prefs = await loadPhraslyPrefs()
    return {
      defaults: prefs.defaults ?? null,
      note: prefs.defaults
        ? "Read off Phrasly's page on the first run. Every run uses these unless the call overrides one; refresh: true reads them from the page again."
        : "Not read yet: the first phrasly_humanize run reads them off Phrasly's page, or call this with refresh: true."
    }
  }
  return exclusive(async () => {
    const { tabId, state } = await workerTab()
    if (state.captcha) return needsCaptcha(tabId, state.captcha)
    if (state.signedIn === false) return needsSignIn(tabId)
    const back = await restorePending(tabId)
    const read = await storeDefaults(tabId)
    await tidyTab(tabId)
    return { defaults: read.defaults, refreshed: true, ...(read.notes.length || back.length ? { notes: [...back, ...read.notes] } : {}) }
  })
}

// --- The popup's Phrasly tab ---------------------------------------------------------------------

export function handlePhraslyUi(request: any, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) {
  const reply = (work: Promise<unknown>) => {
    work.then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: message(error) })
    )
    return true
  }
  switch (request.op) {
    case "status":
      return reply(status())
    case "refresh":
      return reply(settings({ refresh: true }))
    case "show":
      return reply(
        (async () => {
          const { tabId } = await workerTab()
          await focus(tabId)
          return { tabId }
        })()
      )
  }
  sendResponse({ ok: false, error: `Unknown request: ${request.op}` })
  return false
}

// --- The MCP server's methods ----------------------------------------------------------------------

export const phraslyCommands: Record<string, (params: any) => Promise<unknown>> = {
  "phrasly.humanize": async (params) => humanize(params as HumanizeParams),
  "phrasly.settings": async (params) => settings(params ?? {}),
  "phrasly.status": async () => status(),
  /** Read-only: what the page shows now (fields, controls, dialogs), for fixing lib/phrasly/selectors.ts. */
  "phrasly.probe": async ({ open, selector }) =>
    exclusive(async () => {
      const { tabId } = await workerTab()
      return send(tabId, { action: "giz-phrasly-probe", open, selector }, 30_000)
    })
}
