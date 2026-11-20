// Tests for DistroKid song details runs: npm test. Chrome's tabs, scripting
// and downloads are faked; so are DistroKid's release pages.
//
// What they guard (the Get into Zone run of 2026-11-20):
// - a release whose page took too long, after which Chrome had dropped the tab,
//   no longer fails every release after it ("No tab with id");
// - a cover whose download Chrome asks to name twice (it resumed after a
//   network timeout) or never, still lands in DistroKid/<artist>/.

import assert from "node:assert/strict"
import { register } from "node:module"
import { beforeEach, describe, test } from "node:test"

// The extension's modules import each other without ".ts" (Plasmo resolves it).
register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        try {
          return await next(specifier, context)
        } catch (error) {
          if (/^\\.\\.?\\//.test(specifier) && !/\\.[cm]?[jt]s$/.test(specifier)) return next(specifier + ".ts", context)
          throw error
        }
      }
    `)
)

const DOWNLOADS = "/Users/me/Downloads"

let tabs
let nextTab
let failLoads // album uuid -> how many loads of it still fail (and lose the tab)
let downloads
let nextDownload = 1 // Chrome never gives an id twice
let determine // url -> how Chrome names each download of it, in turn: "once" | "twice" | "never"
let removed

globalThis.chrome = {
  runtime: { id: "browse-hack" },
  tabs: {
    create: async ({ url }) => {
      const tab = { id: nextTab++, url, status: "complete" }
      tabs.set(tab.id, tab)
      return { ...tab }
    },
    update: async (id, { url }) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`)
      tabs.get(id).url = url
      return { ...tabs.get(id) }
    },
    get: async (id) => {
      const tab = tabs.get(id)
      if (!tab) throw new Error(`No tab with id: ${id}.`)
      const uuid = new URL(tab.url).searchParams.get("albumuuid")
      if (uuid && failLoads.get(uuid) > 0) {
        failLoads.set(uuid, failLoads.get(uuid) - 1)
        // The page never finished, and Chrome dropped the tab meanwhile.
        tabs.delete(id)
        throw new Error("The tab took too long to load.")
      }
      return { ...tab }
    },
    remove: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`)
      tabs.delete(id)
    },
    onUpdated: { addListener() {}, removeListener() {} }
  },
  scripting: {
    executeScript: async ({ target }) => {
      const tab = tabs.get(target.tabId)
      if (!tab) throw new Error(`No tab with id: ${target.tabId}.`)
      return [{ result: pageOf(tab.url) }]
    }
  },
  downloads: {
    download: async ({ url, filename }) => {
      const item = { id: nextDownload++, url, byExtensionId: "browse-hack", mime: url.startsWith("data:") ? "application/json" : "image/jpeg" }
      downloads.set(item.id, item)
      const how = determine.get(url)?.shift() ?? "once"
      // Chrome names the download after download() answers.
      setTimeout(() => {
        let name
        if (how !== "never") name = askedName(item)?.filename
        // A download resumed after a network timeout is named again.
        if (how === "twice") name = askedName(item)?.filename
        item.filename = `${DOWNLOADS}/${name ?? url.split("/").pop()}`
        item.state = "complete"
      }, 1)
      return item.id
    },
    search: async ({ id }) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return [{ ...downloads.get(id) }]
    },
    onChanged: { addListener() {}, removeListener() {} },
    erase: async () => [],
    removeFile: async (id) => removed.push(downloads.get(id).filename)
  },
  storage: {
    session: { get: async () => ({}), set: async () => {} },
    local: { get: async () => ({}), set: async () => {} }
  }
}

const releases = {
  "AAAA-1111-2222-3333-444455556666": "Inexorable",
  "BBBB-1111-2222-3333-444455556666": "The Bird Of Hermes",
  "CCCC-1111-2222-3333-444455556666": "Our Eternal Pilgrim"
}
const cover = (uuid) => `https://s3.amazonaws.com/gather.fandalism.com/3000x3000-10279478--${uuid}--mod-1.jpg`

function pageOf(url) {
  if (url.includes("/mymusic/")) {
    return Object.entries(releases).map(([albumUuid, title]) => ({ title, artist: "Get into Zone", albumUuid }))
  }
  const uuid = new URL(url).searchParams.get("albumuuid")
  const title = releases[uuid]
  return {
    albumUuid: uuid,
    distrokidLink: url,
    title,
    artist: "Get into Zone",
    upc: "",
    releaseDate: "",
    releaseDateText: "",
    uploadDate: "",
    uploadDateText: "",
    recordLabel: "",
    status: "",
    aiTagged: false,
    storeLinks: [],
    artworkUrl: cover(uuid),
    artworkSize: "3000x3000",
    warnings: [],
    tracks: [{ number: 1, title, isrc: "", plainLyrics: "", credits: [], audioUrl: "", audioName: "", audioType: "" }]
  }
}

