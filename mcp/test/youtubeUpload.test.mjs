// Tests for src/youtubeUpload.ts, run against the built files: npm test (builds
// first). Each test gets a temporary folder of upload packs and a fake extension
// bridge that records what the server sends.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

import { fillYoutubeUploads } from "../dist/youtubeUpload.js"

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
