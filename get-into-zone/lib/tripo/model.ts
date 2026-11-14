// What Browse Hack knows about Tripo (studio.tripo3d.ai): its links, model
// versions, plans, a model's record, what this account may download and how,
// and what the <file>.source.json beside a download says. No browser APIs
// here, so Node's tests load it as it is (lib/tripo.test.mjs).
//
// Learned on the live site (12 Nov 2026):
// - A model is a "project": its id is in the page link, /3d-model/<slug>-<id>
//   for the gallery and /workspace/generate/<slug->?<id> in the workspace.
//   api.tripo3d.ai/v2/studio/project/detail/v3/<id> has it (owner, version,
//   generation settings, the viewer's GLB), assets/v2?asset_type=mine lists
//   the account's own, and progress {ids: [operator ids]} a job's state.
// - Exporting H3.x (and Nexus) models is for paying members
//   (exportRules.subscriptionRequiredModelVersions, ExportRestrictedModel);
//   the Free plan exports H2.5 only, 15 a month. Exporting someone else's
//   gallery model costs credits (credits.Export, 5).
// - Every model page loads the model's GLB for its viewer (detail's
//   model_url, meshopt-compressed). Browse Hack saves that copy for any model,
//   which the Tripo team approved for Browse Hack (as the user reported, Nov 2026); Tripo's Export, where it's offered to the
//   account, gives the full-quality file (free for the account's own models
//   its plan exports, credits for a gallery model's).

export const TRIPO = "https://studio.tripo3d.ai"
export const TRIPO_API = "https://api.tripo3d.ai"
export const TRIPO_PRICING = "https://www.tripo3d.ai/pricing"
export const TRIPO_TERMS = "https://www.tripo3d.ai/terms"

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const UUID_ONLY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_RE = /^\/(3d-model|workspace\/generate)\/(?:[^/]*?-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i

const isTripoHost = (host: string) => host === "tripo3d.ai" || host.endsWith(".tripo3d.ai")

/** A model's id from its id or a studio.tripo3d.ai link; undefined for anything else. */
export function modelIdOf(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined
  const text = input.trim()
  if (UUID_ONLY_RE.test(text)) return text.toLowerCase()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (!isTripoHost(url.hostname)) return undefined
  return PAGE_RE.exec(url.pathname)?.[2].toLowerCase()
}

export type TripoPageKind = "model" | "workspace" | "generate" | "gallery" | "other"

/** What a studio.tripo3d.ai page is: a gallery model, one of the workspace's, the create form, the gallery. */
export function pageOf(href: string): { kind: TripoPageKind; id?: string } {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return { kind: "other" }
  }
  if (!isTripoHost(url.hostname)) return { kind: "other" }
  const match = PAGE_RE.exec(url.pathname)
  if (match) return { kind: match[1] === "3d-model" ? "model" : "workspace", id: match[2].toLowerCase() }
  if (/^\/workspace\/generate\/?$/.test(url.pathname)) return { kind: "generate" }
  if (url.pathname === "/" || url.pathname.startsWith("/3d-model-gallery")) return { kind: "gallery" }
  return { kind: "other" }
}

/** "v3.1-20260211" → "H3.1", "Nexus-v2.0-20260801" → "P2.0" (as Tripo's model pages name it); the version itself when it's neither. */
export function versionLabel(version?: unknown) {
  const v = typeof version === "string" ? version.trim() : ""
  if (!v) return undefined
  const h = /^v(\d+(?:\.\d+)?)(?:-|$)/i.exec(v)
  if (h) return `H${h[1]}`
  const nexus = /^nexus-v(\d+(?:\.\d+)?)/i.exec(v)
  if (nexus) return `P${nexus[1]}`
  return v
}

/** A model asked for ("H3.1", "h3.1", "3.1", "v3.1") as the picker names it ("H3.1"). */
export function modelChoice(input: unknown) {
  if (input === undefined || input === null || input === "") return undefined
  const m = /^\s*(?:h|v)?\s*(\d+(?:\.\d+)?)\s*$/i.exec(String(input))
  if (!m) throw new Error(`model is a Tripo model version such as "H3.1", "H3.0" or "H2.5"; got "${input}".`)
  const n = m[1].includes(".") ? m[1] : `${m[1]}.0`
  return `H${n}`
}

