// Tests for what Browse Hack reads off Tripo (lib/tripo/model.ts): npm test (Node strips the types).

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  DEFAULT_EXPORT_RULES,
  downloadVerdict,
  extensionFor,
  imageExtensionOf,
  imageExtensionOfBytes,
  fileBase,
  glbFileName,
  isMeshopt,
  licenseFor,
  modelChoice,
  modelIdOf,
  normalizeAccount,
  normalizeGalleryItem,
  normalizeJob,
  normalizeProject,
  pageOf,
  previewFileName,
  priceOf,
  projectIdFromUrl,
  readExportRules,
  readGenerateJob,
  sourceFieldsFor,
  versionLabel
} from "./tripo/model.ts"

const ID = "9ad419a5-1c12-4f1b-9292-f857a76269e9"

// The shape of project/detail/v3 and assets/v2 (12 Nov 2026), URLs cut.
const ownProject = (over = {}) => ({
  owner_name: "vishwajeety14122",
  owner_user_id: 2251799816974926,
  id: ID,
  project_name: "3d character model",
  type: "generate",
  visibility: "public",
  biz_info: { description: "Full body 3D character of a confident 28-year-old man" },
  model_url: "https://tripo-data.rg1.data.tripo3d.com/x/tripo_pbr_model_39fe_meshopt.glb?Signature=s",
  is_owner: true,
  operator: {
    operator_id: "39fe58c5-3861-4879-b041-2094728004d6",
    model_version: "v3.1-20260211",
    status: "success",
    type: "text_to_model",
    created_at: 1794418446,
    is_textured: true,
    is_pbr: true,
    is_rigged: false,
    text_to_model: {
      prompt: "Full body 3D character of a confident 28-year-old man, standing in a T-pose",
      negative_prompt: null,
      quad: false,
      smart_poly: false,
      face_limit: 2000000,
      texture: true,
      pbr: true,
      texture_quality: "detailed",
      geometry_quality: "detailed",
      visibility: "public",
      t_pose: true,
      delight: true,
      model_version: "v3.1-20260211"
    }
  },
  ...over
})

const free = normalizeAccount(
  { userId: "2251799816974926", nickName: "vishwajeety14122", email: "someone@example.com" },
  { member: { type: "basic" }, wallet: { total_credit: 605, expiring_credit: 35, expiring_date: "2026-12-01" } },
  { export_limit: { id: "free_export_limit", total_count: 15, used_count: 0, is_valid: true, expire_at: "2026-12-01T00:00:00Z" } }
)
const pro = normalizeAccount({ userId: "7", nickName: "p" }, { member: { type: "professional" }, wallet: { total_credit: 3000 } })

describe("links", () => {
  test("a model's id from a gallery link, a workspace link or the id", () => {
    assert.equal(modelIdOf(`https://studio.tripo3d.ai/3d-model/three-anime-style-characters-with-fantasy-outfits-6bd25611-3b93-4159-95a6-5c5acb896e9f`), "6bd25611-3b93-4159-95a6-5c5acb896e9f")
    assert.equal(modelIdOf(`https://studio.tripo3d.ai/workspace/generate/${ID}`), ID)
    assert.equal(modelIdOf(`https://studio.tripo3d.ai/workspace/generate/full-body-3d-character-of-a-friendly-26-year-old-woman-a-tech-news-sh-0dde2824-86d4-41f9-a5b3-be75c2e28a2d`), "0dde2824-86d4-41f9-a5b3-be75c2e28a2d")
    assert.equal(modelIdOf(ID.toUpperCase()), ID)
    assert.equal(modelIdOf(`https://example.com/3d-model/x-${ID}`), undefined)
    assert.equal(modelIdOf("not a model"), undefined)
    assert.equal(modelIdOf(42), undefined)
  })

  test("what a page is", () => {
    assert.deepEqual(pageOf(`https://studio.tripo3d.ai/3d-model/robot-${ID}`), { kind: "model", id: ID })
    assert.deepEqual(pageOf(`https://studio.tripo3d.ai/workspace/generate/${ID}`), { kind: "workspace", id: ID })
    assert.deepEqual(pageOf("https://studio.tripo3d.ai/workspace/generate"), { kind: "generate" })
    assert.deepEqual(pageOf("https://studio.tripo3d.ai/?category=featured"), { kind: "gallery" })
    assert.deepEqual(pageOf("https://studio.tripo3d.ai/3d-model-gallery/anime-characters"), { kind: "gallery" })
    assert.deepEqual(pageOf("https://studio.tripo3d.ai/assets"), { kind: "other" })
    assert.equal(projectIdFromUrl(`https://studio.tripo3d.ai/workspace/generate/${ID}`), ID)
    assert.equal(projectIdFromUrl("https://studio.tripo3d.ai/workspace/generate"), undefined)
  })
})

