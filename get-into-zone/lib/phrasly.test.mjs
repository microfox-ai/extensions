// Tests for Phrasly's limits, its drafts and Browse Hack's Phrasly settings
// (lib/phrasly/text.ts, lib/phraslyPrefs.ts): npm test (Node strips the types).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  MAX_WORDS,
  MIN_WORDS,
  addDraft,
  checkWords,
  cleanOutput,
  draftNumber,
  isNewOutput,
  sameText,
  startWatch,
  watchStep,
  wordCount
} from "./phrasly/text.ts"
import {
  DEFAULT_PHRASLY_PREFS,
  addRun,
  localDayStart,
  modeName,
  readPhraslyPrefs,
  readSettings,
  readUsage,
  sentencesName,
  settingsFor,
  settingsToChange,
  ultraWarning,
  usageToday
} from "./phraslyPrefs.ts"

const words = (n, word = "word") => Array.from({ length: n }, (_, i) => `${word}${i}`).join(" ")

describe("Phrasly's word limits", () => {
  test("29 words is refused, 30 and 5,000 are taken, 5,001 is refused", () => {
    assert.equal(MIN_WORDS, 30)
    assert.equal(MAX_WORDS, 5000)
    const short = checkWords(words(29))
    assert.equal(short.ok, false)
    assert.equal(short.words, 29)
    assert.match(short.error, /29 words is too short.*at least 30/)
    assert.deepEqual(checkWords(words(30)), { ok: true, words: 30 })
    assert.deepEqual(checkWords(words(5000)), { ok: true, words: 5000 })
    const long = checkWords(words(5001))
    assert.equal(long.ok, false)
    assert.match(long.error, /5001 words is more than one Phrasly run takes \(5000\).*paragraph/)
  })

  test("words are counted across lines, tabs and doubled spaces", () => {
    assert.equal(wordCount("one  two\nthree\tfour\n\nfive "), 5)
    assert.equal(wordCount(""), 0)
    assert.equal(wordCount(undefined), 0)
    assert.equal(checkWords("one").error.startsWith("1 word is too short"), true)
  })
})

describe("the drafts Phrasly gives back", () => {
  test("the output view's text is tidied, paragraphs kept", () => {
    const raw = "  First sentence , with a span gap .​  Second one!\n\n\n\nNext   paragraph ;  here ?  \r\n"
    assert.equal(cleanOutput(raw), "First sentence, with a span gap. Second one!\n\nNext paragraph; here?")
    assert.equal(cleanOutput(null), "")
  })

  test("a draft button's label gives its number", () => {
    assert.equal(draftNumber("Draft 3"), 3)
    assert.equal(draftNumber("draft  2 of 5"), 2)
    assert.equal(draftNumber("Next draft"), null)
    assert.equal(draftNumber("Draft"), null)
    assert.equal(draftNumber(null), null)
  })

  test("drafts are numbered as the page numbers them, else next, and repeats are marked", () => {
    let drafts = addDraft([], "One take of it .", 1)
    drafts = addDraft(drafts, "Another take.", 2)
    assert.deepEqual(drafts.map((d) => d.draft), [1, 2])
    assert.equal(drafts[0].text, "One take of it.")
    assert.equal(drafts[0].words, 4)
    // humanized afresh: the page starts again at Draft 1
    drafts = addDraft(drafts, "A third  take.", 1)
    assert.equal(drafts[2].draft, 3)
    drafts = addDraft(drafts, "Another   take.", null)
    assert.deepEqual(drafts[3], { draft: 4, text: "Another take.", words: 2, sameAs: 2 })
    assert.equal(sameText("a  b\nc", " a b c "), true)
  })
})