// --- Plans ---------------------------------------------------------------------

const PLAN_NAMES: Record<string, string> = {
  basic: "Free",
  starter: "Starter",
  professional: "Professional",
  advanced: "Advanced",
  premium: "Premium",
  team: "Team"
}

export const planLabel = (type?: unknown) => {
  const t = typeof type === "string" && type ? type.toLowerCase() : "basic"
  return PLAN_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1)
}

export const isPaidPlan = (type?: unknown) => typeof type === "string" && type !== "" && type.toLowerCase() !== "basic"

export interface TripoAccount {
  signedIn: boolean
  userId?: string
  name?: string
  planType: string
  plan: string
  paid: boolean
  credits?: number
  expiringCredits?: number
  expiringOn?: string
  /** The Free plan's monthly exports (Tripo's export-limit). */
  exports?: { total: number; used: number; left: number; until?: string }
}

const num = (value: unknown) => {
  const n = typeof value === "string" && value.trim() ? Number(value) : value
  return typeof n === "number" && Number.isFinite(n) ? n : undefined
}
const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

/**
 * The account from what the page knows: the signed-in user (feature-user's
 * info), user/profile/payment (plan and wallet) and marketing/export-limit.
 * No email or token is kept.
 */
export function normalizeAccount(info: any, payment: any, exportLimit?: any): TripoAccount {
  const userId = str(info?.userId) ?? (typeof info?.userId === "number" ? String(info.userId) : undefined)
  const planType = str(payment?.member?.type) ?? str(payment?.subscription?.type) ?? "basic"
  const wallet = payment?.wallet
  const limit = exportLimit?.export_limit ?? exportLimit
  const total = num(limit?.total_count)
  const used = num(limit?.used_count)
  return {
    signedIn: Boolean(userId),
    userId,
    name: str(info?.nickName),
    planType,
    plan: planLabel(planType),
    paid: isPaidPlan(planType),
    credits: num(wallet?.total_credit),
    expiringCredits: num(wallet?.expiring_credit) || undefined,
    expiringOn: str(wallet?.expiring_date),
    exports:
      total !== undefined && limit?.is_valid !== false
        ? { total, used: used ?? 0, left: Math.max(total - (used ?? 0), 0), until: str(limit?.expire_at) }
        : undefined
  }
}

// --- Tripo's export rules (config-store's algorithmConfig) ----------------------

export interface ExportRules {
  /** Model versions only paying members export. */
  membersOnlyVersions: string[]
  /** Plans that may export those (ExportRestrictedModel). */
  restrictedPlans: Record<string, boolean>
  /** What exporting someone else's gallery model costs. */
  galleryExportPrice: number
}

export const DEFAULT_EXPORT_RULES: ExportRules = {
  membersOnlyVersions: ["v3.0-20250812", "v3.1-20260211", "Nexus-v1.0-20260214", "Nexus-v2.0-20260801"],
  restrictedPlans: { basic: false, starter: true, professional: true, advanced: true, premium: true, team: true },
  galleryExportPrice: 5
}

export function readExportRules(algorithmConfig: any): ExportRules {
  const versions = algorithmConfig?.exportRules?.subscriptionRequiredModelVersions
  const plans = algorithmConfig?.permissions?.ExportRestrictedModel?.memberPlans
  const price = num(algorithmConfig?.credits?.Export)
  return {
    membersOnlyVersions: Array.isArray(versions)
      ? versions.filter((v: unknown): v is string => typeof v === "string")
      : DEFAULT_EXPORT_RULES.membersOnlyVersions,
    restrictedPlans:
      plans && typeof plans === "object"
        ? Object.fromEntries(Object.entries(plans).map(([k, v]) => [k, v === true]))
        : DEFAULT_EXPORT_RULES.restrictedPlans,
    galleryExportPrice: price ?? DEFAULT_EXPORT_RULES.galleryExportPrice
  }
}

