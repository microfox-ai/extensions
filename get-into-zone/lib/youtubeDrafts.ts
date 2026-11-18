// Which draft on the channel a pack's upload left behind, when the video went up but
// its upload dialog was lost before the details went in. Studio names a draft after
// its video file until a title is typed, and saves a typed title at once, so the
// draft carries info.json's title or the video's file name.

import type { StudioShort } from "./youtubeShorts"

/** An 11-character video id from a Studio, youtu.be, watch or Shorts link, or the id alone. */
export function videoIdFrom(text: string): string | null {
  const value = text.trim()
  if (/^[\w-]{11}$/.test(value)) return value
  return value.match(/(?:\/video\/|youtu\.be\/|\/shorts\/|[?&]v=)([\w-]{11})(?![\w-])/)?.[1] ?? null
}

/** Letters and digits only, lower case: "Pump It Up" and "pump_it_up" are the same. */
const fold = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")

export type DraftMatch = {
  row: StudioShort
  by: "id" | "title" | "file"
  /** More drafts that matched as well (the newest one is taken). */
  others: number
}

/**
 * The row for an upload: the one with this id when the user gave it, else a draft titled
 * like info.json's title, else one named like its video file. Rows come newest first, as
 * Studio lists them; drafts in `taken` already went to another upload.
 */
export function matchDraft(
  rows: StudioShort[],
  wanted: { draftId?: string | null; title: string; videoName: string },
  taken: ReadonlySet<string> = new Set()
): DraftMatch | null {
  if (wanted.draftId) {
    const row = rows.find((item) => item.videoId === wanted.draftId)
    return row ? { row, by: "id", others: 0 } : null
  }
  const drafts = rows.filter((row) => row.draft && !taken.has(row.videoId))
  const keys: [DraftMatch["by"], string][] = [
    ["title", fold(wanted.title)],
    ["file", fold(wanted.videoName.replace(/\.[^.]+$/, ""))]
  ]
  for (const [by, key] of keys) {
    if (!key) continue
    const hits = drafts.filter((row) => fold(row.title) === key)
    if (hits.length) return { row: hits[0], by, others: hits.length - 1 }
  }
  return null
}

/** The drafts a list shows, for a message when none matched. */
export function describeDrafts(rows: StudioShort[], max = 5): string {
  const drafts = rows.filter((row) => row.draft)
  if (!drafts.length) return "It has no drafts."
  const shown = drafts.slice(0, max).map((row) => `"${row.title}" (${row.videoId})`)
  return `Its drafts: ${shown.join(", ")}${drafts.length > max ? ` and ${drafts.length - max} more` : ""}.`
}
