// Tests for the popup's Suno tab suggestions: npm test (Node strips the types).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { channelNameScore, suggestFor } from "./sunoPrefs.ts"

const workspaces = [
  "My Workspace",
  "anime zone",
  "Epic Instrumental",
  "Omkaram",
  "PHONK",
  "Inverted Devils",
  "blade-and-choir",
  "Instrumentals",
  "anthems - phonk"
].map((name) => ({ id: name, name }))

describe("suggesting a channel's workspace and project", () => {
  test("names that are the channel's, or close to it, are suggested", () => {
    assert.equal(suggestFor({ id: "animemusiczone", folder: "AMZ" }, workspaces)?.name, "anime zone")
    assert.equal(suggestFor({ id: "inverteddevils", folder: "INVERTED-DEVILS" }, workspaces)?.name, "Inverted Devils")
    assert.equal(suggestFor({ id: "bladeandchoir", folder: "BLADE AND CHOIR" }, workspaces)?.name, "blade-and-choir")
    assert.equal(suggestFor({ id: "omkara", folder: "omkaraswar" }, workspaces)?.name, "Omkaram")
    assert.equal(suggestFor({ id: "animemusiczone", folder: "AMZ" }, [{ name: "AnimeZone" }, { name: "Atomic Rap" }])?.name, "AnimeZone")
  })

  test("nothing is suggested for a channel no name fits, or that two fit as well", () => {
    assert.equal(suggestFor({ id: "getintozone", folder: "GIZ" }, workspaces), undefined)
    assert.equal(suggestFor({ id: "animesoundlike" }, workspaces), undefined)
    assert.equal(suggestFor({ id: "atomicrap" }, workspaces), undefined)
    assert.equal(suggestFor({ id: "phonk" }, [{ name: "phonk" }, { name: "PHONK" }]), undefined)
  })

  test("an exact name beats a close one", () => {
    assert.equal(channelNameScore({ id: "animemusiczone" }, "Anime Music Zone"), 3)
    assert.equal(channelNameScore({ id: "animemusiczone" }, "anime zone"), 2)
    assert.equal(suggestFor({ id: "animemusiczone" }, [{ name: "anime zone" }, { name: "Anime Music Zone" }])?.name, "Anime Music Zone")
  })
})
