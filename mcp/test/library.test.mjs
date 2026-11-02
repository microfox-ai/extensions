// Tests for src/library.ts and the download tools in src/downloads.ts, run
// against the built files: npm test (builds first).
// Each test gets a fake home folder with ~/.mediamake/config.json, a library
// catalog built with node:sqlite and an inbox, and a fake extension bridge.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, test } from "node:test"

import {
  downloadMidjourneyImages,
  covers,
  instagramDownload,
  parseVideoId,
  startPinterestBulk,
  youtubeDownload
} from "../dist/downloads.js"
import {
  canLookup,
  downloadsFolder,
  findMedia,
  hasLibrary,
  inInbox,
  inboxFolder,
  knownPins,
  lookup,
  modelFromPrompt,
  pngHeight,
  readLibrary,
  sourceRecord,
  writeSidecar
} from "../dist/library.js"

let home, downloads, root, inbox, savedHome

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "browse-hack-library-"))
  downloads = join(home, "Downloads")
  root = join(downloads, "_LIBRARY")
  inbox = join(downloads, "_INBOX")
  // The download tools read the config from the real home folder.
  savedHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

function writeConfig(library = { root: "~/Downloads/_LIBRARY", inbox: "~/Downloads/_INBOX" }) {
  mkdirSync(join(home, ".mediamake"), { recursive: true })
  writeFileSync(join(home, ".mediamake", "config.json"), JSON.stringify({ library }))
}

function touch(path, content = "x") {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

// rows: { id, path, height, fps, status, tool, ref }; files for "online" rows are created.
function makeCatalog(rows) {
  mkdirSync(join(root, ".catalog"), { recursive: true })
  const db = new DatabaseSync(join(root, ".catalog", "library.db"))
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY, path TEXT, height INT, fps REAL, status TEXT);" +
      "CREATE TABLE sources(item_id TEXT, tool TEXT, ref TEXT, UNIQUE(tool, ref));"
  )
  const item = db.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?)")
  const source = db.prepare("INSERT INTO sources VALUES (?, ?, ?)")
  for (const row of rows) {
    item.run(row.id, row.path, row.height ?? null, row.fps ?? null, row.status ?? "online")
    source.run(row.id, row.tool, row.ref)
    if ((row.status ?? "online") === "online" && row.onDisk !== false) touch(join(root, row.path))
  }
  db.close()
}

