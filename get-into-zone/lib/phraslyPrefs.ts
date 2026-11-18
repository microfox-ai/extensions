// Browse Hack's Phrasly settings and the day's runs, in chrome.storage.local.
//
// The humanizer's settings (model, mode, sentence length) are read off
// Phrasly's page the first time Browse Hack uses it and kept here as the
// defaults every run uses. A call may override them for that one run: the
// page is switched for the run and switched back after it, so Phrasly's own
// saved settings never change. `phrasly.settings` with refresh reads them
// from the page again.
//
// Runs are counted per local day: Phrasly may move a plan off Ultra after
// about 50 Ultra documents in a day (its fair-use terms), so Browse Hack
// warns from 40. Every draft is counted as a document.
//
// No imports, so `npm test` runs on it as is (lib/phrasly.test.mjs).

export const PHRASLY_PREFS_KEY = "phraslyPrefs"
export const PHRASLY_USAGE_KEY = "phraslyUsage"

/** The Ultra model's modes, as the Rewrite approach slider names its steps 1..5. */
export const MODES = ["Gentle", "Light", "Balanced", "Strong", "Max"] as const

export interface PhraslySettings {
  /** The model as its button names it ("Phrasly Ultra"). */
  model?: string
  /** The Rewrite approach slider's step: Gentle, Light, Balanced, Strong or Max. */
  mode?: string
  /** Sentence length in Text settings: Longer or Shorter. */
  sentences?: string
}

export type SettingKey = keyof PhraslySettings
export const SETTING_KEYS: SettingKey[] = ["model", "mode", "sentences"]

export interface PhraslyDefaults extends PhraslySettings {
  /** Text settings' switches (commas, grammar…) as the page had them: shown, never changed. */
  other?: Record<string, boolean>
  /** When they were read off the page (ISO). */
  readAt: string
}

export interface PhraslyPrefs {
  /** The page's settings as first read; unset until the first run. */
  defaults?: PhraslyDefaults
  /** One job a minute, start to start (learned on the live site, Oct 2026). */
  minGapSeconds: number
  /** How long one humanization or draft may take to appear and settle. */
  jobTimeoutSeconds: number
  /** Warn once this many Ultra documents were made today. */
  ultraWarnAt: number
}

export const DEFAULT_PHRASLY_PREFS: PhraslyPrefs = {
  minGapSeconds: 60,
  jobTimeoutSeconds: 300,
  ultraWarnAt: 40
}

/** Phrasly's own fair-use line: about this many Ultra documents a day. */
export const ULTRA_DAILY_LIMIT = 50

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const num = (v: unknown, min: number, max: number, fallback: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), min), max) : fallback

/** A mode by name in any case, or by its step 1..5: "max", "MAX" and 5 are "Max". */
export function modeName(value: unknown) {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MODES.length) return MODES[value - 1]
  const s = str(value)
  if (!s) return undefined
  if (/^\d+$/.test(s)) return modeName(Number(s))
  return MODES.find((m) => m.toLowerCase() === s.toLowerCase()) ?? s
}

/** Sentence length by name in any case: "shorter" is "Shorter". */
export function sentencesName(value: unknown) {
  const s = str(value)
  if (!s) return undefined
  return /^(longer|shorter)$/i.test(s) ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s
}

/** Settings as a call or the store gives them, tidied; unknown keys dropped. */
export function readSettings(value: unknown): PhraslySettings {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  const out: PhraslySettings = {}
  const model = str(v.model)
  const mode = modeName(v.mode ?? v.strength)
  const sentences = sentencesName(v.sentences)
  if (model) out.model = model
  if (mode) out.mode = mode
  if (sentences) out.sentences = sentences
  return out
}

export function readPhraslyPrefs(value: unknown): PhraslyPrefs {
  const v = (value && typeof value === "object" ? value : {}) as Record<string, any>
  const prefs: PhraslyPrefs = {
    minGapSeconds: num(v.minGapSeconds, 0, 600, DEFAULT_PHRASLY_PREFS.minGapSeconds),
    jobTimeoutSeconds: num(v.jobTimeoutSeconds, 30, 900, DEFAULT_PHRASLY_PREFS.jobTimeoutSeconds),
    ultraWarnAt: num(v.ultraWarnAt, 1, 500, DEFAULT_PHRASLY_PREFS.ultraWarnAt)
  }
  const d = v.defaults
  if (d && typeof d === "object" && typeof d.readAt === "string") {
    const other: Record<string, boolean> = {}
    if (d.other && typeof d.other === "object") {
      for (const [k, on] of Object.entries(d.other)) if (typeof on === "boolean" && k.trim()) other[k.trim()] = on
    }
    prefs.defaults = { ...readSettings(d), ...(Object.keys(other).length ? { other } : {}), readAt: d.readAt }
  }
  return prefs
}

