// Tests for src/tripo.ts, run against the built files: npm test (builds first).
// Each test gets a fake home folder with ~/.mediamake/config.json and a fake
// extension bridge.

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

process.env.BROWSE_HACK_TRIPO_POLL_MS = "5"

const { sourceRecord } = await import("../dist/library.js")
const { creditCheck, downloadModels, generateJob, generateModels, modelIdOf } = await import("../dist/tripo.js")

const OWN = "9ad419a5-1c12-4f1b-9292-f857a76269e9"
const GALLERY = "6bd25611-3b93-4159-95a6-5c5acb896e9f"
const LOCKED = "fa920624-fa25-48cc-b0cd-303d542c48c0"

let home, inbox, savedHome

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "browse-hack-tripo-"))
  inbox = join(home, "Downloads", "_INBOX")
  savedHome = process.env.HOME
  process.env.HOME = home
  mkdirSync(join(home, ".mediamake"), { recursive: true })
  writeFileSync(join(home, ".mediamake", "config.json"), JSON.stringify({ library: { root: "~/Downloads/_LIBRARY", inbox: "~/Downloads/_INBOX" } }))
})

afterEach(() => {
  process.env.HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

function touch(path, content = "x") {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

// Records every call; answers from answers[method](params).
function fakeBridge(answers = {}) {
  const calls = []
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params })
      const answer = answers[method]
      if (typeof answer === "function") return answer(params, calls)
      if (answer !== undefined) return answer
      if (method === "tripo.syncLibrary") return { inboxFolder: params.inboxFolder }
      throw new Error(`unexpected call ${method}`)
    }
  }
}

const models = {
  [OWN]: { id: OWN, title: "3d character model", owner: true, download: { route: "viewer", credits: 0 } },
  [GALLERY]: { id: GALLERY, title: "anime doll", owner: false, download: { route: "export", credits: 5, usesMonthlyExport: true } },
  [LOCKED]: { id: LOCKED, title: "witch", owner: false, download: { no: "Tripo's page has no model file for this one.", needs: "noFile" } }
}

describe("model links", () => {
  test("ids from links and ids", () => {
    assert.equal(modelIdOf(`https://studio.tripo3d.ai/3d-model/anime-characters-${GALLERY}`), GALLERY)
    assert.equal(modelIdOf(`https://studio.tripo3d.ai/workspace/generate/${OWN}`), OWN)
    assert.equal(modelIdOf(OWN.toUpperCase()), OWN)
    assert.equal(modelIdOf(`https://evil.example/3d-model/x-${OWN}`), undefined)
    assert.equal(modelIdOf("robot"), undefined)
  })
})

describe("the credit check", () => {
  test("refuses when the account is short", () => {
    const c = creditCheck({ balance: 100, pricePerModel: 55, count: 2, approvedCredits: 110 })
    assert.equal(c.ok, false)
    assert.equal(c.short, 10)
    assert.match(c.reason, /needs 110 Tripo credits \(2 × 55\) and the account has 100/)
    assert.equal(c.needsApproval, undefined)
  })

  test("asks for the user's OK before spending", () => {
    const none = creditCheck({ balance: 605, pricePerModel: 55, count: 1 })
    assert.equal(none.ok, false)
    assert.equal(none.needsApproval, true)
    assert.match(none.reason, /approvedCredits: 55/)
    assert.equal(creditCheck({ balance: 605, pricePerModel: 55, count: 2, approvedCredits: 55 }).needsApproval, true)
  })

  test("goes ahead inside the balance and the approval", () => {
    assert.deepEqual(creditCheck({ balance: 605, pricePerModel: 55, count: 2, approvedCredits: 110 }), { ok: true, total: 110 })
  })
})