// readDistrokidReleases filters by artist; the fake page already returns rows.
const { askedName } = await import("./downloads.ts")
const { distrokidSongDetails, inAskedFolder } = await import("./distrokidSongs.ts")

const run = (request) =>
  distrokidSongDetails({ genre: false, audio: false, lyrics: false, credits: false, ...request })

beforeEach(() => {
  tabs = new Map()
  nextTab = 100
  failLoads = new Map()
  downloads = new Map()
  determine = new Map()
  removed = []
})

describe("an artist's run", () => {
  test("a release whose page timed out (and lost its tab) is read again in a fresh tab; the rest still run", async () => {
    failLoads.set("AAAA-1111-2222-3333-444455556666", 1)
    const result = await run({ artist: "Get into Zone", save: false })
    assert.deepEqual(
      result.songs.map((song) => song.release),
      ["Inexorable", "The Bird Of Hermes", "Our Eternal Pilgrim"]
    )
    assert.deepEqual(result.errors, [])
    assert.equal(tabs.size, 0, "the run closes its tab")
  })

  test("a release that fails twice is listed once and the run goes on", async () => {
    failLoads.set("BBBB-1111-2222-3333-444455556666", 2)
    const result = await run({ artist: "Get into Zone", save: false })
    assert.deepEqual(
      result.songs.map((song) => song.release),
      ["Inexorable", "Our Eternal Pilgrim"]
    )
    assert.equal(result.errors.length, 1)
    assert.match(result.errors[0], /^The Bird Of Hermes: The tab took too long to load\. \(tried twice/)
  })

  test("skip leaves out releases already saved", async () => {
    const result = await run({ artist: "Get into Zone", save: false, skip: ["aaaa-1111-2222-3333-444455556666"] })
    assert.deepEqual(
      result.songs.map((song) => song.release),
      ["The Bird Of Hermes", "Our Eternal Pilgrim"]
    )
    assert.deepEqual(result.skipped, ["Inexorable"])
  })
})

describe("covers", () => {
  test("a cover Chrome names twice (resumed download) keeps its name", async () => {
    determine.set(cover("AAAA-1111-2222-3333-444455556666"), ["twice"])
    const result = await run({ album: "AAAA-1111-2222-3333-444455556666" })
    assert.equal(result.songs[0].artworkFile, `${DOWNLOADS}/DistroKid/Get into Zone/Inexorable.jpg`)
    assert.deepEqual(removed, [])
  })

  test("a cover Chrome saved loose in Downloads is downloaded again into the artist folder, and the stray removed", async () => {
    // Never named (a service worker restart would lose the name the same way), then named.
    determine.set(cover("BBBB-1111-2222-3333-444455556666"), ["never", "once"])
    const result = await run({ album: "BBBB-1111-2222-3333-444455556666" })
    assert.equal(result.songs[0].artworkFile, `${DOWNLOADS}/DistroKid/Get into Zone/The Bird Of Hermes.jpg`)
    assert.deepEqual(removed, [`${DOWNLOADS}/3000x3000-10279478--BBBB-1111-2222-3333-444455556666--mod-1.jpg`])
    assert.deepEqual(result.errors, [])
  })

  test("a PNG behind a .jpg link is saved as <release>.png", async () => {
    const original = chrome.downloads.download
    chrome.downloads.download = async (options) => {
      const id = await original(options)
      if (options.url.startsWith("https:")) downloads.get(id).mime = "image/png"
      return id
    }
    try {
      const result = await run({ album: "CCCC-1111-2222-3333-444455556666" })
      assert.equal(result.songs[0].artworkFile, `${DOWNLOADS}/DistroKid/Get into Zone/Our Eternal Pilgrim.png`)
    } finally {
      chrome.downloads.download = original
    }
  })

  test("inAskedFolder", () => {
    assert.equal(inAskedFolder("/Users/me/Downloads/DistroKid/A/x.png", "DistroKid/A/x.jpg"), true)
    assert.equal(inAskedFolder("C:\\Users\\me\\Downloads\\DistroKid\\A\\x.jpg", "DistroKid/A/x.jpg"), true)
    assert.equal(inAskedFolder("/Users/me/Downloads/3000x3000-x.jpg", "DistroKid/A/x.jpg"), false)
    assert.equal(inAskedFolder("/Users/me/Downloads/DistroKid/AB/x.jpg", "DistroKid/A/x.jpg"), false)
  })
})