describe("watching a run settle", () => {
  const output = words(42, "out")
  const start = (over = {}) => startWatch({ before: "", beforeDraft: null, inWords: 40, ...over }, 0)
  const obs = (over = {}) => ({ output, busy: false, captcha: null, refusal: null, draft: 1, ...over })

  test("an output counts once unchanged for 4 s with Humanize free", () => {
    let s = start()
    let r = watchStep(s, obs({ busy: true }), 5000)
    assert.equal(r.kind, "wait")
    r = watchStep(r.state, obs({ busy: true }), 6000)
    assert.equal(r.kind, "wait")
    r = watchStep(r.state, obs({ busy: true }), 11000)
    assert.equal(r.kind, "wait", "still busy")
    r = watchStep(r.state, obs(), 12000)
    assert.equal(r.kind, "done")
    assert.equal(r.output, output)
    assert.equal(r.draft, 1)
    assert.equal(r.seconds, 12)
  })

  test("a changing output starts the 4 s again", () => {
    let r = watchStep(start(), obs({ output: words(30, "a") }), 1000)
    r = watchStep(r.state, obs({ output: words(30, "a") }), 2000)
    r = watchStep(r.state, obs({ output: words(35, "a") }), 5500)
    assert.equal(r.kind, "wait")
    r = watchStep(r.state, obs({ output: words(35, "a") }), 6000)
    r = watchStep(r.state, obs({ output: words(35, "a") }), 9000)
    assert.equal(r.kind, "wait")
    r = watchStep(r.state, obs({ output: words(35, "a") }), 10000)
    assert.equal(r.kind, "done")
  })

  test("the previous output, a partial one or a far longer one never counts", () => {
    const s = start({ before: output, beforeDraft: 1 })
    assert.equal(isNewOutput(s, { output, draft: 1 }), false)
    assert.equal(isNewOutput(s, { output, draft: 2 }), true, "the same words as a new draft number")
    assert.equal(isNewOutput(s, { output: words(19, "x"), draft: 2 }), false)
    assert.equal(isNewOutput(s, { output: words(101, "x"), draft: 2 }), false)
    assert.equal(isNewOutput(s, { output: words(20, "x"), draft: 1 }), true)
    let r = watchStep(s, obs({ draft: 1 }), 1000)
    r = watchStep(r.state, obs({ draft: 1 }), 9000)
    assert.equal(r.kind, "wait")
  })

  test("a captcha stops the watch at once; the page's refusal after 1.5 s", () => {
    assert.deepEqual(watchStep(start(), obs({ captcha: "Please complete the captcha" }), 500), { kind: "captcha", detail: "Please complete the captcha" })
    assert.equal(watchStep(start(), obs({ refusal: "Word limit reached" }), 1000).kind, "wait")
    assert.deepEqual(watchStep(start(), obs({ refusal: "Word limit reached" }), 2000), { kind: "refused", detail: "Word limit reached" })
  })

  test("nothing within the timeout says what the page shows", () => {
    const r = watchStep(start(), obs({ output: "", busy: true }), 300_000, { timeoutMs: 300_000 })
    assert.equal(r.kind, "timeout")
    assert.match(r.detail, /within 300 s .*shows nothing; Humanize still busy/)
  })

  test("a first humanization showing nothing after 45 s is pressed once more", () => {
    const quiet = obs({ output: "", busy: false })
    assert.equal(watchStep(start(), quiet, 46_000).kind, "wait", "drafts are never pressed again")
    const r = watchStep(start(), quiet, 46_000, { canRepress: true })
    assert.equal(r.kind, "repress")
    assert.equal(watchStep(r.state, quiet, 50_000, { canRepress: true }).kind, "wait")
    assert.equal(watchStep(start(), obs({ output: "", busy: true }), 46_000, { canRepress: true }).kind, "wait")
  })
})

