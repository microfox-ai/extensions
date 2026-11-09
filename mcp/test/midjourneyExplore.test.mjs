// Tests for src/midjourneyExplore.ts, run against the built files: npm test.
// The jobs below have the shape midjourney.com's /api/explore answered on
// 9 Nov 2026 (ids, names and prompts made up).

import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, beforeEach, describe, test } from "node:test"

import {
  downloadExplore,
  exploreMidjourney,
  exploreMidjourneyStyles,
  exploreResults,
  forgetShown,
  parseExploreRef,
  promptCommand,
  styleResult
} from "../dist/midjourneyExplore.js"
import { localDate } from "../dist/library.js"

const JOB = "f77b8322-e954-4a25-93eb-c6fb5a203e01"
const VIDEO = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"

const prompt = (overrides = {}) => ({
  no: [],
  images: [],
  stop: null,
  chaos: null,
  ar: { w: 5, h: 7 },
  seed: null,
  speed: null,
  visibility: null,
  batchSize: null,
  exp: null,
  sd: false,
  decodedPrompt: [{ content: "a paper collage of a lighthouse, risograph texture", weight: 1 }],
  params: null,
  version: "8.2",
  quality: null,
  tile: false,
  styleRaw: false,
  styleRef: [{ t: "seed", content: "3808026652", weight: 1 }],
  personalize: [{ content: "hptnc8n", weight: 1 }],
  pv: null,
  sv: null,
  sw: null,
  depthRef: [],
  dw: null,
  stylize: null,
  weird: null,
  imageWeight: null,
  video: false,
  draft: false,
  hd: false,
  editRef: [],
  ev: null,
  ...overrides
})

// Explore hides every image of a grid but the one its maker published.
const items = (published) =>
  [0, 1, 2, 3].map((i) => ({ filtered: false, liked_by_user: false, actions: {}, server_filtered: i !== published }))

const job = (overrides = {}) => ({
  isFeedJob: true,
  id: JOB,
  job_type: "v8-2_diffusion",
  event_type: "diffusion",
  enqueue_time: 1791887106315,
  parent_grid: null,
  parent_id: null,
  width: 928,
  height: 1312,
  username_v2: "paper.maker",
  display_name: "paper.maker",
  user_id: "2d227322-d477-483f-a0b6-e5c670a79153",
  prompt: prompt(),
  published: true,
  items: items(1),
  owner_profile: null,
  type: "image",
  video_segments: null,
  ...overrides
})

describe("prompts", () => {
  test("the site's parsed prompt comes back as a command, flags in Midjourney's order", () => {
    assert.equal(
      promptCommand(prompt()),
      "a paper collage of a lighthouse, risograph texture --ar 5:7 --sref 3808026652 --p hptnc8n --v 8.2"
    )
    assert.equal(
      promptCommand(
        prompt({
          no: ["text, watermark"],
          chaos: 10,
          stylize: 250,
          weird: 4,
          exp: 15,
          sw: 300,
          styleRaw: true,
          hd: true,
          styleRef: [
            { t: "seed", content: "373368000", weight: 1 },
            { t: "url", content: "https://s.mj.run/abc", weight: 2 }
          ],
          personalize: [],
          version: "niji 7"
        })
      ),
      "a paper collage of a lighthouse, risograph texture --no text, watermark --ar 5:7 --chaos 10 --exp 15 --stylize 250 " +
        "--weird 4 --sref 373368000 https://s.mj.run/abc::2 --sw 300 --raw --hd --niji 7"
    )
  })

  test("image prompts lead, multi-prompts keep their weights, and a prompt string stays as it is", () => {
    assert.equal(
      promptCommand(
        prompt({
          images: ["https://s.mj.run/img1"],
          decodedPrompt: [
            { content: "fog", weight: 2 },
            { content: "harbour", weight: 1 }
          ],
          styleRef: [],
          personalize: true,
          ar: null
        })
      ),
      "https://s.mj.run/img1 fog::2 harbour --p --v 8.2"
    )
    assert.equal(promptCommand("  a cat --v 7 "), "a cat --v 7")
  })
})