// --- A model ---------------------------------------------------------------------

export interface TripoGeneration {
  type?: string
  modelVersion?: string
  tPose?: boolean
  texture?: boolean
  pbr?: boolean
  textureQuality?: string
  geometryQuality?: string
  removeLighting?: boolean
  quad?: boolean
  smartLowPoly?: boolean
  faceLimit?: number
  parts?: boolean
  visibility?: string
}

export interface TripoModel {
  id: string
  title: string
  pageUrl: string
  /** The signed-in account made it (or Tripo gave it to the account, kind "preset"). */
  owner: boolean
  ownerName?: string
  ownerId?: string
  /** "generate" for a model made with Tripo, "preset" for Tripo's demo models, … */
  kind?: string
  visibility?: string
  /** The model that made the mesh ("v3.1-20260211"); a later texture or rig step keeps it. */
  modelVersion?: string
  /** "H3.1" */
  model?: string
  /** Every model version the model went through: the mesh's, a texture pass's, … */
  modelVersions: string[]
  /** The model's latest step when it isn't the mesh ("texture_generation"). */
  lastStep?: string
  prompt?: string
  negativePrompt?: string
  generation?: TripoGeneration
  operatorId?: string
  status?: string
  createdAt?: string
  textured?: boolean
  pbr?: boolean
  rigged?: boolean
  /** The viewer has a GLB for it (detail's model_url). */
  hasViewerModel: boolean
}

const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined)

/** The steps that make a mesh. A model's later steps (texture, rig, …) sit beside it in the same operator. */
const MESH_STEPS = ["text_to_model", "image_to_model", "multiview_to_model", "batch_image_to_model"]

function meshStepOf(op: any) {
  const type = str(op?.type)
  if (type && MESH_STEPS.includes(type)) return type
  return MESH_STEPS.find((step) => op?.[step] && typeof op[step] === "object") ?? type
}

/** Every model version in an operator: its own, the generation's, and each step's. */
function versionsOf(op: any) {
  const out = new Set<string>()
  const add = (value: unknown) => {
    const v = str(value)
    if (v) out.add(v)
  }
  add(op?.model_version)
  add(op?.generation_model_version)
  for (const value of Object.values(op ?? {})) if (value && typeof value === "object" && !Array.isArray(value)) add((value as any).model_version)
  return [...out]
}

function generationOf(op: any): TripoGeneration | undefined {
  const type = meshStepOf(op)
  const g = type && op?.[type] && typeof op[type] === "object" ? op[type] : undefined
  if (!g && !type) return undefined
  return {
    type,
    modelVersion: str(g?.model_version) ?? str(op?.model_version),
    tPose: bool(g?.t_pose),
    texture: bool(g?.texture),
    pbr: bool(g?.pbr),
    textureQuality: str(g?.texture_quality),
    geometryQuality: str(g?.geometry_quality),
    removeLighting: bool(g?.delight),
    quad: bool(g?.quad),
    smartLowPoly: bool(g?.smart_poly),
    faceLimit: num(g?.face_limit),
    parts: bool(g?.generate_parts),
    visibility: str(g?.visibility)
  }
}