// The first 24 bytes of a PNG: signature, then the IHDR chunk's width and height.
function png(width, height) {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write("IHDR", 12, "ascii")
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

// Records every call; answers from `answers[method](params)`.
function fakeBridge(answers = {}) {
  const calls = []
  return {
    calls,
    called: (method) => calls.filter((c) => c.method === method),
    call: async (method, params) => {
      calls.push({ method, params })
      const answer = answers[method]
      if (!answer) throw new Error(`unexpected call: ${method}`)
      return answer(params)
    }
  }
}

describe("readLibrary", () => {
  test("without a config there is no library", () => {
    const lib = readLibrary(home)
    assert.deepEqual(lib, { home, root: undefined, inbox: undefined })
    assert.equal(hasLibrary(lib), false)
    assert.equal(canLookup(lib, "youtube"), false)
  })

  test("a broken config counts as none", () => {
    touch(join(home, ".mediamake", "config.json"), "{ not json")
    assert.equal(hasLibrary(readLibrary(home)), false)
  })

  test("expands ~ and resolves relative paths against home", () => {
    writeConfig({ root: "~/Downloads/_LIBRARY", inbox: "Downloads/_INBOX" })
    const lib = readLibrary(home)
    assert.equal(lib.root, root)
    assert.equal(lib.inbox, inbox)
    assert.equal(hasLibrary(lib), true)
  })
})

describe("folders", () => {
  test("the inbox's folders, relative to Downloads", () => {
    writeConfig()
    const lib = readLibrary(home)
    assert.equal(inboxFolder(lib, "youtube"), "_INBOX/youtube")
    assert.equal(inboxFolder(lib, "midjourney", "2026-11-02"), "_INBOX/midjourney/2026-11-02")
  })

  test("no inbox folder when the inbox isn't inside Downloads", () => {
    writeConfig({ root: "~/Media/_LIBRARY", inbox: "~/Media/_INBOX" })
    assert.equal(inboxFolder(readLibrary(home), "youtube"), undefined)
    writeConfig({ inbox: "~/Downloads" })
    assert.equal(inboxFolder(readLibrary(home), "youtube"), undefined)
  })

  test("downloadsFolder takes subfolders and paths inside Downloads", () => {
    assert.equal(downloadsFolder("clips/new", home), "clips/new")
    assert.equal(downloadsFolder("./clips//new/", home), "clips/new")
    assert.equal(downloadsFolder("~/Downloads/_INBOX/youtube", home), "_INBOX/youtube")
    assert.equal(downloadsFolder(join(downloads, "x", "y"), home), "x/y")
    assert.equal(downloadsFolder("", home), "")
  })

  test("downloadsFolder refuses folders outside Downloads", () => {
    assert.throws(() => downloadsFolder(join(home, "Desktop"), home), /must be inside/)
    assert.throws(() => downloadsFolder("../Desktop", home), /must be inside/)
    assert.throws(() => downloadsFolder("a/../../b", home), /must be inside/)
  })
})

describe("lookup", () => {
  beforeEach(() => {
    writeConfig()
    makeCatalog([
      { id: "i1", path: "video/youtube/clip.mp4", height: 1080, fps: 29.97, tool: "youtube", ref: "dQw4w9WgXcQ" },
      { id: "i2", path: "video/youtube/old.mp4", height: 720, fps: 30, status: "offline", tool: "youtube", ref: "offline0001" },
      { id: "i3", path: "video/youtube/gone.mp4", height: 720, tool: "youtube", ref: "missing0001", onDisk: false },
      { id: "i4", path: "image/pinterest/aa.jpg", tool: "pinterest", ref: "aa11" },
      { id: "i5", path: "image/pinterest/bb.jpg", tool: "pinterest", ref: "bb22", status: "offline" },
      { id: "i6", path: "footage/pinterest/ee55.mp4", tool: "pinterest", ref: "ee55" }
    ])
  })

  test("answers what the catalog has online, with an absolute path", async () => {
    const lib = readLibrary(home)
    assert.equal(canLookup(lib, "youtube"), true)
    assert.deepEqual(await lookup("youtube", "dQw4w9WgXcQ", lib), {
      path: join(root, "video/youtube/clip.mp4"),
      height: 1080,
      fps: 29.97,
      where: "library"
    })
  })

  test("nothing for an unknown ref, another tool, an offline item or a file that's gone", async () => {
    const lib = readLibrary(home)
    assert.equal(await lookup("youtube", "unknown0000", lib), undefined)
    assert.equal(await lookup("instagram", "dQw4w9WgXcQ", lib), undefined)
    assert.equal(await lookup("youtube", "offline0001", lib), undefined)
    assert.equal(await lookup("youtube", "missing0001", lib), undefined)
  })

  test("nothing, silently, without a catalog file", async () => {
    rmSync(join(root, ".catalog"), { recursive: true })
    const lib = readLibrary(home)
    assert.equal(canLookup(lib, "youtube"), false)
    assert.equal(await lookup("youtube", "dQw4w9WgXcQ", lib), undefined)
  })

  test("nothing, silently, from a catalog with other tables", async () => {
    rmSync(join(root, ".catalog"), { recursive: true })
    mkdirSync(join(root, ".catalog"))
    const db = new DatabaseSync(join(root, ".catalog", "library.db"))
    db.exec("CREATE TABLE other(x)")
    db.close()
    assert.equal(await lookup("youtube", "dQw4w9WgXcQ", readLibrary(home)), undefined)
  })

  test("findMedia falls back to a download in the inbox that isn't filed yet", async () => {
    const lib = readLibrary(home)
    const file = touch(join(inbox, "youtube", "New clip (720p).mp4"))
    writeSidecar(file, { tool: "youtube", ref: "inboxonly01", height: 720, fps: 25 })
    assert.deepEqual(await findMedia("youtube", "inboxonly01", lib), { path: file, height: 720, fps: 25, where: "inbox" })
    assert.equal((await findMedia("youtube", "dQw4w9WgXcQ", lib)).where, "library")
  })

  test("the inbox doesn't count a sidecar whose file is gone", () => {
    const lib = readLibrary(home)
    touch(join(inbox, "youtube", "deleted.mp4.source.json"), JSON.stringify({ tool: "youtube", ref: "deleted0001" }))
    assert.equal(inInbox("youtube", "deleted0001", lib), undefined)
  })

  test("knownPins: online pins in the catalog and pins of earlier sessions still in the inbox, and which are videos", async () => {
    const session = join(inbox, "pinterest", "2026-11-01-luffy")
    touch(join(session, "cc33.jpg"))
    touch(join(session, "videos", "ff66.mp4"))
    touch(
      join(session, "_session.json"),
      JSON.stringify({
        schema: "mediamake.pinterest-session/v1",
        pins: [
          { id: "cc33", file: "cc33.jpg" },
          { id: "dd44", file: "dd44.jpg" },
          { id: "ff66", file: "videos/ff66.mp4" }
        ]
      })
    )
    const { pins, videos } = await knownPins(readLibrary(home))
    assert.deepEqual(pins.sort(), ["aa11", "cc33", "ee55", "ff66"])
    assert.deepEqual(videos.sort(), ["ee55", "ff66"])
  })
})

describe("sidecars", () => {
  test("keys in order, unknown ones left out", () => {
    const record = sourceRecord(
      { tool: "youtube", ref: "abc", url: "https://www.youtube.com/watch?v=abc", title: "Clip", author: "", height: 1080, fps: 0 },
      new Date("2026-11-02T10:00:00Z")
    )
    assert.deepEqual(Object.keys(record), ["schema", "tool", "ref", "url", "title", "height", "downloadedAt"])
    assert.equal(record.schema, "mediamake.source/v1")
    assert.equal(record.downloadedAt, "2026-11-02T10:00:00.000Z")
  })

  test("written next to the file as <file>.source.json", () => {
    const file = touch(join(downloads, "a.mp4"))
    const path = writeSidecar(file, { tool: "instagram", ref: "C9xYz:1" })
    assert.equal(path, `${file}.source.json`)
    assert.equal(JSON.parse(readFileSync(path, "utf8")).ref, "C9xYz:1")
  })

  test("Midjourney model names and PNG heights", () => {
    assert.equal(modelFromPrompt("a red devil --ar 16:9 --v 7"), "v7")
    assert.equal(modelFromPrompt("a red devil --version 6.1 --raw"), "v6.1")
    assert.equal(modelFromPrompt("a red devil --niji 6"), "niji 6")
    assert.equal(modelFromPrompt("a red devil"), undefined)
    assert.equal(pngHeight(touch(join(downloads, "a.png"), png(1456, 816))), 816)
    assert.equal(pngHeight(touch(join(downloads, "b.png"), "not a png at all, no")), undefined)
  })
})

describe("YouTube", () => {
  test("video ids from links", () => {
    assert.equal(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10"), "dQw4w9WgXcQ")
    assert.equal(parseVideoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ")
    assert.equal(parseVideoId("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ")
    assert.equal(parseVideoId("https://example.com/watch?v=dQw4w9WgXcQ"), undefined)
    assert.equal(parseVideoId(undefined), undefined)
  })

  test("which library copies answer a request", () => {
    const video = { path: "/x/clip.mp4", height: 720 }
    assert.equal(covers(video, {}), true)
    assert.equal(covers(video, { maxHeight: 720 }), true)
    assert.equal(covers(video, { maxHeight: 480 }), true)
    assert.equal(covers(video, { maxHeight: 1080 }), false)
    assert.equal(covers(video, { mode: "audio" }), true)
    assert.equal(covers({ path: "/x/song.m4a", height: null }, {}), false)
    assert.equal(covers({ path: "/x/song.m4a", height: null }, { mode: "audio" }), true)
    assert.equal(covers({ path: "/x/clip.mp4", height: null }, { maxHeight: 1080 }), true)
  })

  test("the library has it: alreadyHave, and nothing is downloaded", async () => {
    writeConfig()
    makeCatalog([{ id: "i1", path: "video/clip.mp4", height: 1080, fps: 30, tool: "youtube", ref: "dQw4w9WgXcQ" }])
    const bridge = fakeBridge()
    const result = await youtubeDownload(bridge, { url: "https://youtu.be/dQw4w9WgXcQ" })
    assert.deepEqual(result.alreadyHave, { path: join(root, "video/clip.mp4"), height: 1080, fps: 30, where: "library" })
    assert.equal(bridge.calls.length, 0)
  })

  test("a tab without a link: asks the extension which video it plays", async () => {
    writeConfig()
    makeCatalog([{ id: "i1", path: "video/clip.mp4", height: 1080, tool: "youtube", ref: "dQw4w9WgXcQ" }])
    const bridge = fakeBridge({ "youtube.getVideo": () => ({ videoId: "dQw4w9WgXcQ" }) })
    const result = await youtubeDownload(bridge, { tabId: 7 })
    assert.equal(result.alreadyHave.height, 1080)
    assert.deepEqual(bridge.called("youtube.getVideo")[0].params, { url: undefined, tabId: 7 })
  })

  test("force, or a maxHeight above the library's copy, downloads into the inbox with a sidecar", async () => {
    writeConfig()
    makeCatalog([{ id: "i1", path: "video/clip.mp4", height: 720, tool: "youtube", ref: "dQw4w9WgXcQ" }])
    const bridge = fakeBridge({ "youtube.download": () => ({ jobId: "j1" }) })
    await youtubeDownload(bridge, { url: "https://youtu.be/dQw4w9WgXcQ", maxHeight: 1080 })
    await youtubeDownload(bridge, { url: "https://youtu.be/dQw4w9WgXcQ", force: true, fileName: "clip" })
    const [higher, forced] = bridge.called("youtube.download").map((c) => c.params)
    assert.deepEqual(higher, { url: "https://youtu.be/dQw4w9WgXcQ", maxHeight: 1080, folder: "_INBOX/youtube", fileName: undefined, sidecar: true })
    assert.equal(forced.fileName, "clip")
    assert.equal(forced.force, undefined)
  })

  test("without a library: today's folder and no sidecar", async () => {
    const bridge = fakeBridge({ "youtube.download": () => ({ jobId: "j1" }) })
    await youtubeDownload(bridge, { url: "https://youtu.be/dQw4w9WgXcQ" })
    assert.deepEqual(bridge.calls.map((c) => c.method), ["youtube.download"])
    assert.equal(bridge.calls[0].params.folder, undefined)
    assert.equal(bridge.calls[0].params.sidecar, false)
  })

  test("an explicit folder inside Downloads", async () => {
    const bridge = fakeBridge({ "youtube.download": () => ({ jobId: "j1" }) })
    await youtubeDownload(bridge, { url: "https://youtu.be/dQw4w9WgXcQ", folder: "~/Downloads/twixtor" })
    assert.equal(bridge.calls[0].params.folder, "twixtor")
  })
})

describe("Instagram", () => {
  test("downloads only what the library doesn't have, and writes sidecars", async () => {
    writeConfig()
    makeCatalog([{ id: "i2", path: "image/natgeo-2.jpg", height: 1350, tool: "instagram", ref: "C9xYz12AbCd:2" }])
    const saved = [1, 3].map((n) => touch(join(inbox, "instagram", `natgeo - C9xYz12AbCd - ${n}.jpg`)))
    const bridge = fakeBridge({
      "instagram.getPost": () => ({
        username: "natgeo",
        code: "C9xYz12AbCd",
        mediaId: "1",
        items: [{ number: 1 }, { number: 2 }, { number: 3 }]
      }),
      "instagram.download": ({ items }) => ({
        username: "natgeo",
        code: "C9xYz12AbCd",
        mediaId: "1",
        caption: "Lions at dawn\n#wildlife",
        count: 3,
        saved: items.map((number, i) => ({ number, kind: "image", path: saved[i], height: 1080 }))
      })
    })
    const result = await instagramDownload(bridge, { url: "https://www.instagram.com/p/C9xYz12AbCd/" })
    const download = bridge.called("instagram.download")[0].params
    assert.deepEqual(download.items, [1, 3])
    assert.equal(download.folder, "_INBOX/instagram")
    assert.deepEqual(result.alreadyHave.map((have) => have.number), [2])
    const sidecar = JSON.parse(readFileSync(`${saved[1]}.source.json`, "utf8"))
    assert.equal(sidecar.ref, "C9xYz12AbCd:3")
    assert.equal(sidecar.url, "https://www.instagram.com/p/C9xYz12AbCd/?img_index=3")
    assert.equal(sidecar.title, "Lions at dawn")
    assert.equal(sidecar.author, "natgeo")
    assert.equal(sidecar.height, 1080)
  })

  test("everything already there: no download at all", async () => {
    writeConfig()
    makeCatalog([{ id: "i1", path: "image/a.jpg", tool: "instagram", ref: "C9xYz12AbCd:1" }])
    const bridge = fakeBridge({
      "instagram.getPost": () => ({ username: "natgeo", code: "C9xYz12AbCd", items: [{ number: 1 }] })
    })
    const result = await instagramDownload(bridge, { url: "https://www.instagram.com/p/C9xYz12AbCd/" })
    assert.equal(result.saved.length, 0)
    assert.equal(bridge.called("instagram.download").length, 0)
  })

  test("without a library: no lookup, no sidecars", async () => {
    const file = touch(join(downloads, "natgeo - C9xYz12AbCd.jpg"))
    const bridge = fakeBridge({
      "instagram.download": () => ({ code: "C9xYz12AbCd", saved: [{ number: 1, path: file }] })
    })
    await instagramDownload(bridge, { url: "https://www.instagram.com/p/C9xYz12AbCd/" })
    assert.deepEqual(bridge.calls.map((c) => c.method), ["instagram.download"])
    assert.equal(existsSync(`${file}.source.json`), false)
  })
})

describe("Midjourney", () => {
  test("saves into the inbox's set folder with the prompt in each sidecar", async () => {
    writeConfig()
    const jobId = "0f6a5b1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b"
    const files = [0, 2].map((i) => touch(join(inbox, "midjourney", "devils", `${jobId}_${i}.png`), png(1456, 816)))
    const bridge = fakeBridge({
      "midjourney.downloadImages": () => ({ files, indexes: [0, 2], prompt: "a red devil --ar 16:9 --v 7" })
    })
    await downloadMidjourneyImages(bridge, { jobId, indexes: [0, 2], set: "devils" })
    const params = bridge.calls[0].params
    assert.equal(params.folder, "_INBOX/midjourney/devils")
    assert.equal(params.withPrompt, true)
    const sidecar = JSON.parse(readFileSync(`${files[1]}.source.json`, "utf8"))
    assert.deepEqual(
      { tool: sidecar.tool, ref: sidecar.ref, prompt: sidecar.prompt, model: sidecar.model, height: sidecar.height },
      { tool: "midjourney", ref: `${jobId}:2`, prompt: "a red devil --ar 16:9 --v 7", model: "v7", height: 816 }
    )
    assert.equal(sidecar.url, `https://cdn.midjourney.com/${jobId}/0_2.png`)
  })

  test("without a library: the old default folder and no sidecars", async () => {
    const file = touch(join(downloads, "midjourney", "job_0.png"), png(10, 10))
    const bridge = fakeBridge({ "midjourney.downloadImages": () => ({ files: [file] }) })
    await downloadMidjourneyImages(bridge, { jobId: "job", indexes: [0] })
    assert.equal(bridge.calls[0].params.folder, undefined)
    assert.equal(bridge.calls[0].params.withPrompt, undefined)
    assert.equal(existsSync(`${file}.source.json`), false)
  })
})

describe("Pinterest", () => {
  test("a session in the inbox skips what the library has and writes _session.json", async () => {
    writeConfig()
    makeCatalog([
      { id: "i1", path: "image/aa.jpg", tool: "pinterest", ref: "aa11" },
      { id: "i2", path: "footage/bb.mp4", tool: "pinterest", ref: "bb22" }
    ])
    mkdirSync(join(inbox, "pinterest", "2026-11-02-luffy"), { recursive: true })
    const bridge = fakeBridge({ "pinterest.bulkStart": (params) => ({ tabId: 1, folder: "x", ...params }) })
    await startPinterestBulk(bridge, { destination: "browser", perPageLimit: 20 })
    const params = bridge.calls[0].params
    assert.equal(params.inboxFolder, "_INBOX/pinterest")
    assert.deepEqual(params.takenFolders, ["2026-11-02-luffy"])
    assert.equal(params.manifest, true)
    assert.deepEqual([...params.skipPins].sort(), ["aa11", "bb22"])
    assert.deepEqual(params.skipVideos, ["bb22"])
    assert.equal(params.folder, undefined)
  })

  test("force downloads every pin; Mediamake uploads and no library change nothing", async () => {
    writeConfig()
    makeCatalog([{ id: "i1", path: "image/aa.jpg", tool: "pinterest", ref: "aa11" }])
    const bridge = fakeBridge({ "pinterest.bulkStart": () => ({}) })
    await startPinterestBulk(bridge, { destination: "browser", force: true })
    await startPinterestBulk(bridge, { destination: "mediamake" })
    rmSync(join(home, ".mediamake"), { recursive: true })
    await startPinterestBulk(bridge, { destination: "browser", folder: "pins" })
    const [forced, mediamake, plain] = bridge.calls.map((c) => c.params)
    assert.equal(forced.skipPins, undefined)
    assert.equal(forced.skipVideos, undefined)
    assert.equal(forced.manifest, true)
    assert.equal(mediamake.manifest, undefined)
    assert.equal(mediamake.inboxFolder, undefined)
    assert.equal(plain.folder, "pins")
    assert.equal(plain.manifest, undefined)
    assert.equal(plain.skipPins, undefined)
  })
})