describe("results", () => {
  test("an image job gives its published image, with links, codes and maker", () => {
    const [result, ...rest] = exploreResults(job())
    assert.equal(rest.length, 0)
    assert.deepEqual(result, {
      ref: `mj:${JOB}#1`,
      jobId: JOB,
      index: 1,
      type: "image",
      url: `https://cdn.midjourney.com/${JOB}/0_1.png`,
      preview: `https://cdn.midjourney.com/${JOB}/0_1_384_N.webp`,
      page: `https://www.midjourney.com/jobs/${JOB}?index=1`,
      prompt: "a paper collage of a lighthouse, risograph texture --ar 5:7 --sref 3808026652 --p hptnc8n --v 8.2",
      srefs: ["3808026652"],
      personalize: ["hptnc8n"],
      model: "v8.2",
      ar: "5:7",
      width: 928,
      height: 1312,
      author: "paper.maker",
      authorId: "2d227322-d477-483f-a0b6-e5c670a79153",
      createdAt: "2026-10-13T10:25:06.315Z"
    })
  })

  test("a video job links its MP4; a job without a published index falls back to its first image; junk gives nothing", () => {
    const [video] = exploreResults(job({ id: VIDEO, type: "video", event_type: "video_diffusion", items: items(0) }))
    assert.equal(video.type, "video")
    assert.equal(video.url, `https://cdn.midjourney.com/video/${VIDEO}/0.mp4`)
    assert.equal(video.preview, `https://cdn.midjourney.com/video/${VIDEO}/0_384_N.webp`)
    assert.equal(exploreResults(job({ items: [] }))[0].index, 0)
    assert.deepEqual(exploreResults({ id: "nope" }), [])
    assert.deepEqual(exploreResults(null), [])
  })

  test("a style gives its --sref code, page and previews", () => {
    assert.deepEqual(styleResult({ id: "0_3808026652", formatted_sref: "3808026652" }), {
      sref: "3808026652",
      use: "--sref 3808026652",
      page: "https://www.midjourney.com/styles/0_3808026652",
      grid: "https://cdn.midjourney.com/styles/0_3808026652/grid_3x3_640_N.webp",
      samples: {
        portrait: "https://cdn.midjourney.com/styles/0_3808026652/portrait_640_N.webp",
        landscape: "https://cdn.midjourney.com/styles/0_3808026652/landscape_640_N.webp",
        "still life": "https://cdn.midjourney.com/styles/0_3808026652/still_life_640_N.webp"
      }
    })
    assert.equal(styleResult({ id: "", formatted_sref: "42" }).page, "https://www.midjourney.com/styles/0_42")
    assert.equal(styleResult({}), undefined)
  })

  test("refs are read from what midjourney_explore gives and from links", () => {
    assert.deepEqual(parseExploreRef(`mj:${JOB}#2`), { jobId: JOB, index: 2 })
    assert.deepEqual(parseExploreRef(`${JOB}:3`), { jobId: JOB, index: 3 })
    assert.deepEqual(parseExploreRef(`https://www.midjourney.com/jobs/${JOB}?index=1`), { jobId: JOB, index: 1 })
    assert.deepEqual(parseExploreRef(`https://cdn.midjourney.com/${JOB}/0_0.png`), { jobId: JOB, index: 0 })
    assert.deepEqual(parseExploreRef(JOB.toUpperCase()), { jobId: JOB })
    assert.equal(parseExploreRef("a cat"), undefined)
  })
})

// Records every call; answers from `answers[method](params)`.
function fakeBridge(answers = {}) {
  const calls = []
  return {
    calls,
    called: (method) => calls.filter((c) => c.method === method),
    call: async (method, params) => {
      calls.push({ method, params })
      const answer = answers[method]
      if (!answer) throw new Error(`Unknown method: ${method}`)
      return answer(params)
    }
  }
}