const isoFromSeconds = (value: unknown) => {
  const n = num(value)
  if (!n) return undefined
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

/** A project from project/detail/v3 or assets/v2 (they share a shape). */
export function normalizeProject(p: any): TripoModel | undefined {
  const id = typeof p?.id === "string" && UUID_ONLY_RE.test(p.id) ? p.id.toLowerCase() : undefined
  if (!id) return undefined
  const op = p.operator ?? {}
  const generation = generationOf(op)
  const owner = p.is_owner === true
  const modelVersion = generation?.modelVersion ?? str(op.model_version)
  const lastStep = str(op.type)
  return {
    id,
    title: str(p.project_name) ?? str(p.i18n?.model_name) ?? "Tripo model",
    pageUrl: owner ? `${TRIPO}/workspace/generate/${id}` : `${TRIPO}/3d-model/${id}`,
    owner,
    ownerName: str(p.owner_name),
    ownerId: p.owner_user_id !== undefined && p.owner_user_id !== null ? String(p.owner_user_id) : undefined,
    kind: str(p.type),
    visibility: str(p.visibility),
    modelVersion,
    model: versionLabel(modelVersion),
    modelVersions: versionsOf(op),
    lastStep: lastStep && lastStep !== generation?.type ? lastStep : undefined,
    prompt: str(op?.[generation?.type ?? ""]?.prompt) ?? str(p.biz_info?.description),
    negativePrompt: str(op?.[generation?.type ?? ""]?.negative_prompt),
    generation,
    operatorId: str(op.operator_id),
    status: str(op.status),
    createdAt: isoFromSeconds(op.created_at),
    textured: bool(op.is_textured),
    pbr: bool(op.is_pbr),
    rigged: bool(op.is_rigged),
    hasViewerModel: Boolean(str(p.model_url) ?? str(op.model_url))
  }
}

export interface GalleryItem {
  id: string
  title: string
  caption?: string
  author?: string
  authorId?: string
  category?: string
  style?: string
  featured?: boolean
  likes?: number
  publishedAt?: string
  pbr?: boolean
  rigged?: boolean
  pageUrl: string
}

/** One of the gallery search's items (tripo.community.api.search SearchItems). */
export function normalizeGalleryItem(item: any): GalleryItem | undefined {
  const id = typeof item?.itemId === "string" && UUID_ONLY_RE.test(item.itemId) ? item.itemId.toLowerCase() : undefined
  if (!id) return undefined
  const labels: string[] = Array.isArray(item.labels) ? item.labels.filter((l: unknown) => typeof l === "string") : []
  return {
    id,
    title: str(item.title) ?? "Tripo model",
    caption: str(item.bizInfo?.caption) ?? str(item.description),
    author: str(item.author?.nickName),
    authorId: str(item.author?.userId),
    category: str(item.category),
    style: str(item.style),
    featured: bool(item.featured),
    likes: num(item.counts?.likeCount),
    publishedAt: str(item.publishTime) ?? str(item.createTime),
    pbr: labels.includes("mt:pbr") || undefined,
    rigged: labels.includes("mt:rigged") || undefined,
    pageUrl: `${TRIPO}/3d-model/${id}`
  }
}

// --- How a model is downloaded ---------------------------------------------------

export type DownloadRoute = "export" | "viewer"
/** "auto": Tripo's Export when it costs nothing, else the viewer's copy, else a paid Export. */
export type DownloadVia = "auto" | DownloadRoute

export interface ExportOffer {
  /** Credits Tripo charges (an estimate; the Export button's price is checked before clicking). */
  price: number
  /** Uses one of the Free plan's monthly exports. */
  usesExport: boolean
}

export interface Verdict {
  ok: boolean
  route?: DownloadRoute
  /** Credits this route costs. */
  price: number
  usesExport?: boolean
  /** Tripo's own Export, when it offers it to this account: the full-quality file, the other way to get it. */
  export?: ExportOffer
  /** Why Tripo's Export isn't offered to this account, when it isn't. */
  exportNo?: string
  needs?: "signin" | "notReady" | "noFile" | "plan" | "exports" | "credits"
  why?: string
}

/** Whether Tripo's own Export is offered to this account for this model, and what it costs. */
export function exportOfferFor(
  model: Pick<TripoModel, "owner" | "modelVersion" | "model"> & { modelVersions?: string[] },
  account: TripoAccount,
  rules: ExportRules = DEFAULT_EXPORT_RULES
): { offer?: ExportOffer; no?: string; needs?: Verdict["needs"] } {
  // Any members-only model in its making counts: a texture pass over a members-only mesh is still that mesh.
  const lockedBy = [model.modelVersion, ...(model.modelVersions ?? [])].find((v) => v && rules.membersOnlyVersions.includes(v))
  if (lockedBy && rules.restrictedPlans[account.planType] !== true) {
    return { needs: "plan", no: `Tripo exports ${versionLabel(lockedBy) ?? lockedBy} models only to paying members, and this account is on the ${account.plan} plan.` }
  }
  if (!account.paid && account.exports && account.exports.left <= 0) {
    return {
      needs: "exports",
      no: `This account has used all ${account.exports.total} of its Tripo exports this month${account.exports.until ? ` (they renew ${account.exports.until.slice(0, 10)})` : ""}.`
    }
  }
  const price = model.owner ? 0 : rules.galleryExportPrice
  if (account.credits !== undefined && account.credits < price) {
    return { needs: "credits", no: `Tripo charges ${price} credits to export a gallery model and this account has ${account.credits}.` }
  }
  return { offer: { price, usesExport: !account.paid } }
}

/**
 * How Browse Hack downloads a model. "auto" takes Tripo's Export when it costs
 * nothing (the account's own models its plan exports: the full-quality file),
 * else the viewer's copy (the GLB Tripo's page shows), else Tripo's Export for
 * credits. "viewer" and "export" ask for one of the two.
 */
export function downloadVerdict(
  model: Pick<TripoModel, "owner" | "modelVersion" | "model" | "status" | "hasViewerModel"> & { modelVersions?: string[] },
  account: TripoAccount,
  rules: ExportRules = DEFAULT_EXPORT_RULES,
  via: DownloadVia = "auto"
): Verdict {
  if (!account.signedIn) return { ok: false, price: 0, needs: "signin", why: "Tripo isn't signed in in this Chrome profile. Sign in at https://studio.tripo3d.ai, then try again." }
  if (model.status && model.status !== "success") {
    return { ok: false, price: 0, needs: "notReady", why: `This model isn't finished yet (Tripo says "${model.status}").` }
  }
  const { offer, no, needs } = exportOfferFor(model, account, rules)
  const byExport = (o: ExportOffer): Verdict => ({ ok: true, route: "export", price: o.price, usesExport: o.usesExport, export: o })
  const byViewer: Verdict = { ok: true, route: "viewer", price: 0, export: offer, exportNo: no }
  const noViewer = "Tripo's page has no model file for this one."

  if (via === "export") return offer ? byExport(offer) : { ok: false, price: 0, needs, why: no }
  if (via === "viewer") return model.hasViewerModel ? byViewer : { ok: false, price: 0, needs: "noFile", why: noViewer, export: offer }
  if (offer?.price === 0) return byExport(offer)
  if (model.hasViewerModel) return byViewer
  if (offer) return byExport(offer)
  return { ok: false, price: 0, needs: "noFile", why: `${noViewer} ${no ?? ""}`.trim() }
}


// --- The download's record --------------------------------------------------------

/** The licence line kept in the source.json: what Tripo's plan says, and how the file was saved. */
export function licenseFor(
  model: Pick<TripoModel, "owner" | "ownerName" | "kind">,
  account: Pick<TripoAccount, "plan" | "paid">,
  route: DownloadRoute,
  exportNo?: string
) {
  const how =
    route === "viewer"
      ? `saved from Tripo's viewer (the GLB its page shows), not Tripo's Export${exportNo ? `; ${exportNo.replace(/\.$/, "")}` : ""}`
      : "exported with Tripo's Export"
  if (model.owner && model.kind === "preset") return `Tripo demo model in the account's workspace, ${how}. Tripo's terms apply (${TRIPO_TERMS}).`
  if (model.owner) {
    const terms = account.paid
      ? `Tripo's ${account.plan} plan; Tripo lists commercial use and private models for paid plans (${TRIPO_PRICING})`
      : `Tripo's Free plan; Tripo lists Free-plan models as public, for non-commercial use (${TRIPO_PRICING})`
    return `Own model, made on ${terms}. ${how[0].toUpperCase()}${how.slice(1)}.`
  }
  const plan = route === "viewer" ? "" : account.paid ? ` on Tripo's ${account.plan} plan` : ` on Tripo's Free plan, which Tripo lists for non-commercial use (${TRIPO_PRICING})`
  return `Tripo gallery model by ${model.ownerName ?? "another Tripo user"}, ${how}${plan}. The page shows no licence of its own; Tripo's terms apply (${TRIPO_TERMS}).`
}

export interface TripoSourceFields {
  tool: "tripo"
  ref: string
  pageUrl?: string
  title?: string
  author?: string
  prompt?: string
  model?: string
  price?: number
  license?: string
  parentRef?: string
  settings?: Record<string, unknown>
}

/** What the <file>.source.json beside a model (or its preview picture) says. */
export function sourceFieldsFor(
  model: TripoModel,
  opts: { route: DownloadRoute; license: string; pageUrl?: string; price?: number; preview?: boolean; meshopt?: boolean }
): TripoSourceFields {
  const g = model.generation ?? {}
  const settings: Record<string, unknown> = {
    via: opts.route === "viewer" ? "viewer" : "export",
    generation: g.type,
    modelVersion: model.modelVersion,
    modelVersions: model.modelVersions?.length > 1 ? model.modelVersions : undefined,
    lastStep: model.lastStep,
    tPose: g.tPose,
    texture: g.texture,
    pbr: g.pbr,
    textureQuality: g.textureQuality,
    geometryQuality: g.geometryQuality,
    removeLighting: g.removeLighting,
    quad: g.quad,
    faceLimit: g.faceLimit,
    parts: g.parts,
    visibility: model.visibility ?? g.visibility,
    operatorId: model.operatorId,
    meshopt: opts.meshopt,
    madeAt: model.createdAt
  }
  return {
    tool: "tripo",
    ref: opts.preview ? `${model.id}#preview` : model.id,
    pageUrl: opts.pageUrl ?? model.pageUrl,
    title: opts.preview ? `${model.title} (preview)` : model.title,
    author: model.ownerName,
    prompt: model.prompt,
    model: model.model ? `Tripo ${model.model}${model.modelVersion && model.modelVersion !== model.model ? ` (${model.modelVersion})` : ""}` : undefined,
    price: opts.price,
    license: opts.license,
    parentRef: opts.preview ? model.id : undefined,
    settings: Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined && v !== null && v !== ""))
  }
}

