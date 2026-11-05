// Reading and writing the schedule's date and time the way YouTube Studio shows them.
// Studio formats the time with Chrome's Intl, which puts a narrow no-break space
// (U+202F) before "pm" ("6:30 pm"), and rewrites whatever is typed into that form,
// so the fields are compared by value (the day, the minutes), never as text.

/** A time as minutes after midnight: "18:30", "6:30 pm", "6:30 PM", "6.30 p.m."; null when it isn't one. */
export function timeMinutes(value: string): number | null {
  const match = value.match(/(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?\s*m\.?)?/i)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (minute > 59) return null
  if (match[3]) {
    if (hour < 1 || hour > 12) return null
    return ((hour % 12) + (match[3].toLowerCase() === "p" ? 12 : 0)) * 60 + minute
  }
  return hour > 23 ? null : hour * 60 + minute
}

/** HH:MM written the way `sample` (the box's own value) is: 12-hour with its separator and case, or 24-hour. */
export function timeLike(sample: string, hour: number, minute: number): string {
  const mm = String(minute).padStart(2, "0")
  const twelve = sample.match(/\d{1,2}([:.])\d{2}(\s*)([ap])(\.?)\s*m(\.?)/i)
  if (twelve) {
    const [, colon, space, letter, dot] = twelve
    const upper = letter === letter.toUpperCase()
    const suffix = dot ? (hour < 12 ? "a.m." : "p.m.") : hour < 12 ? "am" : "pm"
    return `${hour % 12 || 12}${colon}${mm}${space}${upper ? suffix.toUpperCase() : suffix}`
  }
  const colon = sample.match(/\d([:.])\d/)?.[1] || ":"
  return `${String(hour).padStart(2, "0")}${colon}${mm}`
}