describe("versions and models", () => {
  test("Tripo's version ids read as the picker names them", () => {
    assert.equal(versionLabel("v3.1-20260211"), "H3.1")
    assert.equal(versionLabel("v2.5-20250123"), "H2.5")
    assert.equal(versionLabel("Nexus-v2.0-20260801"), "P2.0")
    assert.equal(versionLabel(""), undefined)
  })

  test("a model asked for in any spelling", () => {
    assert.equal(modelChoice("H3.1"), "H3.1")
    assert.equal(modelChoice("h2.5"), "H2.5")
    assert.equal(modelChoice("3"), "H3.0")
    assert.equal(modelChoice("v3.1"), "H3.1")
    assert.equal(modelChoice(undefined), undefined)
    assert.throws(() => modelChoice("best"), /H3\.1/)
  })
})

describe("the account", () => {
  test("plan, credits and the Free plan's exports, no email", () => {
    assert.equal(free.signedIn, true)
    assert.equal(free.plan, "Free")
    assert.equal(free.paid, false)
    assert.equal(free.credits, 605)
    assert.equal(free.expiringCredits, 35)
    assert.deepEqual(free.exports, { total: 15, used: 0, left: 15, until: "2026-12-01T00:00:00Z" })
    assert.ok(!JSON.stringify(free).includes("example.com"))
    assert.equal(pro.plan, "Professional")
    assert.equal(pro.paid, true)
  })

  test("signed out", () => {
    const out = normalizeAccount(undefined, undefined)
    assert.equal(out.signedIn, false)
    assert.equal(out.plan, "Free")
  })

  test("Tripo's export rules from its config, with defaults", () => {
    const rules = readExportRules({
      credits: { Export: 5 },
      exportRules: { subscriptionRequiredModelVersions: ["v3.1-20260211"] },
      permissions: { ExportRestrictedModel: { memberPlans: { basic: false, starter: true } } }
    })
    assert.deepEqual(rules, { membersOnlyVersions: ["v3.1-20260211"], restrictedPlans: { basic: false, starter: true }, galleryExportPrice: 5 })
    assert.deepEqual(readExportRules(undefined), DEFAULT_EXPORT_RULES)
  })
})

// The same operator made with another model: the version changes on the operator and its steps.
const atVersion = (op, version) =>
  Object.fromEntries(Object.entries(op).map(([k, v]) => [k, k === "model_version" ? version : v && typeof v === "object" && "model_version" in v ? { ...v, model_version: version } : v]))

