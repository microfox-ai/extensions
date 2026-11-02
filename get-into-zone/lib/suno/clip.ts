// Suno songs as Browse Hack sees them: the raw clips suno.com's own API
// returns, cut down to what Claude, the on-page buttons, MediaMake's media
// library and its cloud database use. Pure functions, shared by the suno.com
// content script, the background worker and the popup. NOTES.md says where
// each field comes from.

export const SUNO = "https://suno.com"

export type SunoRelation =
  | "cover"
  | "extend"
  | "remaster"
  | "reuse"
  | "upload"
  | "mashup"
  | "sample"
  | "inspo"

export interface SunoSettings {
  /** 0-100, the Create form's sliders. */
  weirdness?: number
  styleInfluence?: number
  audioInfluence?: number
  /** The Variety slider's raw value (the site shows Normal for 1). */
  variety?: number
  vocalGender?: "male" | "female"
  maxMode?: boolean
}

export interface SunoClip {
  id: string
  title: string
  /** submitted, queued, streaming, complete or error. */
  status: string
  styles: string
  excludeStyles?: string
  lyrics: string
  instrumental: boolean
  /** v6, v6-wild, v6-mini… */
  model: string
  modelKey?: string
  duration?: number
  settings: SunoSettings
  /** cover, extend… as Suno names the task. */
  task?: string
  parent?: { id: string; relation: SunoRelation }
  /** The original song a remix family starts from. */
  root?: { id: string; title?: string }
  workspace?: { id: string; name: string }
  /** A downloadable link, when Suno gives one (not the metered stream). */
  audioUrl?: string
  imageUrl?: string
  pageUrl: string
  author?: string
  createdAt?: string
  batchIndex?: number
  liked?: boolean
  downloadUnlocked?: boolean
}

export interface SunoWorkspace {
  id: string
  name: string
  clipCount?: number
}

export interface SunoAccount {
  plan?: string
  creditsLeft?: number
  monthlyLimit?: number
  monthlyUsage?: number
  renewsOn?: string
  downloads?: { used: number; limit: number; extra: number; left: number }
  uploadSeconds?: { min: number; max: number }
  models: { name: string; key: string; canUse: boolean; isDefault: boolean }[]
  features: string[]
}

// Model keys Suno has used; billing/info lists the current ones too.
const MODEL_NAMES: Record<string, string> = {
  "chirp-hawk": "v6",
  "chirp-hawk-wild": "v6-wild",
  "chirp-goose": "v6-mini",
  "chirp-bluejay": "v5.5",
  "chirp-crow": "v5",
  "chirp-auk": "v4.5",
  "chirp-v4": "v4"
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A clip id from an id, a suno.com/song/<id> link or a cdn1.suno.ai/<id>.mp3 link. */
export function clipIdOf(value: unknown): string | undefined {
  const text = String(value ?? "").trim()
  if (UUID.test(text)) return text.toLowerCase()
  return text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0].toLowerCase()
}

const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const percent = (value: unknown) => {
  const n = num(value)
  return n === undefined ? undefined : Math.round(n <= 1 ? n * 100 : n)
}

// A v6-wild song's model_name is chirp-hawk, like v6's: its major_model_version says v6-wild.
export const modelName = (key: string | undefined, major?: string) =>
  (major && /^v\d/i.test(major) ? major : undefined) || (key && MODEL_NAMES[key]) || major || key || ""

const RELATIONS: Record<string, SunoRelation> = {
  cover: "cover",
  extend: "extend",
  continue: "extend",
  remaster: "remaster",
  upsample: "remaster",
  reuse: "reuse",
  upload: "upload",
  mashup: "mashup",
  sample: "sample",
  inspo: "inspo",
  inspiration: "inspo"
}

