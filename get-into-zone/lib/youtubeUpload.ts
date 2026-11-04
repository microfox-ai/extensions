// info.json for a YouTube upload: which channel, and what goes in YouTube
// Studio's upload dialog. The MCP server reads the pack folder, puts the title
// and description text in, and streams the video and thumbnail; this checks the
// rest. A field left out keeps YouTube's own default.

export type YoutubeVisibility = "private" | "unlisted" | "public" | "scheduled"

export type YoutubeUploadInfo = {
  channel: string
  title: string
  description: string | null
  playlists: string[]
  madeForKids: boolean
  ageRestricted: boolean | null
  paidPromotion: boolean | null
  alteredContent: boolean | null
  automaticChapters: boolean | null
  featuredPlaces: boolean | null
  automaticConcepts: boolean | null
  tags: string[] | null
  /** A language code (en, te, ja) or its name as Studio lists it (English). */
  language: string | null
  license: "standard" | "creative-commons" | null
  allowEmbedding: boolean | null
  notifySubscribers: boolean | null
  shortsRemixing: "video-and-audio" | "audio-only" | "off" | null
  /** Studio's category id, e.g. MUSIC (CREATOR_VIDEO_CATEGORY_MUSIC). */
  category: string | null
  comments: "on" | "off" | null
  commentModeration: "none" | "basic" | "strict" | "hold-all" | null
  whoCanComment: "anyone" | "subscribers" | null
  commentSort: "top" | "newest" | null
  showLikes: boolean | null
  visibility: YoutubeVisibility | null
  /** Studio's own time zone; date YYYY-MM-DD, time HH:MM (24 h). */
  scheduleAt: { date: string; time: string } | null
  premiere: boolean | null
  /** The Monetisation step of channels in the Partner Programme. Left out: On. */
  monetization: boolean | null
  /** The Ad suitability step: "none" ticks None of the above and submits. Left out: "none". */
  adSuitability: "none" | "skip" | null
  /** Video elements → End screen → Import from video, then the playlist element's playlist. */
  endScreen: { importFrom: string; playlist: string | null } | null
  /** Video elements → Cards: channel cards. */
  cards: YoutubeChannelCard[]
}

export type YoutubeChannelCard = { channel: string; message: string; teaser: string }

export type YoutubeChannel = {
  name: string
  handle: string
  selected: boolean
  /** "You're a manager • 8 subscribers" */
  byline: string
}

export type YoutubeFillResult = {
  ok: boolean
  message: string
  warnings: string[]
  filled: string[]
  videoUrl?: string
}

export const TITLE_MAX = 100
export const DESCRIPTION_MAX_BYTES = 5000
export const TAGS_MAX = 500
/** A card's custom message and teaser text. */
export const CARD_TEXT_MAX = 30

const CATEGORIES: Record<string, string> = {
  autos: "AUTOS",
  autosandvehicles: "AUTOS",
  carsandvehicles: "AUTOS",
  comedy: "COMEDY",
  education: "EDUCATION",
  entertainment: "ENTERTAINMENT",
  film: "FILM",
  filmandanimation: "FILM",
  gaming: "GADGETS",
  howto: "HOWTO",
  howtoandstyle: "HOWTO",
  music: "MUSIC",
  news: "NEWS",
  newsandpolitics: "NEWS",
  nonprofits: "GOVERNMENT",
  nonprofitsandactivism: "GOVERNMENT",
  people: "PEOPLE",
  peopleandblogs: "PEOPLE",
  pets: "PETS",
  petsandanimals: "PETS",
  science: "SCIENCE",
  scienceandtechnology: "SCIENCE",
  sport: "SPORTS",
  sports: "SPORTS",
  travel: "TRAVEL",
  travelandevents: "TRAVEL"
}
const CATEGORY_IDS = new Set(Object.values(CATEGORIES))

