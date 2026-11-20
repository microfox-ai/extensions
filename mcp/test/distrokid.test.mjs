// Tests for distrokid_song_details' skipExisting (src/distrokid.ts), run
// against the built files: npm test (builds first). Each test gets a fake home
// folder with Downloads/DistroKid/<artist>/ song JSONs.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

import { savedDistrokidReleases } from "../dist/distrokid.js"

let home

const song = (artist, name, fields) => {
  const folder = join(home, "Downloads", "DistroKid", artist)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, `${name}.json`), JSON.stringify(fields))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "browse-hack-distrokid-"))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("savedDistrokidReleases", () => {
  test("no DistroKid folder: nothing saved", async () => {
    assert.deepEqual(await savedDistrokidReleases(home), [])
  })

  test("singles and complete albums count, in every artist folder; half-saved albums don't", async () => {
    song("Get into Zone", "Inexorable", { albumUuid: "aaaa-1", trackNumber: 1, trackCount: 1 })
    song("Subhodayam", "Bhargavi", { albumUuid: "BBBB-2", trackNumber: 1, trackCount: 1 })
    song("Get into Zone", "EP - 01 One", { albumUuid: "CCCC-3", trackNumber: 1, trackCount: 2 })
    song("Get into Zone", "EP - 02 Two", { albumUuid: "CCCC-3", trackNumber: 2, trackCount: 2 })
    song("Get into Zone", "Half - 01 One", { albumUuid: "DDDD-4", trackNumber: 1, trackCount: 2 })
    // Not a song JSON, or not JSON at all.
    song("Get into Zone", "notes", { title: "no albumUuid" })
    writeFileSync(join(home, "Downloads", "DistroKid", "Get into Zone", "broken.json"), "{")
    writeFileSync(join(home, "Downloads", "DistroKid", "Get into Zone", "Inexorable.wav"), "")
    assert.deepEqual((await savedDistrokidReleases(home)).sort(), ["AAAA-1", "BBBB-2", "CCCC-3"])
  })
})
