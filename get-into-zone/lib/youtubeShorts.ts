// Shorts for the popup's YouTube Studio tab: shorts-pack.json (several shorts to
// upload, made by MediaMake's pack-youtube), the days that have no short yet,
// and which filled-in short a draft should copy.

/**
 * shorts-pack.json: `defaults` holds the info.json fields every short shares; each
 * entry of `shorts` adds its own (video, title…), and wins over the defaults. A short
 * without scheduleAt goes on the next day from `schedule.from` that has no short,
 * at `schedule.time`.
 */
export type ShortsPack = {
  channel: string
  schedule: { time: string; from: string | null } | null
  entries: Record<string, unknown>[]
}

export type StudioShort = {
  videoId: string
  title: string
  /** "Draft", "Scheduled", "Public", "Private", "Unlisted" as Studio lists it. */
  visibility: string
  /** YYYY-MM-DD: the scheduled or published day, when the row shows one. */
  date: string | null
  draft: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function parseShortsPack(raw: unknown): { pack: ShortsPack; errors: string[] } {
  const errors: string[] = []
  const obj = asRecord(raw) || {}
  if (!asRecord(raw)) errors.push("shorts-pack.json must be a JSON object.")
  const defaults = asRecord(obj.defaults) || {}
  const channel = String(obj.channel ?? defaults.channel ?? "").trim()
  if (!channel) errors.push('shorts-pack.json has no channel (e.g. "@atomic-rap").')

  let schedule: ShortsPack["schedule"] = null
  const rawSchedule = asRecord(obj.schedule)
  if (obj.schedule !== undefined) {
    const time = String(rawSchedule?.time ?? "").trim()
    const from = String(rawSchedule?.from ?? "").trim()
    if (!TIME.test(time)) errors.push('schedule.time must be "HH:MM" (24-hour, in the channel\'s time zone).')
    if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) errors.push('schedule.from must be "YYYY-MM-DD".')
    const [, h, m] = time.match(TIME) || []
    schedule = { time: h ? `${h.padStart(2, "0")}:${m}` : time, from: from || null }
  }

  const shorts = Array.isArray(obj.shorts) ? obj.shorts : []
  if (!shorts.length) errors.push("shorts-pack.json lists no shorts.")
  const entries = shorts.map((item, index): Record<string, unknown> => {
    const short = asRecord(item)
    if (!short) errors.push(`shorts[${index}] must be an object with at least "video" and "title".`)
    return { channel, ...defaults, ...(short || {}) }
  })
  entries.forEach((entry, index) => {
    if (typeof entry.video !== "string" || !entry.video.trim()) errors.push(`shorts[${index}] has no "video".`)
  })
  return { pack: { channel, schedule, entries }, errors }
}

export function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

/** The first `count` days from `from` (YYYY-MM-DD) that aren't taken. */
export function emptyDays(taken: Iterable<string>, count: number, from: string): string[] {
  const busy = new Set(taken)
  const [y, m, d] = from.split("-").map(Number)
  const day = new Date(y, m - 1, d)
  const days: string[] = []
  for (let i = 0; i < 730 && days.length < count; i++) {
    const iso = isoDay(day)
    if (!busy.has(iso)) days.push(iso)
    day.setDate(day.getDate() + 1)
  }
  return days
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/** Studio's date column ("12 Jan 2027 Scheduled", "Nov 3, 2026 Published") as YYYY-MM-DD. */
export function studioDay(text: string): string | null {
  const dayFirst = text.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/)
  const monthFirst = text.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/)
  const [day, month, year] = dayFirst
    ? [dayFirst[1], dayFirst[2], dayFirst[3]]
    : monthFirst
      ? [monthFirst[2], monthFirst[1], monthFirst[3]]
      : []
  const index = month ? MONTHS.indexOf(month.slice(0, 3).toLowerCase()) : -1
  if (index < 0) return null
  return `${year}-${String(index + 1).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`
}

/** Words that say nothing about which short it is. */
const NOISE = new Set(["shorts", "short", "mp4", "mov", "webm", "final", "edit", "video", "copy", "the", "and"])

function words(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/\.[a-z0-9]{2,4}$/, "")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !/^\d+$/.test(word) && !/^v\d+$/.test(word) && !NOISE.has(word))
  )
}

export function titleSimilarity(a: string, b: string): number {
  const left = words(a)
  const right = words(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

/** The filled-in short a draft copies: the most similar title, else the latest (shorts come newest first). */
export function pickReference(draftTitle: string, filled: StudioShort[]): { short: StudioShort; similar: boolean } | null {
  if (!filled.length) return null
  let best = filled[0]
  let score = 0
  for (const short of filled) {
    const next = titleSimilarity(draftTitle, short.title)
    if (next > score) {
      best = short
      score = next
    }
  }
  return { short: best, similar: score > 0 }
}