describe("Browse Hack's Phrasly settings", () => {
  test("nothing stored gives the pacing defaults and no page settings", () => {
    assert.deepEqual(readPhraslyPrefs(undefined), DEFAULT_PHRASLY_PREFS)
    assert.deepEqual(DEFAULT_PHRASLY_PREFS, { minGapSeconds: 60, jobTimeoutSeconds: 300, ultraWarnAt: 40 })
  })

  test("stored defaults are kept with when they were read; bad values are dropped or clamped", () => {
    const prefs = readPhraslyPrefs({
      defaults: { model: " Phrasly Ultra ", mode: "max", sentences: "shorter", other: { Commas: true, Grammar: "yes", "": false }, readAt: "2026-11-11T10:00:00.000Z" },
      minGapSeconds: 5000,
      jobTimeoutSeconds: 2,
      ultraWarnAt: "40"
    })
    assert.deepEqual(prefs, {
      minGapSeconds: 600,
      jobTimeoutSeconds: 30,
      ultraWarnAt: 40,
      defaults: { model: "Phrasly Ultra", mode: "Max", sentences: "Shorter", other: { Commas: true }, readAt: "2026-11-11T10:00:00.000Z" }
    })
    assert.equal(readPhraslyPrefs({ defaults: { model: "Phrasly Ultra" } }).defaults, undefined, "no readAt: never read off the page")
  })

  test("modes and sentence lengths are named the page's way", () => {
    assert.equal(modeName("MAX"), "Max")
    assert.equal(modeName(1), "Gentle")
    assert.equal(modeName("4"), "Strong")
    assert.equal(modeName("Aggressive"), "Aggressive", "a name the page may use is passed on as is")
    assert.equal(modeName(9), undefined)
    assert.equal(sentencesName("LONGER"), "Longer")
    assert.deepEqual(readSettings({ strength: "balanced", sentences: "shorter", extra: 1, model: "" }), { mode: "Balanced", sentences: "Shorter" })
  })

  test("a run uses the defaults with the call's overrides on top", () => {
    const defaults = { model: "Phrasly Ultra", mode: "Max", sentences: "Shorter" }
    assert.deepEqual(settingsFor(defaults, undefined), { wanted: defaults, overridden: [] })
    assert.deepEqual(settingsFor(defaults, { mode: "balanced", sentences: "shorter" }), {
      wanted: { model: "Phrasly Ultra", mode: "Balanced", sentences: "Shorter" },
      overridden: ["mode"]
    })
    assert.deepEqual(settingsFor(undefined, { mode: 2 }), { wanted: { mode: "Light" }, overridden: ["mode"] })
  })

  test("only the settings the page has otherwise are changed", () => {
    const page = { model: "Phrasly Ultra", mode: "Max", sentences: "Longer" }
    assert.deepEqual(settingsToChange(page, { model: "phrasly ultra", mode: "Strong", sentences: "Longer" }), ["mode"])
    assert.deepEqual(settingsToChange({ model: "Phrasly Ultra" }, { sentences: "Shorter" }), ["sentences"])
    assert.deepEqual(settingsToChange(page, {}), [])
  })
})

describe("today's runs and Ultra documents", () => {
  // Built in local time, so the day boundary is the computer's whatever the time zone.
  const at = (day, hour, minute = 0) => new Date(2026, 10, day, hour, minute).getTime()

  test("the day starts at local midnight", () => {
    assert.equal(localDayStart(at(11, 15, 30)), at(11, 0))
    assert.equal(localDayStart(at(11, 0)), at(11, 0))
  })

  test("only today's runs count, and only Ultra ones as Ultra", () => {
    let runs = []
    runs = addRun(runs, at(10, 23, 59), "Phrasly Ultra")
    runs = addRun(runs, at(11, 0, 1), "Phrasly Ultra")
    runs = addRun(runs, at(11, 9), "Balanced")
    runs = addRun(runs, at(11, 14), "phrasly ultra")
    assert.deepEqual(usageToday(runs, at(11, 15)), { runsToday: 3, ultraToday: 2 })
    assert.deepEqual(usageToday(runs, at(12, 8)), { runsToday: 0, ultraToday: 0 })
  })

  test("runs older than two days are dropped as new ones come", () => {
    let runs = [{ at: at(8, 12), ultra: true }, { at: at(10, 13), ultra: true }]
    runs = addRun(runs, at(11, 14), "Phrasly Ultra")
    assert.deepEqual(runs.map((r) => r.at), [at(10, 13), at(11, 14)])
    assert.deepEqual(readUsage({ runs: [{ at: 5, ultra: true }, { at: "x" }, null, { at: 7 }] }), [
      { at: 5, ultra: true },
      { at: 7, ultra: false }
    ])
    assert.deepEqual(readUsage(undefined), [])
  })

  test("the warning starts at 40 Ultra documents and is stronger from 50", () => {
    assert.equal(ultraWarning(39, 40), undefined)
    assert.match(ultraWarning(40, 40), /^40 Ultra documents today: Phrasly may move the plan off Ultra after about 50/)
    assert.match(ultraWarning(50, 40), /^50 Ultra documents today: .*standard model.*Ask the user/)
  })
})
