// Tests for reading what suno.com's Create request asked for: npm test (Node strips the types).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { sentSettings, vocalGenderWarning } from "./sunoRequest.ts"

// The shape suno.com sent from its Create form on 11 Nov 2026 (v6-wild, Vocal Gender: Female), tokens left out.
const request = {
  generation_type: "TEXT",
  make_instrumental: false,
  metadata: {
    control_sliders: { aug_creativity: 1 },
    create_mode: "custom",
    create_surface: "desktop_create_form",
    is_max_mode: false,
    is_mumble: false,
    vocal_gender: "f",
    web_client_pathname: "/create"
  },
  mv: "chirp-hawk-wild",
  prompt: "[Verse]\nline one",
  tags: "dark trap",
  title: "Pride-Look On My Works"
}

describe("reading a Create request", () => {
  test("Vocal Gender: Female is metadata.vocal_gender f", () => {
    assert.deepEqual(sentSettings(JSON.stringify(request)), { vocalGender: "female", modelKey: "chirp-hawk-wild" })
  })

  test("male, and a request with no vocal gender", () => {
    const male = { ...request, metadata: { ...request.metadata, vocal_gender: "m" } }
    assert.equal(sentSettings(male).vocalGender, "male")
    const { vocal_gender, ...rest } = request.metadata
    assert.equal(sentSettings({ ...request, metadata: rest }).vocalGender, "none")
  })

  test("a body that isn't JSON says nothing", () => {
    assert.equal(sentSettings("not json"), undefined)
    assert.equal(sentSettings(undefined), undefined)
  })
})

describe("warning about the vocal gender", () => {
  test("nothing when the request asked for what the job wanted, or the job wanted none", () => {
    assert.equal(vocalGenderWarning("female", "female"), undefined)
    assert.equal(vocalGenderWarning(undefined, "none"), undefined)
    assert.equal(vocalGenderWarning(undefined, undefined), undefined)
  })

  test("says so when the request couldn't be read, so no warning always means it was checked", () => {
    assert.match(vocalGenderWarning("female", undefined), /couldn't read the vocal gender/)
  })

  test("says so when the request had none or the other one", () => {
    assert.match(vocalGenderWarning("female", "none"), /had no vocal gender, not female/)
    assert.match(vocalGenderWarning("female", "male"), /asked for male vocals, not female/)
  })
})