describe("the source.json", () => {
  test("keeps the licence, after the other keys", () => {
    const record = sourceRecord(
      {
        tool: "tripo",
        ref: OWN,
        pageUrl: `https://studio.tripo3d.ai/workspace/generate/${OWN}`,
        title: "3d character model",
        model: "Tripo H3.1 (v3.1-20260211)",
        license: "Own model, made on Tripo's Free plan",
        settings: { via: "viewer", tPose: true }
      },
      new Date("2026-11-12T10:00:00Z")
    )
    assert.deepEqual(Object.keys(record), ["schema", "tool", "ref", "pageUrl", "title", "model", "settings", "license", "downloadedAt"])
    assert.equal(record.license, "Own model, made on Tripo's Free plan")
  })
})

describe("tripo_download", () => {
  const bridge = (extra = {}) =>
    fakeBridge({
      "tripo.model": ({ id }) => models[id],
      "tripo.download": ({ id, approvedCredits }) => ({ id, file: `${inbox}/tripo/${id}.glb`, price: models[id].download.credits, approvedCredits }),
      ...extra
    })

  test("downloads what the account may, says why not for the rest, and keeps gallery spending inside the approval", async () => {
    const b = bridge()
    const out = await downloadModels(b, { ids: [OWN, LOCKED, GALLERY, "robot"], approvedCredits: 0 })
    assert.equal(out.results[0].id, OWN)
    assert.match(out.results[0].file, /tripo/)
    assert.match(out.results[1].notDownloadable, /no model file/)
    assert.equal(out.results[2].needsApproval, true)
    assert.equal(out.results[2].credits, 5)
    assert.match(out.results[3].error, /Not a Tripo model/)
    const downloads = b.calls.filter((c) => c.method === "tripo.download")
    assert.deepEqual(downloads.map((c) => c.params.id), [OWN])
    assert.equal(downloads[0].params.folder, "_INBOX/tripo")
    assert.deepEqual(b.calls[0], { method: "tripo.syncLibrary", params: { inboxFolder: "_INBOX" } })
  })

  test("with approvedCredits, exports the gallery model and counts what it cost", async () => {
    const b = bridge()
    const out = await downloadModels(b, { ids: [GALLERY, GALLERY], approvedCredits: 7 })
    assert.equal(out.results[0].price, 5)
    assert.equal(out.results[1].needsApproval, true, "the second export would go past the 7 agreed")
    assert.equal(out.approvedCreditsLeft, 2)
    assert.equal(b.calls.find((c) => c.method === "tripo.download").params.approvedCredits, 5)
  })

  test("via goes through to the extension, for the verdict and the download", async () => {
    const b = bridge({ "tripo.model": ({ id, via }) => ({ ...models[id], download: { route: via === "export" ? "export" : "viewer", credits: 0 } }) })
    await downloadModels(b, { ids: [OWN], via: "viewer" })
    assert.equal(b.calls.find((c) => c.method === "tripo.model").params.via, "viewer")
    assert.equal(b.calls.find((c) => c.method === "tripo.download").params.via, "viewer")
  })

  test("what the inbox already has comes back as alreadyHave", async () => {
    const glb = touch(join(inbox, "tripo", "3d-character-model-9ad419a5-meshopt.glb"))
    touch(`${glb}.source.json`, JSON.stringify({ schema: "mediamake.source/v1", tool: "tripo", ref: OWN }))
    const b = bridge()
    const out = await downloadModels(b, { ids: [OWN] })
    assert.equal(out.results[0].alreadyHave.path, glb)
    assert.equal(b.calls.some((c) => c.method === "tripo.download"), false)
    const forced = await downloadModels(b, { ids: [OWN], force: true })
    assert.match(forced.results[0].file, /\.glb$/)
  })

  test("stops at a captcha and hands it to the user", async () => {
    const b = bridge({ "tripo.download": () => ({ needsUser: "captcha", tabId: 9, message: "clear it" }) })
    const out = await downloadModels(b, { ids: [OWN, OWN], force: true })
    assert.equal(out.results.length, 1)
    assert.equal(out.results[0].needsUser, "captcha")
  })
})