describe("a model's record", () => {
  test("a project from the API", () => {
    const m = normalizeProject(ownProject())
    assert.equal(m.id, ID)
    assert.equal(m.owner, true)
    assert.equal(m.model, "H3.1")
    assert.equal(m.modelVersion, "v3.1-20260211")
    assert.equal(m.pageUrl, `https://studio.tripo3d.ai/workspace/generate/${ID}`)
    assert.match(m.prompt, /T-pose/)
    assert.equal(m.generation.tPose, true)
    assert.equal(m.generation.removeLighting, true)
    assert.equal(m.generation.faceLimit, 2000000)
    assert.equal(m.hasViewerModel, true)
    assert.equal(m.createdAt, new Date(1794418446 * 1000).toISOString())
    assert.ok(!JSON.stringify(m).includes("Signature"), "no signed URL in the record")
  })

  test("someone else's model links to the gallery page", () => {
    const m = normalizeProject(ownProject({ is_owner: false, owner_name: "painstf" }))
    assert.equal(m.pageUrl, `https://studio.tripo3d.ai/3d-model/${ID}`)
    assert.equal(m.ownerName, "painstf")
  })

  test("a texture pass keeps the mesh's model, and every version is kept", () => {
    const m = normalizeProject({
      id: ID,
      is_owner: false,
      type: "generate",
      operator: {
        type: "texture_generation",
        model_version: "v3.5-20260815",
        status: "success",
        texture_generation: { model_version: "v3.5-20260815" },
        image_to_model: { model_version: "Nexus-v2.0-20260801", quad: true }
      }
    })
    assert.equal(m.modelVersion, "Nexus-v2.0-20260801")
    assert.equal(m.model, "P2.0")
    assert.equal(m.generation.type, "image_to_model")
    assert.equal(m.lastStep, "texture_generation")
    assert.deepEqual(m.modelVersions.sort(), ["Nexus-v2.0-20260801", "v3.5-20260815"])
    const v = downloadVerdict({ ...m, modelVersion: "v3.5-20260815" }, normalizeAccount({ userId: "1" }, { member: { type: "basic" }, wallet: { total_credit: 605 } }), DEFAULT_EXPORT_RULES, "export")
    assert.equal(v.ok, false, "Tripo's Export: a members-only mesh under a newer texture is still members-only")
    assert.equal(v.needs, "plan")
    assert.match(v.why, /exports P2\.0 models only to paying members/)
  })

  test("nothing without an id", () => {
    assert.equal(normalizeProject({ id: "x" }), undefined)
    assert.equal(normalizeProject(null), undefined)
  })

  test("a gallery search item", () => {
    const item = normalizeGalleryItem({
      itemId: "FA920624-fa25-48cc-b0cd-303d542c48c0",
      title: "anime doll 3d model",
      bizInfo: { caption: "sitting anime doll" },
      author: { nickName: "Jeje02_B7", userId: "3236362" },
      counts: { likeCount: "544" },
      labels: ["mt:pbr", "mt:rigged"],
      featured: true,
      publishTime: "2026-07-20T16:21:42.607Z",
      cover: [{ url: "https://x/y.webp?Signature=s" }]
    })
    assert.equal(item.id, "fa920624-fa25-48cc-b0cd-303d542c48c0")
    assert.equal(item.likes, 544)
    assert.equal(item.rigged, true)
    assert.equal(item.pageUrl, "https://studio.tripo3d.ai/3d-model/fa920624-fa25-48cc-b0cd-303d542c48c0")
    assert.ok(!JSON.stringify(item).includes("Signature"))
  })
})

