// Tests for finding the draft a pack's upload left behind: npm test (Node strips the types).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { describeDrafts, matchDraft, videoIdFrom } from "./youtubeDrafts.ts"

const row = (videoId, title, draft = true) => ({ videoId, title, visibility: draft ? "Draft" : "Private", date: null, draft })

describe("video ids", () => {
  test("reads Studio, youtu.be, watch and Shorts links, and a bare id", () => {
    assert.equal(videoIdFrom("https://studio.youtube.com/video/AbC_12-xyz9/edit"), "AbC_12-xyz9")
    assert.equal(videoIdFrom("https://youtu.be/AbC_12-xyz9?si=x"), "AbC_12-xyz9")
    assert.equal(videoIdFrom("https://www.youtube.com/watch?v=AbC_12-xyz9&t=3"), "AbC_12-xyz9")
    assert.equal(videoIdFrom("https://www.youtube.com/shorts/AbC_12-xyz9"), "AbC_12-xyz9")
    assert.equal(videoIdFrom("  AbC_12-xyz9 "), "AbC_12-xyz9")
  })

  test("refuses anything else", () => {
    assert.equal(videoIdFrom("pump it up"), null)
    assert.equal(videoIdFrom("https://studio.youtube.com/video/AbC_12-xyz9ZZ/edit"), null)
    assert.equal(videoIdFrom(""), null)
  })
})

describe("matching a draft", () => {
  const rows = [
    row("aaaaaaaaaaa", "Some other song"),
    row("bbbbbbbbbbb", "pump-it-up_v7"),
    row("ccccccccccc", "Pump It Up Live", false),
    row("ddddddddddd", "Pump It Up | Lyric Video")
  ]

  test("prefers info.json's title, ignoring case and punctuation", () => {
    const match = matchDraft(rows, { title: "PUMP IT UP – Lyric Video", videoName: "pump-it-up_v7.mp4" })
    assert.equal(match?.row.videoId, "ddddddddddd")
    assert.equal(match?.by, "title")
  })

  test("falls back to the video's file name, without its extension", () => {
    const match = matchDraft(rows, { title: "Brand new title", videoName: "Pump_It_Up v7.MP4" })
    assert.equal(match?.row.videoId, "bbbbbbbbbbb")
    assert.equal(match?.by, "file")
  })

  test("never takes a video that isn't a draft by its title", () => {
    assert.equal(matchDraft(rows, { title: "Pump It Up – Live", videoName: "x.mp4" }), null)
  })

  test("takes the newest of several and counts the others", () => {
    const twice = [row("eeeeeeeeeee", "song"), row("fffffffffff", "Song")]
    assert.deepEqual(matchDraft(twice, { title: "song", videoName: "" }), { row: twice[0], by: "title", others: 1 })
  })

  test("skips drafts another upload already took", () => {
    const twice = [row("eeeeeeeeeee", "song"), row("fffffffffff", "Song")]
    assert.equal(matchDraft(twice, { title: "song", videoName: "" }, new Set(["eeeeeeeeeee"]))?.row.videoId, "fffffffffff")
  })

  test("a given id wins, draft or not", () => {
    const match = matchDraft(rows, { draftId: "ccccccccccc", title: "Pump It Up | Lyric Video", videoName: "" })
    assert.equal(match?.row.videoId, "ccccccccccc")
    assert.equal(match?.by, "id")
    assert.equal(matchDraft(rows, { draftId: "zzzzzzzzzzz", title: "Some other song", videoName: "" }), null)
  })

  test("lists the drafts there are", () => {
    assert.equal(describeDrafts([]), "It has no drafts.")
    assert.equal(describeDrafts(rows, 2), 'Its drafts: "Some other song" (aaaaaaaaaaa), "pump-it-up_v7" (bbbbbbbbbbb) and 1 more.')
  })
})