function fold(value: string): string {
  return value.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "")
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  const folded = new Map(Object.keys(obj).map((key) => [fold(key), key]))
  for (const key of keys) {
    const found = folded.get(fold(key))
    if (!found) continue
    const value = obj[found]
    if (value !== undefined && value !== null && value !== "") return value
  }
  return undefined
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const s = value.trim().toLowerCase()
    if (["true", "yes", "1", "on"].includes(s)) return true
    if (["false", "no", "0", "off"].includes(s)) return false
  }
  return null
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/** Every key the parser reads, so a typo shows up as a warning. */
const KNOWN_KEYS = new Set(
  [
    "channel", "video", "title", "titleFile", "description", "descriptionFile", "thumbnail",
    "playlists", "playlist", "madeForKids", "ageRestricted", "ageRestriction", "paidPromotion",
    "alteredContent", "aiContent", "automaticChapters", "featuredPlaces", "automaticPlaces",
    "automaticConcepts", "tags", "language", "license", "licence", "allowEmbedding",
    "notifySubscribers", "shortsRemixing", "category", "comments", "commentModeration",
    "whoCanComment", "commentSort", "showLikes", "visibility", "scheduleAt", "premiere",
    "monetization", "monetisation", "adSuitability", "endScreen", "cards",
    "$schema", "notes"
  ].map(fold)
)

/** A channel as info.json names it: a handle (@name), its title, or a UC… id. */
export function channelKey(value: string): { kind: "id" | "handle" | "name"; value: string } {
  const text = value.trim()
  const url = text.match(/youtube\.com\/(?:channel\/(UC[\w-]{22})|(@[\w.-]+))/i)
  if (url?.[1]) return { kind: "id", value: url[1] }
  if (url?.[2]) return { kind: "handle", value: url[2].toLowerCase() }
  if (/^UC[\w-]{22}$/.test(text)) return { kind: "id", value: text }
  if (text.startsWith("@")) return { kind: "handle", value: text.toLowerCase() }
  return { kind: "name", value: text.replace(/\s+/g, " ").toLowerCase() }
}

export function channelMatches(channel: YoutubeChannel, wanted: string): boolean {
  const key = channelKey(wanted)
  if (key.kind === "handle") return channel.handle.toLowerCase() === key.value
  if (key.kind === "name") {
    return (
      channel.name.replace(/\s+/g, " ").trim().toLowerCase() === key.value ||
      channel.handle.toLowerCase() === `@${key.value.replace(/\s+/g, "")}`
    )
  }
  return false
}

/** YouTube counts a tag with a space as if it were quoted, plus a comma between tags. */
export function tagsLength(tags: string[]): number {
  return tags.reduce((sum, tag) => sum + tag.length + (/\s/.test(tag) ? 2 : 0), 0) +
    Math.max(0, tags.length - 1)
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
}

function parseChoice<T extends string>(
  obj: Record<string, unknown>,
  keys: string[],
  options: Record<string, T>,
  errors: string[]
): T | null {
  const raw = pick(obj, keys)
  if (raw === undefined) return null
  const found = typeof raw === "string" ? options[fold(raw)] : undefined
  if (!found) {
    const allowed = [...new Set(Object.values(options))].join(", ")
    errors.push(`${keys[0]} must be one of: ${allowed}.`)
    return null
  }
  return found
}

function parseFlag(
  obj: Record<string, unknown>,
  keys: string[],
  errors: string[]
): boolean | null {
  const raw = pick(obj, keys)
  if (raw === undefined) return null
  const value = asBool(raw)
  if (value === null) errors.push(`${keys[0]} must be true or false.`)
  return value
}

function parseSchedule(raw: string): { date: string; time: string } | null {
  const match = raw.trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2})/)
  if (!match) return null
  const hours = Number(match[2])
  const minutes = Number(match[3])
  if (hours > 23 || minutes > 59) return null
  const [y, m, d] = match[1].split("-").map(Number)
  const day = new Date(y, m - 1, d)
  if (day.getFullYear() !== y || day.getMonth() !== m - 1 || day.getDate() !== d) return null
  return { date: match[1], time: `${String(hours).padStart(2, "0")}:${match[3]}` }
}

/** "endScreen": "<video title>" or { "importFrom": "<video title>", "playlist": "<playlist>" }. */
function parseEndScreen(raw: unknown, errors: string[]): YoutubeUploadInfo["endScreen"] {
  if (raw === undefined) return null
  const obj = asRecord(raw)
  const importFrom = asText(obj ? pick(obj, ["importFrom", "from", "video"]) : raw)
  if (!importFrom) {
    errors.push('endScreen must be the title of the video to import it from, or { "importFrom": "<title>", "playlist": "<playlist>" }.')
    return null
  }
  return { importFrom, playlist: (obj && asText(pick(obj, ["playlist"]))) || null }
}