describe("how a model is downloaded", () => {
  const own = normalizeProject(ownProject())
  const gallery = (version = "v3.1-20260211") =>
    normalizeProject(ownProject({ is_owner: false, owner_name: "painstf", operator: atVersion(ownProject().operator, version) }))
  const membersOnly = /Tripo exports H3\.1 models only to paying members, and this account is on the Free plan/

  test("own H3.1 on the Free plan: the viewer's copy, saying why not Tripo's Export", () => {
    const v = downloadVerdict(own, free)
    assert.equal(v.ok, true)
    assert.equal(v.route, "viewer")
    assert.equal(v.price, 0)
    assert.equal(v.export, undefined)
    assert.match(v.exportNo, membersOnly)
  })

  test("someone else's H3.1 on the Free plan: the viewer's copy too", () => {
    const v = downloadVerdict(gallery(), free)
    assert.equal(v.ok, true)
    assert.equal(v.route, "viewer")
    assert.equal(v.price, 0)
    assert.match(v.exportNo, membersOnly)
  })

  test("Tripo's demo models: the viewer's copy", () => {
    const demo = normalizeProject(ownProject({ type: "preset", operator: atVersion(ownProject().operator, "v3.0-20250812") }))
    assert.equal(downloadVerdict(demo, free).route, "viewer")
  })

  test("own model the plan exports: Tripo's Export, the full-quality file, at no cost", () => {
    assert.deepEqual(downloadVerdict(own, pro), { ok: true, route: "export", price: 0, usesExport: false, export: { price: 0, usesExport: false } })
    const h25 = normalizeProject(ownProject({ operator: atVersion(ownProject().operator, "v2.5-20250123") }))
    assert.equal(h25.model, "H2.5")
    assert.deepEqual(downloadVerdict(h25, free), { ok: true, route: "export", price: 0, usesExport: true, export: { price: 0, usesExport: true } })
    const usedUp = { ...free, exports: { total: 15, used: 15, left: 0 } }
    const v = downloadVerdict(h25, usedUp)
    assert.equal(v.route, "viewer", "no exports left: the viewer's copy")
    assert.match(v.exportNo, /used all 15/)
  })

  test("someone else's H2.5 on the Free plan: the free viewer's copy, with Tripo's Export for 5 credits as the other way", () => {
    const g = gallery("v2.5-20250123")
    const v = downloadVerdict(g, free)
    assert.equal(v.route, "viewer")
    assert.deepEqual(v.export, { price: 5, usesExport: true })
    assert.deepEqual(downloadVerdict(g, free, DEFAULT_EXPORT_RULES, "export"), { ok: true, route: "export", price: 5, usesExport: true, export: { price: 5, usesExport: true } })
    assert.equal(downloadVerdict(g, { ...free, credits: 3 }, DEFAULT_EXPORT_RULES, "export").needs, "credits")
    const usedUp = { ...free, exports: { total: 15, used: 15, left: 0, until: "2026-12-01T00:00:00Z" } }
    const v2 = downloadVerdict(g, usedUp, DEFAULT_EXPORT_RULES, "export")
    assert.equal(v2.needs, "exports")
    assert.match(v2.why, /all 15 of its Tripo exports.*2026-12-01/)
  })

  test("asking for Tripo's Export where it isn't offered says why", () => {
    const v = downloadVerdict(gallery(), free, DEFAULT_EXPORT_RULES, "export")
    assert.equal(v.ok, false)
    assert.equal(v.needs, "plan")
    assert.match(v.why, membersOnly)
  })

  test("no viewer file: Tripo's Export when offered, else says why", () => {
    const g = { ...gallery("v2.5-20250123"), hasViewerModel: false }
    assert.equal(downloadVerdict(g, free).route, "export")
    assert.equal(downloadVerdict(g, free, DEFAULT_EXPORT_RULES, "viewer").needs, "noFile")
    const locked = downloadVerdict({ ...gallery(), hasViewerModel: false }, free)
    assert.equal(locked.ok, false)
    assert.equal(locked.needs, "noFile")
  })

  test("signed out, or not finished", () => {
    assert.equal(downloadVerdict(own, normalizeAccount(undefined, undefined)).needs, "signin")
    assert.equal(downloadVerdict({ ...own, status: "running" }, pro).needs, "notReady")
  })
})

