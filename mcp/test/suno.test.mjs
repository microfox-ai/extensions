// Tests for src/suno.ts and src/sunoBatch.ts, run against the built files:
// npm test (builds first). Each test gets a fake home folder with
// ~/.mediamake/config.json and a fake extension bridge.

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, test } from "node:test"

process.env.BROWSE_HACK_BATCH_POLL_MS = "20"
process.env.BROWSE_HACK_SUNO_POLL_MS = "10"

const { sourceRecord } = await import("../dist/library.js")
const {
  checkSong,
  clipIdOf,
  coverSong,
  coverSource,
  createSongs,
  downloadSongs,
  formJob,
  resetSync,
  songFileBase,
  songSet
} = await import("../dist/suno.js")
const { pauseSunoBatch, startSunoBatch, sunoBatchStatus } = await import("../dist/sunoBatch.js")

const A = "1a2b3c4d-1111-4aaa-8aaa-111111111111"
const B = "5e6f7a8b-2222-4bbb-8bbb-222222222222"
const ROOT_SONG = "9c0d1e2f-3333-4ccc-8ccc-333333333333"
const WORKSPACE = "4d5e6f70-4444-4ddd-8ddd-444444444444"

let home, downloads, root, inbox, savedHome

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "browse-hack-suno-"))
  downloads = join(home, "Downloads")
  root = join(downloads, "_LIBRARY")
  inbox = join(downloads, "_INBOX")
  savedHome = process.env.HOME
  process.env.HOME = home
  resetSync()
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

function writeConfig(channels = { animemusiczone: "AMZ", inverteddevils: { folder: "INVERTED-DEVILS", projectId: "p-devils" } }) {
  mkdirSync(join(home, ".mediamake"), { recursive: true })
  writeFileSync(
    join(home, ".mediamake", "config.json"),
    JSON.stringify({ library: { root: "~/Downloads/_LIBRARY", inbox: "~/Downloads/_INBOX", channels } })
  )
}