/** A file name's stem: the title as a slug and the id's first block ("friendly-host-3d-model-0dde2824"). */
export function fileBase(model: Pick<TripoModel, "id" | "title">) {
  const slug = model.title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")
  return `${slug || "tripo-model"}-${model.id.slice(0, 8)}`
}

/** The viewer's GLB is meshopt-compressed (…_meshopt.glb); the name says so for Blender users. */
export const isMeshopt = (url?: string) => /_meshopt\.glb(?:$|\?)/i.test(url ?? "")

export const glbFileName = (model: Pick<TripoModel, "id" | "title">, meshopt = false) =>
  `${fileBase(model)}${meshopt ? "-meshopt" : ""}.glb`

export const previewFileName = (model: Pick<TripoModel, "id" | "title">, ext = ".webp") => `${fileBase(model)}-preview${ext}`

/** The extension a downloaded file should keep: from its name, else its type. */
/** A picture link's file type: its format= parameter (Tripo's resizer turns .webp into PNG), else its path; ".webp" when neither says. */
export function imageExtensionOf(url: string) {
  try {
    const u = new URL(url)
    const named = (u.searchParams.get("format") ?? /\.(\w+)$/.exec(u.pathname)?.[1] ?? "").toLowerCase()
    if (/^(png|jpe?g|webp|gif|avif)$/.test(named)) return named === "jpeg" ? ".jpg" : `.${named}`
  } catch {}
  return ".webp"
}