describe("the source.json", () => {
  const own = normalizeProject(ownProject())

  test("an own model saved from the viewer keeps the plan's terms and why not Tripo's Export", () => {
    const license = licenseFor(own, free, "viewer", "Tripo exports H3.1 models only to paying members.")
    assert.match(license, /^Own model, made on Tripo's Free plan/)
    assert.match(license, /non-commercial/)
    assert.match(license, /Saved from Tripo's viewer \(the GLB its page shows\), not Tripo's Export; Tripo exports H3\.1 models only to paying members\.$/)
    const fields = sourceFieldsFor(own, { route: "viewer", license, meshopt: true, price: 55 })
    assert.equal(fields.tool, "tripo")
    assert.equal(fields.ref, ID)
    assert.equal(fields.model, "Tripo H3.1 (v3.1-20260211)")
    assert.equal(fields.author, "vishwajeety14122")
    assert.equal(fields.price, 55)
    assert.equal(fields.license, license)
    assert.equal(fields.settings.via, "viewer")
    assert.equal(fields.settings.tPose, true)
    assert.equal(fields.settings.meshopt, true)
    assert.equal(fields.settings.operatorId, "39fe58c5-3861-4879-b041-2094728004d6")
    assert.ok(!("negativePrompt" in fields.settings))
    assert.ok(!JSON.stringify(fields).includes("Signature"))
  })

  test("a gallery model names its author and Tripo's terms", () => {
    const g = normalizeProject(ownProject({ is_owner: false, owner_name: "painstf" }))
    const license = licenseFor(g, free, "export")
    assert.match(license, /gallery model by painstf/)
    assert.match(license, /tripo3d\.ai\/terms/)
    assert.match(license, /Free plan, which Tripo lists for non-commercial use/)
    const viewer = licenseFor(g, free, "viewer")
    assert.match(viewer, /gallery model by painstf, saved from Tripo's viewer/)
    assert.match(viewer, /tripo3d\.ai\/terms/)
    assert.match(licenseFor({ ...own, kind: "preset" }, free, "viewer"), /^Tripo demo model/)
  })

  test("the preview picture points at its model", () => {
    const fields = sourceFieldsFor(own, { route: "viewer", license: "x", preview: true })
    assert.equal(fields.ref, `${ID}#preview`)
    assert.equal(fields.parentRef, ID)
    assert.match(fields.title, /\(preview\)$/)
  })

  test("file names", () => {
    assert.equal(fileBase(own), "3d-character-model-9ad419a5")
    assert.equal(fileBase({ id: ID, title: "  Ñandú — 3D!! " }), "nandu-3d-9ad419a5")
    assert.equal(fileBase({ id: ID, title: "!!!" }), "tripo-model-9ad419a5")
    assert.equal(glbFileName(own, true), "3d-character-model-9ad419a5-meshopt.glb")
    assert.equal(previewFileName(own), "3d-character-model-9ad419a5-preview.webp")
    assert.equal(isMeshopt("https://x/tripo_pbr_model_1_meshopt.glb?Policy=p"), true)
    assert.equal(isMeshopt("https://x/model.glb"), false)
    assert.equal(extensionFor("anime characters 3d model.ZIP"), ".zip")
    assert.equal(extensionFor("download", "model/gltf-binary"), ".glb")
    // Tripo's resizer serves its .webp covers as whatever format= says.
    assert.equal(imageExtensionOf("https://tripo-data-public.rg1.data.tripo3d.com/x/studio_mesh.webp?Policy=p&format=png&width=1024"), ".png")
    assert.equal(imageExtensionOf("https://x.tripo3d.com/a/cover.JPEG"), ".jpg")
    assert.equal(imageExtensionOf("https://x.tripo3d.com/a/studio_mesh.webp?Signature=s"), ".webp")
    assert.equal(imageExtensionOf("not a link"), ".webp")
    assert.equal(imageExtensionOfBytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), ".png")
    assert.equal(imageExtensionOfBytes([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP"].map((c) => c.charCodeAt(0)))), ".webp")
    assert.equal(imageExtensionOfBytes([0xff, 0xd8, 0xff, 0xe0]), ".jpg")
    assert.equal(imageExtensionOfBytes([1, 2, 3]), undefined)
  })
})

describe("prices and jobs", () => {
  test("the credits on a button", () => {
    assert.equal(priceOf("Generate 55"), 55)
    assert.equal(priceOf("Generate\n⚡\n40"), 40)
    assert.equal(priceOf("Export 5"), 5)
    assert.equal(priceOf("Export"), undefined)
    assert.equal(priceOf("Generate 1,200"), 1200)
  })

  test("a job's progress", () => {
    assert.deepEqual(normalizeJob({ operator_id: "a", status: "running", progress: 42, left_time: 120 }), {
      operatorId: "a",
      status: "running",
      progress: 42,
      secondsLeft: 120,
      done: false,
      failed: false,
      reason: undefined
    })
    const done = normalizeJob({ id: "b", status: "success", progress: 100, left_time: -1 })
    assert.equal(done.done, true)
    assert.equal(done.secondsLeft, undefined)
    assert.equal(normalizeJob({ operator_id: "c", status: "failed", reason: { message: "banned prompt" } }).reason, "banned prompt")
    assert.equal(normalizeJob({}), undefined)
  })

  test("a generate request is checked before anything is filled in", () => {
    assert.deepEqual(readGenerateJob({ prompt: "a robot", model: "3.1", tPose: true, textureQuality: "4k" }), {
      mode: "text",
      prompt: "a robot",
      image: undefined,
      model: "H3.1",
      tPose: true,
      texture: undefined,
      textureQuality: "4K",
      pbr: undefined,
      removeLighting: undefined,
      topology: undefined,
      privacy: undefined
    })
    assert.equal(readGenerateJob({ image: { base64: "AA==", mimeType: "image/png" } }).mode, "image")
    assert.throws(() => readGenerateJob({}), /prompt/)
    assert.throws(() => readGenerateJob({ prompt: "x".repeat(1001) }), /1000/)
    assert.throws(() => readGenerateJob({ prompt: "x", textureQuality: "16K" }), /textureQuality/)
    assert.throws(() => readGenerateJob({ prompt: "x", topology: "hex" }), /topology/)
  })
})