/** A raw clip from /a/api/feed or /a/api/clip, as a SunoClip. */
export function normalizeClip(raw: any): SunoClip {
  const meta = raw?.metadata ?? {}
  const sliders = meta.control_sliders ?? {}
  const lyrics = str(meta.prompt)
  const instrumental =
    meta.make_instrumental === true || lyrics.trim() === "" || /^\[instrumental\]$/i.test(lyrics.trim())
  const parentId =
    str(meta.cover_clip_id) ||
    str(meta.continue_clip_id) ||
    str(meta.edited_clip_id) ||
    str(meta.upsample_clip_id) ||
    ""
  const task = str(meta.task) || undefined
  const audio = str(raw?.audio_url)
  const gender = str(meta.vocal_gender).toLowerCase()
  const root = raw?.clip_roots?.clips?.[0]
  return {
    id: str(raw?.id),
    title: str(raw?.title),
    status: str(raw?.status),
    styles: str(meta.tags),
    excludeStyles: str(meta.negative_tags) || undefined,
    lyrics,
    instrumental,
    model: modelName(str(raw?.model_name) || undefined, str(raw?.major_model_version) || undefined),
    modelKey: str(raw?.model_name) || undefined,
    duration: num(meta.duration),
    settings: {
      weirdness: percent(sliders.weirdness_constraint ?? sliders.weirdness),
      styleInfluence: percent(sliders.style_weight),
      audioInfluence: percent(sliders.audio_weight),
      variety: num(sliders.aug_creativity),
      vocalGender: gender === "m" || gender === "male" ? "male" : gender === "f" || gender === "female" ? "female" : undefined
    },
    task,
    parent: parentId && parentId !== raw?.id ? { id: parentId, relation: RELATIONS[task ?? ""] ?? "cover" } : undefined,
    root: root?.id && root.id !== raw?.id ? { id: str(root.id), title: str(root.title) || undefined } : undefined,
    workspace: raw?.project?.id ? { id: str(raw.project.id), name: str(raw.project.name) } : undefined,
    audioUrl: audio && !/\/forbidden$/.test(audio) ? audio : undefined,
    imageUrl: str(raw?.image_large_url) || str(raw?.image_url) || undefined,
    pageUrl: `${SUNO}/song/${str(raw?.id)}`,
    author: str(raw?.handle) || undefined,
    createdAt: str(raw?.created_at) || undefined,
    batchIndex: num(raw?.batch_index),
    liked: raw?.is_liked === true ? true : undefined,
    downloadUnlocked: raw?.is_download_unlocked === true
  }
}

export function normalizeWorkspace(raw: any): SunoWorkspace {
  return { id: str(raw?.id), name: str(raw?.name), clipCount: num(raw?.clip_count) }
}

export function normalizeAccount(raw: any): SunoAccount {
  const d = raw?.download_usage
  const downloads = d
    ? {
        used: num(d.current_period_downloads_used) ?? 0,
        limit: num(d.current_period_downloads_limit) ?? 0,
        extra: num(d.additional_download_remaining) ?? 0,
        left: 0
      }
    : undefined
  if (downloads) downloads.left = Math.max(0, downloads.limit - downloads.used) + downloads.extra
  return {
    plan: str(raw?.plan?.name) || undefined,
    creditsLeft: num(raw?.total_credits_left),
    monthlyLimit: num(raw?.monthly_limit),
    monthlyUsage: num(raw?.monthly_usage),
    renewsOn: str(raw?.renews_on) || undefined,
    downloads,
    uploadSeconds:
      raw?.audio_upload_limits && num(raw.audio_upload_limits.max)
        ? { min: num(raw.audio_upload_limits.min) ?? 0, max: num(raw.audio_upload_limits.max)! }
        : undefined,
    models: (Array.isArray(raw?.models) ? raw.models : []).map((m: any) => ({
      name: str(m?.name),
      key: str(m?.external_key),
      canUse: m?.can_use !== false,
      isDefault: m?.is_default_model === true
    })),
    features: (Array.isArray(raw?.accessible_features) ? raw.accessible_features : [])
      .map((f: any) => str(f?.name))
      .filter(Boolean)
  }
}