function parseCards(raw: unknown, errors: string[]): YoutubeChannelCard[] {
  if (raw === undefined) return []
  const cards: YoutubeChannelCard[] = []
  for (const [index, item] of (Array.isArray(raw) ? raw : [raw]).entries()) {
    const obj = asRecord(item)
    const label = `cards[${index}]`
    if (!obj) {
      errors.push(`${label} must be an object like { "channel": "@handle", "message": "…", "teaser": "…" }.`)
      continue
    }
    const channel = asText(pick(obj, ["channel"]))
    if (!channel) {
      errors.push(`${label}: only channel cards can be added for now; give "channel" (its @handle or name).`)
      continue
    }
    const message = asText(pick(obj, ["message", "customMessage"]))
    const teaser = asText(pick(obj, ["teaser", "teaserText"]))
    if (!message) errors.push(`${label}: a channel card needs a "message" (YouTube's Custom message).`)
    for (const [name, value] of [["message", message], ["teaser", teaser]]) {
      if (value.length > CARD_TEXT_MAX) errors.push(`${label}: ${name} is ${value.length} characters; YouTube allows ${CARD_TEXT_MAX}.`)
    }
    if (message) cards.push({ channel, message, teaser: teaser || message })
  }
  return cards
}

export function parseYoutubeUploadInfo(raw: unknown): {
  info: YoutubeUploadInfo
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  const obj = asRecord(raw) || {}
  if (!asRecord(raw)) errors.push("info.json must be a JSON object.")

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(fold(key))) warnings.push(`info.json has "${key}", which isn't used.`)
  }

  const channel = asText(pick(obj, ["channel"]))
  if (!channel) errors.push('channel is missing: the handle (e.g. "@anime-music-zone"), name or channel id.')

  const title = asText(pick(obj, ["title"]))
  if (!title) errors.push("title is missing (or title.txt).")
  else if (title.length > TITLE_MAX) errors.push(`title is ${title.length} characters; YouTube allows ${TITLE_MAX}.`)
  if (/[<>]/.test(title)) errors.push("title can't contain < or >.")

  const descriptionRaw = pick(obj, ["description"])
  const description = typeof descriptionRaw === "string" ? descriptionRaw.replace(/\r\n/g, "\n").replace(/\s+$/, "") : null
  if (description !== null) {
    const bytes = utf8Bytes(description)
    if (bytes > DESCRIPTION_MAX_BYTES) {
      errors.push(`description is ${bytes} bytes; YouTube allows ${DESCRIPTION_MAX_BYTES}.`)
    }
    if (/[<>]/.test(description)) errors.push("description can't contain < or >.")
  }

  const playlistsRaw = pick(obj, ["playlists", "playlist"])
  const playlists = (Array.isArray(playlistsRaw) ? playlistsRaw : playlistsRaw ? [playlistsRaw] : [])
    .map(asText)
    .filter(Boolean)

  const kids = pick(obj, ["madeForKids"])
  const madeForKids = kids === undefined ? false : asBool(kids)
  if (madeForKids === null) errors.push("madeForKids must be true or false.")
  if (kids === undefined) warnings.push("madeForKids isn't set; answered No, it's not Made for Kids.")

  const tagsRaw = pick(obj, ["tags"])
  let tags: string[] | null = null
  if (tagsRaw !== undefined) {
    const list = Array.isArray(tagsRaw) ? tagsRaw : typeof tagsRaw === "string" ? tagsRaw.split(",") : null
    if (!list) errors.push("tags must be a list of words or one comma-separated string.")
    else {
      tags = [...new Set(list.map(asText).map((tag) => tag.replace(/^#/, "")).filter(Boolean))]
      if (tags.some((tag) => /[<>,]/.test(tag))) errors.push("A tag can't contain <, > or a comma.")
      const length = tagsLength(tags)
      if (length > TAGS_MAX) errors.push(`tags add up to ${length} characters; YouTube allows ${TAGS_MAX}.`)
    }
  }

  const categoryRaw = asText(pick(obj, ["category"]))
  let category: string | null = null
  if (categoryRaw) {
    const id = categoryRaw.toUpperCase().replace(/^CREATOR_VIDEO_CATEGORY_/, "")
    category = CATEGORY_IDS.has(id) ? id : CATEGORIES[fold(categoryRaw)] || null
    if (!category) errors.push(`category "${categoryRaw}" is not a YouTube category (e.g. Music, Entertainment, Film and animation).`)
  }

  const visibility = parseChoice(obj, ["visibility"], {
    private: "private",
    unlisted: "unlisted",
    public: "public",
    scheduled: "scheduled",
    schedule: "scheduled"
  }, errors)
  const scheduleRaw = asText(pick(obj, ["scheduleAt"]))
  const scheduleAt = scheduleRaw ? parseSchedule(scheduleRaw) : null
  if (scheduleRaw && !scheduleAt) errors.push('scheduleAt must be "YYYY-MM-DDTHH:MM" (24-hour, in the channel\'s time zone).')
  if (visibility === "scheduled" && !scheduleRaw) errors.push("visibility is scheduled, but scheduleAt is missing.")
  if (scheduleAt && visibility && visibility !== "scheduled") {
    errors.push(`scheduleAt is set, but visibility is ${visibility}. Use "scheduled" (or leave visibility out).`)
  }
  if (scheduleAt) {
    const [y, m, d] = scheduleAt.date.split("-").map(Number)
    const [h, min] = scheduleAt.time.split(":").map(Number)
    if (new Date(y, m - 1, d, h, min).getTime() < Date.now()) {
      warnings.push(`scheduleAt ${scheduleRaw} is in the past here; YouTube needs a time in the future.`)
    }
  }

  const premiere = parseFlag(obj, ["premiere"], errors)
  const finalVisibility = visibility ?? (scheduleAt ? "scheduled" : null)
  if (premiere && finalVisibility !== "public" && finalVisibility !== "scheduled") {
    errors.push("premiere needs visibility public or scheduled.")
  }

  const info: YoutubeUploadInfo = {
    channel,
    title,
    description,
    playlists,
    madeForKids: madeForKids ?? false,
    ageRestricted: parseFlag(obj, ["ageRestricted", "ageRestriction"], errors),
    paidPromotion: parseFlag(obj, ["paidPromotion"], errors),
    alteredContent: parseFlag(obj, ["alteredContent", "aiContent"], errors),
    automaticChapters: parseFlag(obj, ["automaticChapters"], errors),
    featuredPlaces: parseFlag(obj, ["featuredPlaces", "automaticPlaces"], errors),
    automaticConcepts: parseFlag(obj, ["automaticConcepts"], errors),
    tags,
    language: asText(pick(obj, ["language"])) || null,
    license: parseChoice(obj, ["license", "licence"], {
      standard: "standard",
      standardyoutubelicense: "standard",
      standardyoutubelicence: "standard",
      creativecommons: "creative-commons",
      cc: "creative-commons",
      ccby: "creative-commons"
    }, errors),
    allowEmbedding: parseFlag(obj, ["allowEmbedding"], errors),
    notifySubscribers: parseFlag(obj, ["notifySubscribers"], errors),
    shortsRemixing: parseChoice(obj, ["shortsRemixing"], {
      videoandaudio: "video-and-audio",
      on: "video-and-audio",
      allow: "video-and-audio",
      audioonly: "audio-only",
      audio: "audio-only",
      off: "off",
      none: "off",
      dontallow: "off"
    }, errors),
    category,
    comments: parseChoice(obj, ["comments"], { on: "on", off: "off" }, errors),
    commentModeration: parseChoice(obj, ["commentModeration"], {
      none: "none",
      basic: "basic",
      strict: "strict",
      holdall: "hold-all"
    }, errors),
    whoCanComment: parseChoice(obj, ["whoCanComment"], {
      anyone: "anyone",
      subscribers: "subscribers",
      subscribersandmembers: "subscribers"
    }, errors),
    commentSort: parseChoice(obj, ["commentSort"], { top: "top", newest: "newest", latest: "newest" }, errors),
    showLikes: parseFlag(obj, ["showLikes"], errors),
    visibility: finalVisibility,
    scheduleAt,
    premiere,
    monetization: parseFlag(obj, ["monetization", "monetisation"], errors),
    adSuitability: parseChoice(obj, ["adSuitability"], {
      none: "none",
      noneoftheabove: "none",
      skip: "skip",
      manual: "skip"
    }, errors),
    endScreen: parseEndScreen(pick(obj, ["endScreen"]), errors),
    cards: parseCards(pick(obj, ["cards"]), errors)
  }
  return { info, errors, warnings }
}
