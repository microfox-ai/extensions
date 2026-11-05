// Tests for the schedule's date and time helpers: npm test (Node strips the types).
// The samples are what YouTube Studio's Visibility step showed on 2026-11-05 (en-IN).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { timeLike, timeMinutes } from "./youtubeSchedule.ts"
import { studioDay } from "./youtubeShorts.ts"

const NARROW = " "

describe("timeMinutes", () => {
  test("reads Studio's 12-hour time with the narrow no-break space", () => {
    assert.equal(timeMinutes(`6:30${NARROW}pm`), 18 * 60 + 30)
    assert.equal(timeMinutes(`12:00${NARROW}am`), 0)
    assert.equal(timeMinutes("12:15 PM"), 12 * 60 + 15)
    assert.equal(timeMinutes("6.30 p.m."), 18 * 60 + 30)
  })

  test("reads 24-hour times and refuses what isn't a time", () => {
    assert.equal(timeMinutes("18:30"), 18 * 60 + 30)
    assert.equal(timeMinutes("09:05"), 9 * 60 + 5)
    assert.equal(timeMinutes("24:00"), null)
    assert.equal(timeMinutes("13:00 pm"), null)
    assert.equal(timeMinutes(""), null)
  })
})

describe("timeLike", () => {
  test("writes the time in the box's own form", () => {
    assert.equal(timeLike(`6:30${NARROW}pm`, 20, 0), `8:00${NARROW}pm`)
    assert.equal(timeLike(`6:30${NARROW}pm`, 9, 5), `9:05${NARROW}am`)
    assert.equal(timeLike("12:00 AM", 18, 30), "6:30 PM")
    assert.equal(timeLike("6:30pm", 0, 15), "12:15am")
    assert.equal(timeLike("6.30 p.m.", 18, 30), "6.30 p.m.")
    assert.equal(timeLike("18:30", 7, 0), "07:00")
  })

  test("what it writes reads back as the same minutes", () => {
    for (const sample of [`6:30${NARROW}pm`, "12:00 AM", "18:30", "6.30 p.m."]) {
      for (const [h, m] of [[0, 0], [9, 5], [12, 0], [18, 30], [23, 59]]) {
        assert.equal(timeMinutes(timeLike(sample, h, m)), h * 60 + m, `${sample} → ${h}:${m}`)
      }
    }
  })
})

describe("the schedule's date", () => {
  test("Studio's date trigger reads as the day, either order", () => {
    assert.equal(studioDay("6 Nov 2026"), "2026-11-06")
    assert.equal(studioDay("Nov 6, 2026"), "2026-11-06")
  })
})