/** A picture's type from its first bytes (Tripo's .webp links sometimes serve PNG); undefined when unknown. */
export function imageExtensionOfBytes(bytes: ArrayLike<number>) {
  const at = (i: number, ...want: number[]) => want.every((b, k) => bytes[i + k] === b)
  const ascii = (i: number, text: string) => at(i, ...[...text].map((c) => c.charCodeAt(0)))
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return ".png"
  if (at(0, 0xff, 0xd8, 0xff)) return ".jpg"
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return ".webp"
  if (ascii(0, "GIF8")) return ".gif"
  if (ascii(4, "ftypavif")) return ".avif"
  return undefined
}

export function extensionFor(filename: string, mime = "") {
  const fromName = /\.(glb|gltf|fbx|obj|stl|usdz|3mf|zip)$/i.exec(filename)?.[0]
  if (fromName) return fromName.toLowerCase()
  if (/zip/.test(mime)) return ".zip"
  if (/gltf-binary|glb/.test(mime)) return ".glb"
  return ".glb"
}

// --- Prices and jobs ------------------------------------------------------------------

/** The credits on a button ("Generate 55", "Export ⚡ 5"); undefined when it shows none. */
export function priceOf(label: unknown) {
  const m = /(\d[\d,]*)\s*$/.exec(String(label ?? "").replace(/\s+/g, " ").trim())
  return m ? Number(m[1].replace(/,/g, "")) : undefined
}