const same = (a?: string, b?: string) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase()

/**
 * What a run uses: the stored defaults with the call's overrides on top, and
 * which settings the call changed from the defaults.
 */
export function settingsFor(defaults: PhraslySettings | undefined, overrides: unknown) {
  const base = readSettings(defaults ?? {})
  const over = readSettings(overrides)
  const wanted: PhraslySettings = { ...base, ...over }
  const overridden = SETTING_KEYS.filter((k) => over[k] !== undefined && !same(over[k], base[k]))
  return { wanted, overridden }
}

/** The settings where the page has something else than wanted (only those wanted). */
export function settingsToChange(page: PhraslySettings, wanted: PhraslySettings) {
  return SETTING_KEYS.filter((k) => wanted[k] !== undefined && !same(page[k], wanted[k]))
}

// --- The day's runs ----------------------------------------------------------------

export interface PhraslyRun {
  /** When the output came back (ms). */
  at: number
  /** Made on an Ultra model. */
  ultra: boolean
}

const DAY = 24 * 60 * 60 * 1000

export function readUsage(value: unknown): PhraslyRun[] {
  const runs = (value as any)?.runs
  return Array.isArray(runs)
    ? runs
        .filter((r: any) => typeof r?.at === "number" && Number.isFinite(r.at))
        .map((r: any) => ({ at: r.at as number, ultra: r.ultra === true }))
    : []
}

/** Midnight at the start of `now`'s day, in this computer's time zone. */
export function localDayStart(now: number) {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export const isUltra = (model: string | undefined) => /ultra/i.test(model ?? "")

/** Adds one run, keeping two days of them. */
export function addRun(runs: PhraslyRun[], at: number, model: string | undefined): PhraslyRun[] {
  return [...runs.filter((r) => at - r.at < 2 * DAY), { at, ultra: isUltra(model) }]
}

export function usageToday(runs: PhraslyRun[], now: number) {
  const start = localDayStart(now)
  const today = runs.filter((r) => r.at >= start && r.at <= now)
  return { runsToday: today.length, ultraToday: today.filter((r) => r.ultra).length }
}

/** The warning to show at `warnAt` Ultra documents today and over. */
export function ultraWarning(ultraToday: number, warnAt: number) {
  if (ultraToday < warnAt) return undefined
  return ultraToday >= ULTRA_DAILY_LIMIT
    ? `${ultraToday} Ultra documents today: Phrasly may now be writing with its standard model instead of Ultra (its fair-use line is about ${ULTRA_DAILY_LIMIT} a day). Ask the user before humanizing more today.`
    : `${ultraToday} Ultra documents today: Phrasly may move the plan off Ultra after about ${ULTRA_DAILY_LIMIT} a day. Tell the user, and keep the rest of today's runs to what matters.`
}

// --- chrome.storage ------------------------------------------------------------------

export async function loadPhraslyPrefs() {
  const stored = await chrome.storage.local.get(PHRASLY_PREFS_KEY)
  return readPhraslyPrefs(stored[PHRASLY_PREFS_KEY])
}

export async function savePhraslyPrefs(update: Partial<PhraslyPrefs>) {
  const next = readPhraslyPrefs({ ...(await loadPhraslyPrefs()), ...update })
  await chrome.storage.local.set({ [PHRASLY_PREFS_KEY]: next })
  return next
}

export async function loadUsage() {
  const stored = await chrome.storage.local.get(PHRASLY_USAGE_KEY)
  return readUsage(stored[PHRASLY_USAGE_KEY])
}

let usageChain: Promise<unknown> = Promise.resolve()
/** Records one run; read-modify-writes in turn so none is lost. */
export function recordRun(model: string | undefined, at = Date.now()) {
  const next = usageChain.then(async () => {
    const runs = addRun(await loadUsage(), at, model)
    await chrome.storage.local.set({ [PHRASLY_USAGE_KEY]: { runs } })
    return runs
  })
  usageChain = next.catch(() => undefined)
  return next
}