function touch(path, content = "x") {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

// items: { id, path, title, rights, suno } — `suno` is the Suno song it came from.
function makeCatalog(items) {
  mkdirSync(join(root, ".catalog"), { recursive: true })
  const db = new DatabaseSync(join(root, ".catalog", "library.db"))
  db.exec(
    "CREATE TABLE items(id TEXT PRIMARY KEY, path TEXT, kind TEXT, title TEXT, rights TEXT, duration REAL, height INT, fps REAL, status TEXT);" +
      "CREATE TABLE sources(item_id TEXT, tool TEXT, ref TEXT, UNIQUE(tool, ref));"
  )
  for (const item of items) {
    db.prepare("INSERT INTO items VALUES (?, ?, 'music', ?, ?, 200, NULL, NULL, 'online')").run(item.id, item.path, item.title ?? null, item.rights ?? null)
    if (item.suno) db.prepare("INSERT INTO sources VALUES (?, 'suno', ?)").run(item.id, item.suno)
    touch(join(root, item.path))
  }
  db.close()
}

const song = (id, extra = {}) => ({
  id,
  title: "DBZ - Goten Theme - dark enya",
  status: "complete",
  styles: "gregorian chant, slow",
  lyrics: "[Instrumental]",
  instrumental: true,
  model: "v6-wild",
  duration: 223.6,
  settings: { styleInfluence: 80, variety: 1 },
  parent: { id: ROOT_SONG, relation: "cover" },
  root: { id: ROOT_SONG, title: "DBZ - Goten Theme" },
  workspace: { id: WORKSPACE, name: "anime zone" },
  pageUrl: `https://suno.com/song/${id}`,
  author: "test-artist",
  ...extra
})

const prefs = {
  channels: [
    { id: "animemusiczone", folder: "AMZ", workspaceId: WORKSPACE, workspaceName: "anime zone" },
    { id: "inverteddevils", folder: "INVERTED-DEVILS", projectId: "p-devils" }
  ],
  inboxFolder: "_INBOX",
  downloadFormat: "mp3"
}

// Records every call; answers from `answers[method](params)`, with defaults for the Suno basics.
function fakeBridge(answers = {}) {
  const calls = []
  const defaults = {
    "suno.syncLibrary": () => ({}),
    "suno.prefs": () => prefs,
    "suno.status": () => ({ account: { creditsLeft: 7000, downloads: { left: 40, limit: 60 } } }),
    "suno.record": ({ clips }) => ({ recorded: clips.length }),
    "suno.rate": () => ({ rated: true }),
    "suno.workspaces": () => ({ workspaces: [{ id: WORKSPACE, name: "anime zone" }, { id: "default", name: "My Workspace" }] })
  }
  return {
    calls,
    called: (method) => calls.filter((c) => c.method === method),
    call: async (method, params) => {
      calls.push({ method, params })
      const answer = answers[method] ?? defaults[method]
      if (!answer) throw new Error(`unexpected call: ${method}`)
      return answer(params)
    }
  }
}

describe("songs: names, folders and sidecars", () => {
  test("file names keep the title and the id's start; sets come from the song's name", () => {
    assert.equal(songFileBase({ id: A, title: 'Goten: "Theme" / dark' }), "Goten Theme dark [1a2b3c4d]")
    assert.equal(songFileBase({ id: A, title: "" }), "Untitled [1a2b3c4d]")
    assert.equal(songSet("DBZ - Goten Theme - dark enya (Remastered)"), "dbz-goten-theme")
    assert.equal(clipIdOf(`https://suno.com/song/${A}?sh=x`), A)
    assert.equal(clipIdOf("not a song"), undefined)
  })

  test("Suno fields go into the sidecar in order; false and objects are kept, empties left out", () => {
    const record = sourceRecord(
      {
        tool: "suno",
        ref: A,
        pageUrl: `https://suno.com/song/${A}`,
        title: "Song",
        prompt: "gregorian chant",
        model: "v6-wild",
        price: 10,
        lyrics: "",
        instrumental: false,
        settings: { weirdness: 50, vocalGender: undefined },
        parentRef: ROOT_SONG,
        relation: "cover",
        workspace: { id: WORKSPACE, name: "anime zone" },
        channel: "animemusiczone"
      },
      new Date("2026-11-02T10:00:00Z")
    )
    assert.deepEqual(Object.keys(record), [
      "schema",
      "tool",
      "ref",
      "pageUrl",
      "title",
      "prompt",
      "model",
      "price",
      "instrumental",
      "settings",
      "parentRef",
      "relation",
      "workspace",
      "channel",
      "downloadedAt"
    ])
    assert.equal(record.instrumental, false)
    assert.deepEqual(record.settings, { weirdness: 50 })
  })
})

describe("requests", () => {
  test("limits and missing content are caught before Suno", () => {
    assert.deepEqual(checkSong({ styles: "rock" }, true), [])
    assert.match(checkSong({}, true).join(), /needs lyrics, styles/)
    assert.match(checkSong({ styles: "x".repeat(1001) }, true).join(), /styles is 1001 characters/)
    assert.match(checkSong({ weirdness: 120, styles: "a" }, true).join(), /weirdness must be 0-100/)
    assert.match(checkSong({ lyrics: "la", instrumental: true }, false).join(), /not both/)
    assert.deepEqual(checkSong({}, false), [])
  })

  test("the form job leaves out what wasn't asked for", () => {
    assert.deepEqual(formJob({ styles: "rock", weirdness: 60, channel: "x", wait: false }, "anime zone"), {
      styles: "rock",
      weirdness: 60,
      workspaceName: "anime zone"
    })
  })
})

describe("cover sources", () => {
  const sha = (c) => c.repeat(64)

  test("a Suno id or link covers that song", async () => {
    assert.deepEqual(await coverSource(`https://suno.com/song/${A}`, false), { songId: A })
  })

  test("a library item that came from Suno covers its Suno song, with no upload", async () => {
    writeConfig()
    makeCatalog([{ id: sha("a"), path: "music/amz/goten/Goten.mp3", title: "Goten", suno: ROOT_SONG }])
    assert.deepEqual(await coverSource(sha("a"), false), { songId: ROOT_SONG, sourceItem: sha("a"), title: "Goten" })
  })

  test("other library items need recorded rights or the user's word, then upload their file", async () => {
    writeConfig()
    makeCatalog([
      { id: sha("b"), path: "music/amz/x/Track.mp3", title: "Track" },
      { id: sha("c"), path: "music/amz/y/Mine.wav", title: "Mine", rights: "own" }
    ])
    await assert.rejects(coverSource(sha("b"), false), /doesn't record that you own or license "Track"/)
    const confirmed = await coverSource(sha("b"), true)
    assert.equal(confirmed.file.mime, "audio/mpeg")
    assert.equal(confirmed.sourceItem, sha("b"))
    assert.equal((await coverSource(sha("c"), false)).file.name, "Mine.wav")
  })

  test("a file path needs rightsConfirmed and an audio type Suno takes", async () => {
    const file = touch(join(home, "song.flac"))
    await assert.rejects(coverSource(file, false), /Ask the user whether they own or license it/)
    assert.equal((await coverSource(file, true)).file.mime, "audio/flac")
    await assert.rejects(coverSource(touch(join(home, "clip.mp4")), true), /Suno takes/)
    await assert.rejects(coverSource("relative/song.mp3", true), /isn't a Suno song/)
  })
})

describe("making songs", () => {
  test("create: fills the form in the channel's workspace, waits, records both takes, downloads nothing", async () => {
    writeConfig()
    let polls = 0
    const bridge = fakeBridge({
      "suno.generate": () => ({ clipIds: [A, B], warnings: [], creditsBefore: 7000 }),
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id, { status: ++polls > 2 ? "complete" : "streaming" })) })
    })
    const result = await createSongs(bridge, { styles: "gregorian chant", instrumental: true, channel: "animemusiczone" })
    const generate = bridge.called("suno.generate")[0].params
    assert.equal(generate.mode, "create")
    assert.equal(generate.workspaceId, WORKSPACE)
    assert.deepEqual(generate.job, { instrumental: true, styles: "gregorian chant", workspaceName: "anime zone" })
    assert.equal(result.finished, true)
    assert.equal(result.recorded, 2)
    assert.deepEqual(result.songs.map((s) => s.id), [A, B])
    assert.equal(bridge.called("suno.download").length, 0)
    assert.equal(bridge.called("suno.syncLibrary")[0].params.inboxFolder, "_INBOX")
  })

  test("wait: false returns the ids at once", async () => {
    const bridge = fakeBridge({ "suno.generate": () => ({ clipIds: [A, B] }) })
    const result = await createSongs(bridge, { lyrics: "la la", wait: false })
    assert.deepEqual(result.clipIds, [A, B])
    assert.equal(bridge.called("suno.clips").length, 0)
  })

  test("a workspace by name, and an unknown one listed", async () => {
    const bridge = fakeBridge({ "suno.generate": () => ({ clipIds: [A] }) })
    await createSongs(bridge, { lyrics: "la", workspace: "Anime Zone", wait: false })
    assert.equal(bridge.called("suno.generate")[0].params.workspaceId, WORKSPACE)
    await assert.rejects(createSongs(bridge, { lyrics: "la", workspace: "Nope", wait: false }), /Workspaces: anime zone, My Workspace/)
  })

  test("a cover of a file streams it to the extension in pieces, then makes the cover", async () => {
    const file = touch(join(home, "mine.mp3"), Buffer.alloc(700 * 1024, 1))
    const bridge = fakeBridge({
      "suno.uploadOpen": () => ({ sessionId: "s1" }),
      "suno.uploadChunk": () => ({ ok: true }),
      "suno.generate": () => ({ clipIds: [A, B] })
    })
    await coverSong(bridge, { from: file, rightsConfirmed: true, styles: "metal", wait: false })
    assert.equal(bridge.called("suno.uploadChunk").length, 2)
    const generate = bridge.called("suno.generate")[0].params
    assert.equal(generate.uploadSessionId, "s1")
    assert.equal(generate.mode, "cover")
    assert.equal(generate.songId, undefined)
  })
})