export interface TripoJob {
  operatorId: string
  status: string
  progress: number
  secondsLeft?: number
  done: boolean
  failed: boolean
  reason?: string
}

const FAILED = new Set(["failed", "banned", "cancelled", "expired"])

/** One entry of /v2/studio/progress. */
export function normalizeJob(entry: any): TripoJob | undefined {
  const operatorId = str(entry?.operator_id) ?? str(entry?.id)
  if (!operatorId) return undefined
  const status = str(entry?.status) ?? "unknown"
  const left = num(entry?.left_time)
  return {
    operatorId,
    status,
    progress: Math.max(0, Math.min(100, num(entry?.progress) ?? 0)),
    secondsLeft: left !== undefined && left >= 0 ? left : undefined,
    done: status === "success",
    failed: FAILED.has(status),
    reason: str(entry?.reason?.message)
  }
}

export interface TripoGenerateJob {
  mode: "text" | "image"
  prompt?: string
  image?: { base64: string; mimeType: string; name?: string }
  model?: string
  tPose?: boolean
  texture?: boolean
  textureQuality?: "2K" | "4K" | "8K"
  pbr?: boolean
  removeLighting?: boolean
  topology?: "quad" | "triangle"
  privacy?: "public" | "private"
}

/** A generate request, checked before anything is filled in. */
export function readGenerateJob(input: any): TripoGenerateJob {
  const v = input && typeof input === "object" ? input : {}
  const prompt = str(v.prompt)
  const image = v.image && typeof v.image.base64 === "string" && v.image.base64 ? v.image : undefined
  const mode = v.mode === "image" || (!prompt && image) ? "image" : "text"
  if (mode === "text" && !prompt) throw new Error("Give a prompt (text to 3D) or an image (image to 3D).")
  if (mode === "image" && !image) throw new Error("Image to 3D needs an image.")
  if (prompt && prompt.length > 1000) throw new Error(`Tripo takes prompts of up to 1000 characters; this one has ${prompt.length}.`)
  const quality = typeof v.textureQuality === "string" ? v.textureQuality.toUpperCase() : undefined
  if (quality !== undefined && !["2K", "4K", "8K"].includes(quality)) throw new Error('textureQuality is "2K", "4K" or "8K".')
  const topology = typeof v.topology === "string" ? v.topology.toLowerCase() : undefined
  if (topology !== undefined && topology !== "quad" && topology !== "triangle") throw new Error('topology is "quad" or "triangle".')
  const privacy = typeof v.privacy === "string" ? v.privacy.toLowerCase() : undefined
  if (privacy !== undefined && privacy !== "public" && privacy !== "private") throw new Error('privacy is "public" or "private".')
  return {
    mode,
    prompt,
    image: mode === "image" ? image : undefined,
    model: modelChoice(v.model),
    tPose: bool(v.tPose),
    texture: bool(v.texture),
    textureQuality: quality as TripoGenerateJob["textureQuality"],
    pbr: bool(v.pbr),
    removeLighting: bool(v.removeLighting),
    topology: topology as TripoGenerateJob["topology"],
    privacy: privacy as TripoGenerateJob["privacy"]
  }
}

/** The project id a page link carries after Generate (/workspace/generate/<id>). */
export const projectIdFromUrl = (href: string) => {
  const page = pageOf(href)
  return page.kind === "workspace" ? page.id : undefined
}

export const looksLikeId = (value: unknown) => typeof value === "string" && UUID_RE.test(value)