describe("tripo_generate", () => {
  const prep = { price: 55, model: "H3.1", tPose: true, account: { credits: 605, plan: "Free" }, warnings: [] }

  test("nothing is generated without the user's OK; it says what it would cost", async () => {
    const b = fakeBridge({ "tripo.prepare": prep })
    const out = await generateModels(b, { prompt: "a robot in a T-pose", tPose: true, count: 2 })
    assert.equal(out.generated, 0)
    assert.equal(out.needsApproval, true)
    assert.equal(out.pricePerModel, 55)
    assert.equal(out.total, 110)
    assert.equal(out.credits, 605)
    assert.equal(b.calls.some((c) => c.method === "tripo.generate"), false)
    assert.equal(b.calls.find((c) => c.method === "tripo.prepare").params.job.tPose, true)
  })

  test("refuses when credits are short, even with the OK", async () => {
    const b = fakeBridge({ "tripo.prepare": { ...prep, account: { credits: 50 } } })
    await assert.rejects(generateModels(b, { prompt: "a robot", approvedCredits: 55 }), /needs 55 Tripo credits and the account has 50/)
    assert.equal(b.calls.some((c) => c.method === "tripo.generate"), false)
  })

  test("with the OK, generates, waits for the model and returns it", async () => {
    let polls = 0
    const b = fakeBridge({
      "tripo.prepare": prep,
      "tripo.generate": ({ maxPrice }) => ({ job: { projectId: OWN, price: maxPrice, status: "queued" }, pageUrl: `https://studio.tripo3d.ai/workspace/generate/${OWN}`, warnings: [] }),
      "tripo.job": () =>
        ++polls < 3
          ? { projectId: OWN, job: { status: "running", progress: 40 * polls, done: false, failed: false } }
          : { projectId: OWN, job: { status: "success", progress: 100, done: true, failed: false }, model: { id: OWN, title: "robot" } }
    })
    const out = await generateModels(b, { prompt: "a robot", approvedCredits: 55 })
    assert.equal(out.generated, 1)
    assert.equal(out.jobs[0].status, "success")
    assert.equal(out.jobs[0].model.title, "robot")
    assert.equal(b.calls.find((c) => c.method === "tripo.generate").params.maxPrice, 55)
    assert.equal(polls, 3)
  })

  test("a failed job stops the batch", async () => {
    const b = fakeBridge({
      "tripo.prepare": prep,
      "tripo.generate": () => ({ job: { projectId: OWN, price: 55 }, pageUrl: "x" }),
      "tripo.job": () => ({ job: { status: "failed", done: false, failed: true, reason: "content policy" } })
    })
    const out = await generateModels(b, { prompt: "a robot", count: 2, approvedCredits: 110 })
    assert.equal(out.generated, 1)
    assert.match(out.jobs[0].note, /failed: content policy/)
    assert.equal(b.calls.filter((c) => c.method === "tripo.generate").length, 1)
  })

  test("a captcha hands the tab to the user", async () => {
    const b = fakeBridge({ "tripo.prepare": prep, "tripo.generate": { needsUser: "captcha", tabId: 3, message: "clear it" } })
    const out = await generateModels(b, { prompt: "a robot", approvedCredits: 55 })
    assert.equal(out.needsUser, "captcha")
    assert.equal(out.generated, 0)
  })

  test("the request is checked first", async () => {
    await assert.rejects(generateJob({}), /prompt/)
    await assert.rejects(generateModels(fakeBridge(), { prompt: "x", count: 9 }), /count is 1 to 4/)
    const png = touch(join(home, "ref.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const job = await generateJob({ image: png })
    assert.equal(job.mode, "image")
    assert.equal(job.image.mimeType, "image/png")
    assert.equal(job.image.name, "image.png")
    await assert.rejects(generateJob({ image: touch(join(home, "ref.gif")) }), /JPG, PNG or WebP/)
  })
})