describe("downloads", () => {
  test("into the channel's inbox folder with a sidecar, marked keeper; the library's songs are skipped", async () => {
    writeConfig()
    // A song already downloaded and waiting in the inbox.
    const old = touch(join(inbox, "suno", "animemusiczone", "dbz-goten-theme", "Old [5e6f7a8b].mp3"))
    writeFileSync(`${old}.source.json`, JSON.stringify({ tool: "suno", ref: B }))
    let made = 0
    const bridge = fakeBridge({
      "suno.status": () => ({ account: { downloads: { left: 40 - made, limit: 60 } } }),
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id)) }),
      "suno.download": ({ folder, base }) => {
        made++
        return { path: touch(join(downloads, folder, `${base}.mp3`)) }
      }
    })
    const result = await downloadSongs(bridge, { ids: [A, B] })
    assert.deepEqual(result.alreadyHave.map((h) => h.id), [B])
    assert.equal(result.saved.length, 1)
    const call = bridge.called("suno.download")[0].params
    assert.equal(call.folder, "_INBOX/suno/animemusiczone/dbz-goten-theme")
    assert.equal(call.base, "DBZ - Goten Theme - dark enya [1a2b3c4d]")
    const sidecar = JSON.parse(readFileSync(result.saved[0].sidecar, "utf8"))
    assert.equal(sidecar.tool, "suno")
    assert.equal(sidecar.ref, A)
    assert.equal(sidecar.channel, "animemusiczone")
    assert.equal(sidecar.parentRef, ROOT_SONG)
    assert.equal(sidecar.instrumental, true)
    assert.equal(sidecar.lyrics, undefined)
    assert.deepEqual(bridge.called("suno.rate").map((c) => c.params), [{ ref: A, rating: "keeper" }])
    assert.equal(result.downloadsLeft, 39)
  })

  test("refuses when the month's downloads won't cover it", async () => {
    writeConfig()
    const bridge = fakeBridge({
      "suno.status": () => ({ account: { downloads: { left: 1, limit: 60 } } }),
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id)) })
    })
    await assert.rejects(downloadSongs(bridge, { ids: [A, B] }), /1 downloads left this month and this needs 2/)
    assert.equal(bridge.called("suno.download").length, 0)
  })

  test("songs downloaded before don't count against the month's downloads", async () => {
    writeConfig()
    const bridge = fakeBridge({
      "suno.status": () => ({ account: { downloads: { left: 1, limit: 60 } } }),
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id, { downloadUnlocked: id === B })) }),
      "suno.download": ({ folder, base }) => ({ path: touch(join(downloads, folder, `${base}.mp3`)) })
    })
    const result = await downloadSongs(bridge, { ids: [A, B] })
    assert.equal(result.saved.length, 2)
  })

  test("unfinished songs aren't downloaded", async () => {
    writeConfig()
    const bridge = fakeBridge({ "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id, { status: "streaming" })) }) })
    const result = await downloadSongs(bridge, { ids: [A] })
    assert.match(result.failed[0].error, /isn't finished/)
  })
})

describe("the model asked for", () => {
  test("suno_create warns when the songs came out on another model, and when the form showed another one", async () => {
    writeConfig()
    const bridge = fakeBridge({
      "suno.generate": () => ({ clipIds: [A, B], model: "v6" }),
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id, { model: "v6" })) })
    })
    const result = await createSongs(bridge, { styles: "rock", model: "v6-wild" })
    assert.equal(result.modelMismatch.asked, "v6-wild")
    assert.deepEqual(result.modelMismatch.songs.map((s) => s.model), ["v6", "v6"])
    assert.ok(result.warnings.some((w) => /made on v6, not v6-wild/.test(w)), result.warnings.join("; "))
    assert.ok(result.warnings.some((w) => /form showed model v6, not v6-wild/.test(w)), result.warnings.join("; "))
  })

  test("the right model raises no warning, however it is spelled", async () => {
    writeConfig()
    const bridge = fakeBridge({
      "suno.generate": () => ({ clipIds: [A, B], model: "v6-wild" }),
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id, { model: "v6-wild" })) })
    })
    const result = await createSongs(bridge, { styles: "rock", model: "V6 Wild" })
    assert.equal(result.modelMismatch, undefined)
    assert.equal(result.warnings, undefined)
  })
})

