// Tests for src/phrasly.ts, run against the built files: npm test.
// The bridge is a fake that records what would go to the extension.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  DEFAULT_DRAFTS,
  MAX_DRAFTS,
  MAX_WORDS,
  MIN_WORDS,
  checkText,
  countWords,
  draftCount,
  humanize,
  humanizeTimeout,
  phraslySettings,
  phraslyStatus,
  readOverrides
} from "../dist/phrasly.js"

const words = (n) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ")

function fakeBridge(answer = { ok: true, drafts: [] }) {
  const calls = []
  return {
    calls,
    async call(method, params, timeoutMs) {
      calls.push({ method, params, timeoutMs })
      return typeof answer === "function" ? answer(method, params) : answer
    }
  }
}

describe("Phrasly's limits, checked before anything is sent", () => {
  test("30 to 5,000 words, 1 to 5 drafts, 3 by default", () => {
    assert.equal(MIN_WORDS, 30)
    assert.equal(MAX_WORDS, 5000)
    assert.equal(MAX_DRAFTS, 5)
    assert.equal(DEFAULT_DRAFTS, 3)
  })

  test("29 words is refused, 30 and 5,000 are taken, 5,001 is refused", () => {
    assert.throws(() => checkText(words(29)), /29 words is too short for Phrasly \(it needs at least 30\), so nothing was sent/)
    assert.equal(checkText(words(30)), 30)
    assert.equal(checkText(words(5000)), 5000)
    assert.throws(() => checkText(words(5001)), /5001 words is more than one Phrasly run takes \(5000\), so nothing was sent\. Split it/)
    assert.throws(() => checkText("   \n "), /text is empty/)
    assert.throws(() => checkText(undefined), /text is empty/)
    assert.equal(countWords("a  b\nc\td"), 4)
  })

  test("drafts outside 1 to 5 are refused", () => {
    assert.equal(draftCount(undefined), 3)
    assert.equal(draftCount(5), 5)
    for (const bad of [0, 6, 2.5, "x"]) assert.throws(() => draftCount(bad), /drafts is 1 to 5/)
  })

  test("a run's overrides are tidied, and unknown modes refused", () => {
    assert.equal(readOverrides(undefined), undefined)
    assert.equal(readOverrides({}), undefined)
    assert.deepEqual(readOverrides({ model: " Phrasly Ultra ", mode: "max", sentences: "SHORTER" }), {
      model: "Phrasly Ultra",
      mode: "Max",
      sentences: "Shorter"
    })
    assert.deepEqual(readOverrides({ mode: 3 }), { mode: "Balanced" })
    assert.deepEqual(readOverrides({ mode: "1" }), { mode: "Gentle" })
    assert.throws(() => readOverrides({ mode: "turbo" }), /mode is one of Gentle, Light, Balanced, Strong, Max/)
    assert.throws(() => readOverrides({ mode: 6 }), /mode is one of/)
    assert.throws(() => readOverrides({ sentences: "medium" }), /sentences is Longer or Shorter/)
    assert.throws(() => readOverrides("max"), /settings is an object/)
  })
})

describe("phrasly_humanize", () => {
  test("too few words never reach the extension", async () => {
    const bridge = fakeBridge()
    await assert.rejects(humanize(bridge, { text: words(29), drafts: 3 }), /29 words is too short/)
    await assert.rejects(humanize(bridge, { text: words(40), drafts: 6 }), /drafts is 1 to 5/)
    await assert.rejects(humanize(bridge, { text: words(40), settings: { mode: "turbo" } }), /mode is one of/)
    assert.deepEqual(bridge.calls, [])
  })

  test("sends the text, the drafts and the overrides, with time for every draft", async () => {
    const bridge = fakeBridge({ ok: true, drafts: [{ draft: 1, text: "x", words: 1 }], settingsUsed: { model: "Phrasly Ultra" } })
    const text = words(40)
    const result = await humanize(bridge, { text, drafts: 3, settings: { mode: "strong" } })
    assert.deepEqual(bridge.calls, [
      { method: "phrasly.humanize", params: { text, drafts: 3, settings: { mode: "Strong" } }, timeoutMs: humanizeTimeout(3) }
    ])
    assert.equal(humanizeTimeout(3), 120_000 + 3 * 360_000)
    assert.equal(result.wordsIn, 40)
    assert.deepEqual(result.settingsUsed, { model: "Phrasly Ultra" })
  })

  test("asks for 3 drafts by default and leaves settings out when none are given", async () => {
    const bridge = fakeBridge()
    await humanize(bridge, { text: words(35) })
    assert.deepEqual(bridge.calls[0].params, { text: words(35), drafts: 3 })
    assert.equal(bridge.calls[0].timeoutMs, humanizeTimeout(3))
  })

  test("a captcha comes back as the extension says it, drafts so far included", async () => {
    const needs = {
      ok: false,
      needsUser: "captcha",
      message: "Phrasly is asking for a captcha …",
      tabId: 7,
      drafts: [{ draft: 1, text: "kept", words: 1 }],
      draftsWanted: 3
    }
    const result = await humanize(fakeBridge(needs), { text: words(40), drafts: 3 })
    assert.deepEqual(result, needs)
  })
})

describe("phrasly_settings and phrasly_status", () => {
  test("reading the stored defaults is quick; refreshing them from the page gets longer", async () => {
    const bridge = fakeBridge({ defaults: null })
    await phraslySettings(bridge, {})
    await phraslySettings(bridge, { refresh: true })
    assert.deepEqual(bridge.calls, [
      { method: "phrasly.settings", params: { refresh: false }, timeoutMs: 15_000 },
      { method: "phrasly.settings", params: { refresh: true }, timeoutMs: 120_000 }
    ])
  })

  test("status asks the extension", async () => {
    const bridge = fakeBridge({ ultraToday: 41, warning: "41 Ultra documents today" })
    assert.deepEqual(await phraslyStatus(bridge), { ultraToday: 41, warning: "41 Ultra documents today" })
    assert.deepEqual(bridge.calls, [{ method: "phrasly.status", params: {}, timeoutMs: 20_000 }])
  })
})