/** The settings as one line: "v6-wild · Weirdness 50% · Style influence 80%". */
export function settingsLine(clip: Pick<SunoClip, "model" | "settings" | "instrumental">) {
  const s = clip.settings
  return [
    clip.model,
    clip.instrumental ? "instrumental" : undefined,
    s.vocalGender ? `${s.vocalGender} vocals` : undefined,
    s.weirdness !== undefined ? `Weirdness ${s.weirdness}%` : undefined,
    s.styleInfluence !== undefined ? `Style influence ${s.styleInfluence}%` : undefined,
    s.audioInfluence !== undefined ? `Audio influence ${s.audioInfluence}%` : undefined,
    s.variety !== undefined ? `Variety ${s.variety}` : undefined,
    s.maxMode ? "Max Mode" : undefined
  ]
    .filter(Boolean)
    .join(" · ")
}

/**
 * What "Copy for Claude" puts on the clipboard: everything Claude needs to make
 * more of a song with Browse Hack, ending with a request to edit.
 */
export function copyForClaude(clip: SunoClip, channel?: string) {
  const where = [clip.workspace?.name && `Suno workspace: ${clip.workspace.name}`, channel && `MediaMake channel: ${channel}`]
    .filter(Boolean)
    .join(" · ")
  const lines = [
    `Suno song: ${clip.title || "(untitled)"}`,
    `Link: ${clip.pageUrl}`,
    where,
    clip.parent ? `It is a ${clip.parent.relation} of ${SUNO}/song/${clip.parent.id}` : "",
    `Settings: ${settingsLine(clip)}`,
    `Styles: ${clip.styles || "(none)"}`,
    clip.excludeStyles ? `Exclude styles: ${clip.excludeStyles}` : "",
    "Lyrics:",
    clip.instrumental ? "[Instrumental]" : clip.lyrics.trim(),
    "",
    `Ask Claude: "With Browse Hack, make 3 covers of this Suno song (${clip.id}) in <a new style>, keep the lyrics${
      channel ? `, and save the keepers to ${channel}` : ""
    }."`
  ]
  return lines.filter((line, i) => line !== "" || i === lines.length - 2).join("\n")
}

/** A file name for a song: "<Title> [<first 8 of the id>]", safe on every disk. */
export function songFileBase(clip: Pick<SunoClip, "id" | "title">) {
  const title = (clip.title || "Untitled")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 120)
  return `${title || "Untitled"} [${clip.id.slice(0, 8)}]`
}

// MediaMake's database names fewer kinds and statuses than Suno: the rest map to the nearest.
const CLOUD_KINDS = new Set(["create", "cover", "extend", "remaster", "reuse", "upload"])
export const cloudKind = (kind: string) => (CLOUD_KINDS.has(kind) ? kind : "cover")
export const cloudStatus = (status: string) =>
  status === "complete" ? "complete" : status === "error" ? "failed" : status === "streaming" ? "generating" : "queued"

/** The record MediaMake's cloud database keeps for one take (POST /api/generations). */
export function generationRecord(
  clip: SunoClip,
  extra: { kind?: string; sourceItem?: string; batchId?: string; credits?: number } = {}
) {
  return {
    tool: "suno",
    ref: clip.id,
    kind: cloudKind(extra.kind ?? (clip.parent ? clip.parent.relation : "create")),
    parentRef: clip.parent?.id,
    sourceItem: extra.sourceItem,
    batchId: extra.batchId,
    title: clip.title,
    styles: clip.styles,
    excludeStyles: clip.excludeStyles,
    lyrics: clip.instrumental ? "" : clip.lyrics,
    instrumental: clip.instrumental,
    model: clip.model,
    settings: clip.settings,
    workspace: clip.workspace,
    status: cloudStatus(clip.status),
    audioUrl: clip.audioUrl,
    imageUrl: clip.imageUrl,
    pageUrl: clip.pageUrl,
    duration: clip.duration,
    credits: extra.credits,
    createdAt: clip.createdAt
  }
}

const DONE = new Set(["complete", "error"])
export const isFinished = (clip: Pick<SunoClip, "status">) => DONE.has(clip.status)