describe("batches", () => {
  const waitFor = async (check, ms = 3000) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > ms) throw new Error("timed out")
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  test("runs jobs, records each when its songs finish, and resumes as done", async () => {
    const folder = join(home, "batch")
    let n = 0
    const bridge = fakeBridge({
      "suno.generate": () => ({ clipIds: [`00000000-0000-4000-8000-00000000000${n}`, `00000000-0000-4000-8000-00000000001${n++}`] }),
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id)) })
    })
    await startSunoBatch(bridge, {
      folder,
      channel: "animemusiczone",
      jobs: [
        { name: "one", styles: "rock" },
        { name: "two", mode: "cover", from: A, styles: "metal" }
      ]
    })
    await waitFor(() => JSON.parse(readFileSync(join(folder, "state.json"), "utf8")).jobs.two?.status === "done")
    const status = await sunoBatchStatus(bridge, { folder, waitMs: 2000 })
    assert.equal(status.done, 2)
    assert.equal(bridge.called("suno.record").length, 2)
    assert.equal(bridge.called("suno.generate")[1].params.songId, A)
    assert.ok(existsSync(join(folder, "run.log")))
  })

  test("a captcha pauses without using up an attempt; low credits pause the batch", async () => {
    const folder = join(home, "batch2")
    let tries = 0
    const bridge = fakeBridge({
      "suno.generate": () => {
        tries++
        throw new Error("Suno is asking for a check (captcha) in the Browse Hack Suno tab.")
      }
    })
    await startSunoBatch(bridge, { folder, jobs: [{ name: "one", styles: "rock" }] })
    await waitFor(() => tries > 0)
    const status = await sunoBatchStatus(bridge, { folder })
    assert.match(status.waitingFor, /captcha/)
    const state = JSON.parse(readFileSync(join(folder, "state.json"), "utf8"))
    assert.equal(state.jobs.one.status, "todo")
    assert.equal(state.jobs.one.attempts, undefined)
    pauseSunoBatch(bridge, { folder })

    const poor = fakeBridge({ "suno.status": () => ({ account: { creditsLeft: 50 } }) })
    const folder3 = join(home, "batch3")
    await startSunoBatch(poor, { folder: folder3, jobs: [{ name: "one", styles: "rock" }] })
    const low = await sunoBatchStatus(poor, { folder: folder3, waitMs: 2000 })
    assert.match(low.waitingFor, /50 credits left/)
    assert.equal(poor.called("suno.generate").length, 0)
  })

  test("a job whose songs came out on another model fails, with their ids, and is made again on retryFailed", async () => {
    const folder = join(home, "batch-model")
    let n = 0
    const bridge = fakeBridge({
      "suno.generate": () => ({ clipIds: [`00000000-0000-4000-8000-00000000000${n}`, `00000000-0000-4000-8000-00000000001${n++}`], model: "v6-wild" }),
      // Suno made them on v6 (major_model_version) although the job asked for v6-wild.
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id, { model: "v6" })) })
    })
    await startSunoBatch(bridge, {
      folder,
      concurrency: 2,
      jobs: [
        { name: "wild", styles: "rock", model: "v6-wild" },
        { name: "plain", styles: "rock", model: "V6" }
      ]
    })
    const status = await sunoBatchStatus(bridge, { folder, waitMs: 3000 })
    assert.equal(status.state, "done")
    assert.equal(status.done, 1, "the v6 job is done")
    assert.equal(status.failed, 1, "the v6-wild job failed")
    assert.match(status.failedJobs[0].error, /made on v6, not v6-wild \(00000000-0000-4000-8000-000000000000, 00000000-0000-4000-8000-000000000010\)/)
    assert.equal(bridge.called("suno.record").length, 2, "both jobs' songs are recorded")
    const log = readFileSync(join(folder, "run.log"), "utf8")
    assert.match(log, /error wild: Suno made on v6, not v6-wild/)
    assert.match(log, /done plain .* model V6 confirmed/)

    // retryFailed makes the job again instead of polling the wrong songs.
    await startSunoBatch(bridge, { folder, retryFailed: true })
    await sunoBatchStatus(bridge, { folder, waitMs: 3000 })
    assert.equal(bridge.called("suno.generate").length, 3)
    assert.equal(bridge.called("suno.generate")[2].params.job.model, "v6-wild")
  })

  test("creates go to the extension one at a time, even from two callers", async () => {
    writeConfig()
    let inside = 0
    let overlapped = false
    const bridge = fakeBridge({
      "suno.generate": async ({ job }) => {
        inside++
        if (inside > 1) overlapped = true
        await new Promise((r) => setTimeout(r, 30))
        inside--
        return { clipIds: [A], model: job.model }
      },
      "suno.clips": ({ ids }) => ({ songs: ids.map((id) => song(id, { model: "v6-wild" })) })
    })
    const results = await Promise.all([
      createSongs(bridge, { styles: "rock", model: "v6-wild", wait: false }),
      createSongs(bridge, { styles: "rock", model: "v6-wild", wait: false })
    ])
    assert.equal(overlapped, false)
    assert.equal(results[0].formModel, "v6-wild")
  })

  test("bad jobs are refused up front", async () => {
    const bridge = fakeBridge()
    await assert.rejects(startSunoBatch(bridge, { folder: join(home, "b4"), jobs: [{ name: "x" }] }), /needs lyrics, styles/)
    await assert.rejects(startSunoBatch(bridge, { folder: join(home, "b5"), jobs: [{ name: "x", mode: "cover" }] }), /needs from/)
  })
})
