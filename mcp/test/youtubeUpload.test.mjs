// Tests for src/youtubeUpload.ts, run against the built files: npm test (builds
// first). Each test gets a temporary folder of upload packs (info.json or
// shorts-pack.json) and a fake extension bridge that records what the server sends.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

import { bulkUploadShorts, fillYoutubeUploads, parseShortsPack } from "../dist/youtubeUpload.js"

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "browse-hack-youtube-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function pack(name, files) {
  const folder = join(dir, name)
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(folder, file, ".."), { recursive: true })
    const data = typeof content === "string" || Buffer.isBuffer(content) ? content : JSON.stringify(content)
    writeFileSync(join(folder, file), data)
  }
  return folder
}

function fakeBridge() {
  const calls = []
  return {
    calls,
    called: (method) => calls.filter((call) => call.method === method),
    async call(method, params) {
      calls.push({ method, params })
      if (method === "youtube.uploadOpen") {
        return { sessionId: "s1", tabId: 7, channel: { name: "Anime Music Zone", handle: "@anime-music-zone" }, warnings: [] }
      }
      if (method === "youtube.uploadCommit") return { ok: true, message: "Filled.", filled: ["Title"], warnings: [], tabId: 7 }
      return { ok: true }
    }
  }
}

describe("fillYoutubeUploads", () => {
  test("reads title.txt and description.txt, and streams the video and the only thumbnail", async () => {
    const folder = pack("goten", {
      "info.json": { channel: "@anime-music-zone", visibility: "private" },
      "Goten Theme.mp4": Buffer.alloc(2 * 1024 * 1024 + 10, 1),
      "thumbnails/A.jpg": "jpg",
      "title.txt": "\nGoten Theme · Gregorian Chant\nsecond line\n",
      "description.txt": "Line one\n\nLyrics\n"
    })
    const bridge = fakeBridge()
    const result = await fillYoutubeUploads(bridge, [folder])

    assert.equal(result.published, false)
    assert.equal(result.results[0].ok, true)
    assert.equal(result.results[0].channel, "Anime Music Zone @anime-music-zone")
    const info = JSON.parse(bridge.called("youtube.uploadOpen")[0].params.infoJson)
    assert.equal(info.title, "Goten Theme · Gregorian Chant")
    assert.equal(info.description, "Line one\n\nLyrics\n")
    assert.equal(info.visibility, "private")
    const chunks = bridge.called("youtube.uploadChunk").map((call) => call.params)
    assert.deepEqual(
      chunks.map((chunk) => `${chunk.fileId}:${chunk.index}/${chunk.total}`),
      ["video:0/3", "video:1/3", "video:2/3", "thumbnail:0/1"]
    )
    assert.equal(chunks[0].mime, "video/mp4")
    assert.equal(Buffer.from(chunks[2].base64, "base64").length, 10)
    assert.deepEqual(bridge.called("youtube.uploadCommit")[0].params, {
      sessionId: "s1",
      videoId: "video",
      thumbnailId: "thumbnail"
    })
  })

  test("uses the files info.json names and skips a thumbnail when several are left", async () => {
    const folder = pack("nakama", {
      "info.json": { channel: "@x", title: "Nakama", video: "renders/final.mov", descriptionFile: "desc.md" },
      "renders/final.mov": "mov",
      "desc.md": "From desc.md",
      "thumbnails/A.jpg": "a",
      "thumbnails/B.jpg": "b"
    })
    const bridge = fakeBridge()
    const result = await fillYoutubeUploads(bridge, [folder])

    const info = JSON.parse(bridge.called("youtube.uploadOpen")[0].params.infoJson)
    assert.equal(info.description, "From desc.md")
    assert.equal(info.descriptionFile, undefined)
    assert.equal(bridge.called("youtube.uploadChunk")[0].params.mime, "video/quicktime")
    assert.equal(bridge.called("youtube.uploadCommit")[0].params.thumbnailId, undefined)
    assert.match(result.results[0].warnings.join(" "), /2 thumbnails/)
  })

  test("streams the A/B test's thumbnails in the variants' order", async () => {
    const folder = pack("wakeup", {
      "info.json": {
        channel: "@get-into-zone",
        title: "WAKE UP",
        abTest: [
          { thumbnail: "thumbnails/D1.jpg", title: "WAKE UP" },
          { thumbnail: "thumbnails/E1.jpg", title: "WAKE UP | Mirror" },
          { thumbnail: "thumbnails/G2.jpg", title: "WAKE UP | Dream" }
        ]
      },
      "WAKE UP.mp4": "v",
      "thumbnails/D1.jpg": "d",
      "thumbnails/E1.jpg": "e",
      "thumbnails/G2.jpg": "g"
    })
    const bridge = fakeBridge()
    const result = await fillYoutubeUploads(bridge, [folder])

    assert.equal(result.results[0].ok, true)
    assert.deepEqual(result.results[0].warnings, [])
    assert.deepEqual(
      bridge.called("youtube.uploadChunk").map((call) => `${call.params.fileId}:${call.params.name}`),
      ["video:WAKE UP.mp4", "ab-0:D1.jpg", "ab-1:E1.jpg", "ab-2:G2.jpg"]
    )
    assert.deepEqual(bridge.called("youtube.uploadCommit")[0].params, {
      sessionId: "s1",
      videoId: "video",
      thumbnailId: undefined,
      abThumbnailIds: ["ab-0", "ab-1", "ab-2"]
    })
  })

  test("an A/B test thumbnail that isn't in the pack fails the pack", async () => {
    const folder = pack("missing", {
      "info.json": { channel: "@x", title: "X", abTest: [{ thumbnail: "thumbnails/A.jpg" }, { thumbnail: "thumbnails/B.jpg" }] },
      "x.mp4": "v",
      "thumbnails/A.jpg": "a"
    })
    const result = await fillYoutubeUploads(fakeBridge(), [folder])
    assert.equal(result.results[0].ok, false)
    assert.match(result.results[0].message, /A\/B test thumbnail thumbnails\/B\.jpg isn't in/)
  })

  test("a parent folder runs each child pack, and a pack without one clear video fails on its own", async () => {
    pack("a", { "info.json": { channel: "@x", title: "A" }, "a.mp4": "v" })
    pack("b", { "info.json": { channel: "@x", title: "B" }, "x.mp4": "v", "y.webm": "v" })
    pack("c", { "info.json": { channel: "@x", title: "C" } })
    const bridge = fakeBridge()
    const result = await fillYoutubeUploads(bridge, [dir])

    assert.deepEqual(
      result.results.map((r) => r.ok),
      [true, false, false]
    )
    assert.match(result.results[1].message, /2 videos \(x\.mp4, y\.webm\)/)
    assert.match(result.results[2].message, /no video file/)
    assert.equal(bridge.called("youtube.uploadOpen").length, 1)
  })

  test("aborts the tab's session when streaming fails", async () => {
    const folder = pack("d", { "info.json": { channel: "@x", title: "D" }, "d.mp4": "v" })
    const bridge = fakeBridge()
    const call = bridge.call
    bridge.call = async (method, params) => {
      if (method === "youtube.uploadChunk") throw new Error("Lost the tab")
      return call(method, params)
    }
    const result = await fillYoutubeUploads(bridge, [folder])

    assert.equal(result.results[0].ok, false)
    assert.equal(result.results[0].message, "Lost the tab")
    assert.equal(result.results[0].tabId, 7)
    assert.equal(bridge.called("youtube.uploadAbort").length, 1)
  })
})

function shortsBridge({ days = ["2026-11-05", "2026-11-07", "2026-11-08"], freeDays } = {}) {
  const bridge = fakeBridge()
  const call = bridge.call
  let tab = 10
  bridge.call = async (method, params) => {
    if (method === "youtube.shortsFreeDays") {
      bridge.calls.push({ method, params })
      if (freeDays) return freeDays(params)
      return { channel: { name: "ATOMIC RAP", handle: "@atomic-rap" }, days: days.slice(0, params.count), taken: [], drafts: 0 }
    }
    if (method === "youtube.uploadOpen") {
      bridge.calls.push({ method, params })
      return { sessionId: `s${tab}`, tabId: tab++, channel: { name: "ATOMIC RAP", handle: "@atomic-rap" }, warnings: [] }
    }
    if (method === "youtube.uploadCommit") {
      bridge.calls.push({ method, params })
      return { ok: true, message: "Filled.", filled: ["Title"], warnings: [], ...(params.finish ? { scheduled: true } : {}) }
    }
    return call(method, params)
  }
  return bridge
}

function shortsPack(name, json, extra = {}) {
  return pack(name, {
    "shorts-pack.json": json,
    "description.txt": "Quicksilver x Kingpin\n\n#shorts\n",
    "shorts/qk-s01.mp4": "v1",
    "shorts/qk-s02.mp4": "v2",
    "shorts/qk-s03.mp4": "v3",
    ...extra
  })
}

const QUICKSILVER = {
  channel: "@atomic-rap",
  schedule: { time: "18:30" },
  defaults: { descriptionFile: "description.txt", tags: ["quicksilver", "kingpin"], madeForKids: false, alteredContent: false },
  shorts: [
    { video: "shorts/qk-s01.mp4", title: "Quicksilver Aura Edit #quicksilver" },
    { video: "shorts/qk-s02.mp4", title: "Quicksilver Aura Edit #quicksilver", scheduleAt: "2026-11-20T09:00" },
    { video: "shorts/qk-s03.mp4", title: "Quicksilver Aura Edit #quicksilver" }
  ]
}

describe("parseShortsPack", () => {
  test("merges the channel, defaults and each short, and pads the time", () => {
    const { pack: parsed, errors } = parseShortsPack({ ...QUICKSILVER, schedule: { time: "9:05", from: "2026-11-06" } })
    assert.deepEqual(errors, [])
    assert.deepEqual(parsed.schedule, { time: "09:05", from: "2026-11-06" })
    assert.equal(parsed.entries[1].channel, "@atomic-rap")
    assert.equal(parsed.entries[1].descriptionFile, "description.txt")
    assert.equal(parsed.entries[1].scheduleAt, "2026-11-20T09:00")
  })

  test("names what is wrong", () => {
    const { errors } = parseShortsPack({ schedule: { time: "25:00", from: "6 Nov" }, shorts: [] })
    assert.equal(errors.length, 4)
    assert.match(errors.join(" "), /no channel/)
    assert.match(errors.join(" "), /schedule\.time/)
    assert.match(errors.join(" "), /schedule\.from/)
    assert.match(errors.join(" "), /lists no shorts/)
  })
})

describe("bulkUploadShorts", () => {
  test("puts each short without a day on the next empty day, one tab each, and clicks nothing", async () => {
    const folder = shortsPack("quicksilverxkingpin-shorts", QUICKSILVER)
    const bridge = shortsBridge()
    const result = await bulkUploadShorts(bridge, [folder])

    assert.equal(result.scheduled, false)
    assert.deepEqual(bridge.called("youtube.shortsFreeDays")[0].params, { channel: "@atomic-rap", count: 2, from: undefined })
    const infos = bridge.called("youtube.uploadOpen").map((call) => JSON.parse(call.params.infoJson))
    assert.deepEqual(
      infos.map((info) => `${info.visibility ?? "-"} ${info.scheduleAt}`),
      ["scheduled 2026-11-05T18:30", "- 2026-11-20T09:00", "scheduled 2026-11-07T18:30"]
    )
    assert.equal(infos[0].channel, "@atomic-rap")
    assert.equal(infos[0].title, "Quicksilver Aura Edit #quicksilver")
    assert.equal(infos[0].description, "Quicksilver x Kingpin\n\n#shorts\n")
    assert.deepEqual(infos[2].tags, ["quicksilver", "kingpin"])
    assert.equal(infos[0].descriptionFile, undefined)
    assert.deepEqual(
      bridge.called("youtube.uploadChunk").map((call) => `${call.params.sessionId}:${call.params.name}`),
      ["s10:qk-s01.mp4", "s11:qk-s02.mp4", "s12:qk-s03.mp4"]
    )
    assert.ok(bridge.called("youtube.uploadCommit").every((call) => call.params.finish === undefined))

    const [packResult] = result.packs
    assert.equal(packResult.ok, true)
    assert.deepEqual(packResult.days, ["2026-11-05", "2026-11-07"])
    assert.deepEqual(
      packResult.shorts.map((short) => `${short.label} ${short.scheduleAt} tab ${short.tabId}`),
      ["Short 1 2026-11-05T18:30 tab 10", "Short 2 2026-11-20T09:00 tab 11", "Short 3 2026-11-07T18:30 tab 12"]
    )
    assert.equal(packResult.shorts[0].scheduled, undefined)
  })

  test("clicks Schedule only when asked", async () => {
    const folder = shortsPack("qk", QUICKSILVER)
    const bridge = shortsBridge()
    const result = await bulkUploadShorts(bridge, [folder], { clickSchedule: true })

    assert.equal(result.scheduled, true)
    assert.ok(bridge.called("youtube.uploadCommit").every((call) => call.params.finish === true))
    assert.deepEqual(result.packs[0].shorts.map((short) => short.scheduled), [true, true, true])
  })

  test("uploads nothing when a short is wrong", async () => {
    const folder = shortsPack("qk", {
      ...QUICKSILVER,
      shorts: [...QUICKSILVER.shorts, { video: "shorts/missing.mp4", title: "Q" }, { video: "shorts/qk-s01.mp4" }]
    })
    const bridge = shortsBridge()
    const result = await bulkUploadShorts(bridge, [folder])

    assert.equal(result.packs[0].ok, false)
    assert.match(result.packs[0].message, /^Nothing was uploaded\. Short 4: The video shorts\/missing\.mp4 isn't in .* Short 5: has no title/)
    assert.equal(bridge.called("youtube.shortsFreeDays").length, 0)
    assert.equal(bridge.called("youtube.uploadOpen").length, 0)
  })

  test("asks for a newer Browse Hack when the extension can't find empty days", async () => {
    const folder = shortsPack("qk", QUICKSILVER)
    const bridge = shortsBridge({
      freeDays: () => {
        throw new Error("Unknown method: youtube.shortsFreeDays")
      }
    })
    const result = await bulkUploadShorts(bridge, [folder])

    assert.equal(result.packs[0].ok, false)
    assert.match(result.packs[0].message, /Browse Hack 0\.16\.0 or later.*Nothing was uploaded/)
    assert.equal(bridge.called("youtube.uploadOpen").length, 0)
  })

  test("keeps each short's own visibility when the pack has no schedule, and finds pack folders inside a parent", async () => {
    const { schedule, ...unscheduled } = QUICKSILVER
    shortsPack("a-shorts", {
      ...unscheduled,
      defaults: { ...unscheduled.defaults, visibility: "private" },
      shorts: [{ video: "shorts/qk-s01.mp4", title: "One" }, { video: "shorts/qk-s02.mp4", title: "Two", scheduleAt: "2026-11-20T09:00", visibility: "scheduled" }]
    })
    pack("notes", { "readme.txt": "not a pack" })
    const bridge = shortsBridge()
    const result = await bulkUploadShorts(bridge, [dir])

    assert.equal(result.packs.length, 1)
    assert.equal(bridge.called("youtube.shortsFreeDays").length, 0)
    const infos = bridge.called("youtube.uploadOpen").map((call) => JSON.parse(call.params.infoJson))
    assert.deepEqual(
      infos.map((info) => `${info.visibility} ${info.scheduleAt ?? "-"}`),
      ["private -", "scheduled 2026-11-20T09:00"]
    )
  })
})
