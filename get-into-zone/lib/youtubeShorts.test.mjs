// Tests for the YouTube Studio tab's Shorts helpers: npm test (Node strips the types).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { emptyDays, parseShortsPack, pickReference, studioDay, titleSimilarity } from "./youtubeShorts.ts"

describe("shorts-pack.json", () => {
  test("merges the defaults into each short, the short winning", () => {
    const { pack, errors } = parseShortsPack({
      channel: "@atomic-rap",
      schedule: { time: "9:05" },
      defaults: { tags: ["deadpool"], madeForKids: false, title: "Deadpool Aura Edit" },
      shorts: [{ video: "shorts/1.mp4" }, { video: "shorts/2.mp4", title: "Wolverine Aura Edit", scheduleAt: "2026-12-01T10:00" }]
    })
    assert.deepEqual(errors, [])
    assert.equal(pack.channel, "@atomic-rap")
    assert.deepEqual(pack.schedule, { time: "09:05", from: null })
    assert.equal(pack.entries[0].title, "Deadpool Aura Edit")
    assert.equal(pack.entries[1].title, "Wolverine Aura Edit")
    assert.equal(pack.entries[1].channel, "@atomic-rap")
    assert.deepEqual(pack.entries[0].tags, ["deadpool"])
  })

  test("says what's missing", () => {
    const { errors } = parseShortsPack({ schedule: { time: "25:00", from: "soon" }, shorts: [{ title: "x" }] })
    assert.equal(errors.length, 4)
    assert.match(errors.join(" "), /no channel/)
    assert.match(errors.join(" "), /schedule.time/)
    assert.match(errors.join(" "), /schedule.from/)
    assert.match(errors.join(" "), /shorts\[0\] has no "video"/)
  })
})

describe("scheduling Shorts on empty days", () => {
  test("skips days that already have a short, across a month end", () => {
    assert.deepEqual(emptyDays(["2026-11-29", "2026-12-01"], 3, "2026-11-29"), ["2026-11-30", "2026-12-02", "2026-12-03"])
  })

  test("reads Studio's date column", () => {
    assert.equal(studioDay("12 Jan 2027 Scheduled"), "2027-01-12")
    assert.equal(studioDay("Nov 3, 2026 Published"), "2026-11-03")
    assert.equal(studioDay("Draft"), null)
  })
})

describe("the short a draft copies", () => {
  const filled = [
    { videoId: "a", title: "Deadpool Aura Edit #deadpool", visibility: "Scheduled", date: "2027-01-12", draft: false },
    { videoId: "b", title: "Breaking Bad Aura Edit #breakingbad #walterwhite", visibility: "Public", date: "2026-11-03", draft: false }
  ]

  test("matches the draft's file-name title to the closest short", () => {
    assert.ok(titleSimilarity("breaking-bad-3.mp4", filled[1].title) > titleSimilarity("breaking-bad-3.mp4", filled[0].title))
    assert.deepEqual(pickReference("breaking-bad-3.mp4", filled), { short: filled[1], similar: true })
  })

  test("falls back to the latest when nothing matches", () => {
    assert.deepEqual(pickReference("VID_20261104.mp4", filled), { short: filled[0], similar: false })
    assert.equal(pickReference("x", []), null)
  })
})
