// Tests for info.json's monetisation, ad suitability, end screen and cards
// fields: npm test (Node strips the types).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { parseYoutubeUploadInfo } from "./youtubeUpload.ts"

const base = { channel: "@anime-music-zone", title: "The Honoured One", madeForKids: false }

describe("info.json for the steps after Details", () => {
  test("leaves them to Studio's defaults when they're not set", () => {
    const { info, errors } = parseYoutubeUploadInfo(base)
    assert.deepEqual(errors, [])
    assert.equal(info.monetization, null)
    assert.equal(info.adSuitability, null)
    assert.equal(info.endScreen, null)
    assert.deepEqual(info.cards, [])
  })

  test("reads monetisation as a flag, also spelt monetisation or on/off", () => {
    assert.equal(parseYoutubeUploadInfo({ ...base, monetization: true }).info.monetization, true)
    assert.equal(parseYoutubeUploadInfo({ ...base, monetisation: "off" }).info.monetization, false)
    assert.deepEqual(parseYoutubeUploadInfo({ ...base, monetization: "maybe" }).errors, ["monetization must be true or false."])
  })

  test("reads ad suitability", () => {
    assert.equal(parseYoutubeUploadInfo({ ...base, adSuitability: "None of the above" }).info.adSuitability, "none")
    assert.equal(parseYoutubeUploadInfo({ ...base, adSuitability: "skip" }).info.adSuitability, "skip")
    assert.equal(parseYoutubeUploadInfo({ ...base, adSuitability: "violence" }).errors.length, 1)
  })

  test("reads the end screen as a title or an object with a playlist", () => {
    assert.deepEqual(parseYoutubeUploadInfo({ ...base, endScreen: "Full Metal Heart" }).info.endScreen, {
      importFrom: "Full Metal Heart",
      playlist: null
    })
    const { info, warnings } = parseYoutubeUploadInfo({
      ...base,
      endScreen: { importFrom: "Full Metal Heart", playlist: "Jujutsu Kaisen ( Lyric Videos ) - by AMZ" }
    })
    assert.deepEqual(info.endScreen, { importFrom: "Full Metal Heart", playlist: "Jujutsu Kaisen ( Lyric Videos ) - by AMZ" })
    assert.deepEqual(warnings, [])
    assert.equal(parseYoutubeUploadInfo({ ...base, endScreen: { playlist: "x" } }).errors.length, 1)
  })

  test("reads channel cards, with the teaser defaulting to the message", () => {
    const { info, errors } = parseYoutubeUploadInfo({
      ...base,
      cards: [{ channel: "@get-into-zone", message: "Music on Get into Zone" }]
    })
    assert.deepEqual(errors, [])
    assert.deepEqual(info.cards, [{ channel: "@get-into-zone", message: "Music on Get into Zone", teaser: "Music on Get into Zone" }])
    assert.equal(parseYoutubeUploadInfo({ ...base, cards: { channel: "Get into Zone", message: "Hi", teaser: "Yo" } }).info.cards.length, 1)
  })

  test("reads an A/B test of thumbnails with their titles", () => {
    const { info, errors } = parseYoutubeUploadInfo({
      ...base,
      abTest: [
        { thumbnail: "thumbnails/D1.jpg", title: "WAKE UP - by Get into Zone ( Official Lyric Video )" },
        { thumbnail: "thumbnails/E1.jpg", title: "WAKE UP | Stop Running From the Mirror" },
        { thumbnail: "thumbnails/G2.jpg", title: "WAKE UP | We All Live Inside a Dream" }
      ]
    })
    assert.deepEqual(errors, [])
    assert.equal(info.abTest.length, 3)
    assert.deepEqual(info.abTest[1], { thumbnail: "thumbnails/E1.jpg", title: "WAKE UP | Stop Running From the Mirror" })
    assert.deepEqual(parseYoutubeUploadInfo({ ...base, abTest: [{ title: "A" }, { title: "B" }] }).errors, [])
  })

  test("refuses A/B tests Studio can't run", () => {
    const errorsOf = (abTest) => parseYoutubeUploadInfo({ ...base, abTest }).errors
    assert.match(errorsOf([{ thumbnail: "a.jpg" }]).join(" "), /YouTube tests 2 or 3/)
    assert.match(errorsOf([1, 2, 3, 4].map((n) => ({ title: `T${n}` }))).join(" "), /YouTube tests 2 or 3/)
    assert.match(errorsOf([{ thumbnail: "a.jpg", title: "A" }, { thumbnail: "b.jpg" }]).join(" "), /every variant a title, or none/)
    assert.match(errorsOf([{}, {}]).join(" "), /need a thumbnail, a title or both/)
    assert.match(errorsOf({ thumbnail: "a.jpg" }).join(" "), /must be a list/)
  })

  test("refuses cards it can't add", () => {
    const { errors } = parseYoutubeUploadInfo({
      ...base,
      cards: [
        { video: "Full Metal Heart", message: "Watch" },
        { channel: "@get-into-zone" },
        { channel: "@get-into-zone", message: "This message is far too long for a card" }
      ]
    })
    assert.equal(errors.length, 3)
    assert.match(errors[0], /only channel cards/)
    assert.match(errors[1], /needs a "message"/)
    assert.match(errors[2], /YouTube allows 30/)
  })
})