describe("midjourney_explore and midjourney_explore_styles", () => {
  beforeEach(forgetShown)

  test("a search passes its words and pages and returns results up to the limit", async () => {
    const jobs = [job(), job({ id: VIDEO, items: items(2) })]
    const bridge = fakeBridge({
      "midjourney.explore": (params) => ({ query: params.query, jobs, page: 1, nextPage: 2, signedIn: true })
    })
    const answer = await exploreMidjourney(bridge, { query: "risograph lighthouse", pages: 2, limit: 1 })
    assert.deepEqual(bridge.calls[0].params, { query: "risograph lighthouse", pages: 2 })
    assert.equal(answer.query, "risograph lighthouse")
    assert.equal(answer.found, 2)
    assert.equal(answer.nextPage, 2)
    assert.deepEqual(answer.results.map((r) => r.ref), [`mj:${JOB}#1`])
    assert.equal(answer.note, undefined)
  })

  test("signed out, a feed other than top_month says why it got Top month", async () => {
    const bridge = fakeBridge({
      "midjourney.explore": (params) => ({ feed: params.feed, jobs: [job()], page: 1, nextPage: 2, signedIn: false })
    })
    assert.match((await exploreMidjourney(bridge, { feed: "hot" })).note, /isn't signed in/)
    assert.equal((await exploreMidjourney(bridge, { feed: "top_month" })).note, undefined)
  })

  test("styles come back as --sref codes", async () => {
    const bridge = fakeBridge({
      "midjourney.exploreStyles": () => ({
        feed: "styles_top",
        styles: [{ id: "0_1", formatted_sref: "1" }, { nonsense: true }],
        page: 1,
        nextPage: null
      })
    })
    const answer = await exploreMidjourneyStyles(bridge, {})
    assert.equal(answer.feed, "styles_top")
    assert.deepEqual(answer.styles.map((s) => s.use), ["--sref 1"])
  })

  test("an extension without Explore asks for an update", async () => {
    await assert.rejects(exploreMidjourney(fakeBridge(), { query: "x" }), /Browse Hack 0\.17\.0 or later.*update_browse_hack/)
  })
})

describe("midjourney_explore_download", () => {
  let home, downloads, root, inbox, savedHome

  beforeEach(() => {
    forgetShown()
    home = mkdtempSync(join(tmpdir(), "browse-hack-explore-"))
    downloads = join(home, "Downloads")
    root = join(downloads, "_LIBRARY")
    inbox = join(downloads, "_INBOX")
    savedHome = process.env.HOME
    process.env.HOME = home
  })

  afterEach(() => {
    process.env.HOME = savedHome
    rmSync(home, { recursive: true, force: true })
  })

  const writeConfig = () => {
    mkdirSync(join(home, ".mediamake"), { recursive: true })
    writeFileSync(
      join(home, ".mediamake", "config.json"),
      JSON.stringify({ library: { root: "~/Downloads/_LIBRARY", inbox: "~/Downloads/_INBOX" } })
    )
  }

  const touch = (path, content = "x") => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
    return path
  }

  const png = (width, height) => {
    const header = Buffer.alloc(24)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
    header.writeUInt32BE(13, 8)
    header.write("IHDR", 12, "ascii")
    header.writeUInt32BE(width, 16)
    header.writeUInt32BE(height, 20)
    return header
  }

  // The extension "saves" each file where it was asked to.
  const saving = (extra = {}) =>
    fakeBridge({
      "midjourney.explore": (params) => ({
        query: params.query,
        jobs: [job(), job({ id: VIDEO, type: "video", event_type: "video_diffusion", items: items(0) })],
        page: 1,
        nextPage: 2,
        signedIn: true
      }),
      "midjourney.downloadImages": (params) => ({
        files: params.indexes.map((i) =>
          touch(
            join(downloads, params.folder, `${params.jobId}_${i}.${params.video ? "mp4" : "png"}`),
            params.video ? "mp4" : png(928, 1312)
          )
        ),
        indexes: params.indexes
      }),
      "extension.info": () => ({ version: "0.17.0" }),
      ...extra
    })

  test("saves what a search showed into the inbox's references, with the prompt, maker and search in each sidecar", async () => {
    writeConfig()
    const bridge = saving()
    await exploreMidjourney(bridge, { query: "Risograph lighthouse" })
    const answer = await downloadExplore(bridge, { items: [`mj:${JOB}#1`, `mj:${VIDEO}#0`] })
    const folder = `_INBOX/midjourney/references/${localDate()}-risograph-lighthouse`
    assert.equal(answer.folder, folder)
    const downloadsCalls = bridge.called("midjourney.downloadImages").map((c) => c.params)
    assert.deepEqual(downloadsCalls, [
      { jobId: JOB, indexes: [1], folder },
      { jobId: VIDEO, indexes: [0], folder, video: true }
    ])
    assert.equal(answer.saved.length, 2)
    const sidecar = JSON.parse(readFileSync(answer.saved[0].sidecar, "utf8"))
    assert.deepEqual(
      {
        tool: sidecar.tool,
        ref: sidecar.ref,
        url: sidecar.url,
        pageUrl: sidecar.pageUrl,
        title: sidecar.title,
        author: sidecar.author,
        query: sidecar.query,
        prompt: sidecar.prompt,
        model: sidecar.model,
        height: sidecar.height
      },
      {
        tool: "midjourney",
        ref: `${JOB}:1`,
        url: `https://cdn.midjourney.com/${JOB}/0_1.png`,
        pageUrl: `https://www.midjourney.com/jobs/${JOB}?index=1`,
        title: "a paper collage of a lighthouse, risograph texture",
        author: "paper.maker",
        query: "Risograph lighthouse",
        prompt: "a paper collage of a lighthouse, risograph texture --ar 5:7 --sref 3808026652 --p hptnc8n --v 8.2",
        model: "v8.2",
        height: 1312
      }
    )
    assert.ok(answer.saved[1].path.endsWith(`${VIDEO}_0.mp4`))
  })

  test("what the library has comes back as alreadyHave, unless forced", async () => {
    writeConfig()
    mkdirSync(join(root, ".catalog"), { recursive: true })
    const db = new DatabaseSync(join(root, ".catalog", "library.db"))
    db.exec(
      "CREATE TABLE items(id TEXT PRIMARY KEY, path TEXT, height INT, fps REAL, status TEXT);" +
        "CREATE TABLE sources(item_id TEXT, tool TEXT, ref TEXT, UNIQUE(tool, ref));"
    )
    db.prepare("INSERT INTO items VALUES (?, ?, ?, ?, ?)").run("i1", "references/misc/lighthouse.png", 1312, null, "online")
    db.prepare("INSERT INTO sources VALUES (?, ?, ?)").run("i1", "midjourney", `${JOB}:1`)
    db.close()
    touch(join(root, "references/misc/lighthouse.png"))

    // A bare job id is the image Explore showed of it.
    const bridge = saving()
    await exploreMidjourney(bridge, { query: "lighthouse" })
    const answer = await downloadExplore(bridge, { items: [JOB], set: "lighthouses" })
    assert.equal(answer.saved.length, 0)
    assert.equal(answer.alreadyHave[0].where, "library")
    assert.equal(bridge.called("midjourney.downloadImages").length, 0)

    const forced = await downloadExplore(bridge, { items: [`${JOB}:1`], set: "lighthouses", force: true })
    assert.equal(forced.saved.length, 1)
    assert.equal(forced.folder, "_INBOX/midjourney/references/lighthouses")
  })

  test("without a library: Downloads/midjourney-explore/<set> and no sidecars", async () => {
    const bridge = saving()
    const answer = await downloadExplore(bridge, { items: [`mj:${JOB}#2`], set: "boats" })
    assert.equal(answer.folder, "midjourney-explore/boats")
    assert.equal(answer.saved[0].sidecar, undefined)
    assert.equal(existsSync(`${answer.saved[0].path}.source.json`), false)
  })

  test("videos need the newer extension; a failed job is reported, the others still saved", async () => {
    const old = saving({ "extension.info": () => ({ version: "0.16.4" }) })
    await exploreMidjourney(old, { query: "x" })
    await assert.rejects(downloadExplore(old, { items: [`mj:${VIDEO}#0`] }), /videos needs Browse Hack 0\.17\.0/)

    const flaky = saving({
      "midjourney.downloadImages": (params) => {
        if (params.jobId === VIDEO) throw new Error("Video 0 of job x isn't on Midjourney's CDN yet")
        return { files: [touch(join(downloads, params.folder, `${params.jobId}_1.png`), png(1, 1))] }
      }
    })
    const answer = await downloadExplore(flaky, { items: [`mj:${JOB}#1`, `mj:${VIDEO}#0`], set: "mix" })
    assert.equal(answer.saved.length, 1)
    assert.deepEqual(answer.failed.map((f) => f.ref), [`mj:${VIDEO}#0`])
  })

  test("anything that isn't a Midjourney job is refused before saving", async () => {
    await assert.rejects(downloadExplore(saving(), { items: ["a cat"] }), /Not a Midjourney job: a cat/)
  })
})
