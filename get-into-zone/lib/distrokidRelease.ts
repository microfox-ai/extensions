// Shared DistroKid release metadata. The popup reads info.json; the content
// script fills https://distrokid.com/new/ from the parsed release. The Claude
// skill writes the same file. Typo keys from early drafts are accepted.

export const PRIMARY_GENRES = [
  "Afrobeat",
  "Afropop",
  "Alternative",
  "Big Band",
  "Blues",
  "Children's Music",
  "Christian/Gospel",
  "Classical",
  "Comedy",
  "Contemporary Latin",
  "Country",
  "Dance",
  "Electronic",
  "Fitness & Workout",
  "Folk",
  "French Pop",
  "German Folk",
  "German Pop",
  "Hip Hop/Rap",
  "Holiday",
  "J-Pop",
  "Jazz",
  "K-Pop",
  "Latin",
  "Latin House",
  "Latin Jazz",
  "Latin Urban",
  "Maskandi",
  "Metal",
  "New Age",
  "Pop",
  "Pop in Spanish",
  "Punk",
  "R&B/Soul",
  "Reggae",
  "Rock",
  "Rock en Español",
  "Singer/Songwriter",
  "Soundtrack",
  "Spoken Word",
  "Vocal",
  "World",
  "Xigaza"
] as const

/** Secondary dropdown has no Soundtrack option. */
export const SECONDARY_GENRES = PRIMARY_GENRES.filter((g) => g !== "Soundtrack")

export const ELECTRONIC_SUBGENRES = [
  "Big Room",
  "Breaks",
  "Chill Out",
  "Deep House",
  "Drum & Bass",
  "Dubstep",
  "Electro House",
  "Electronica / Downtempo",
  "Funk / Soul / Disco",
  "Glitch Hop",
  "Hard Dance",
  "Hardcore / Hard Techno",
  "Hip-Hop / R&B",
  "House",
  "Indie Dance / Nu Disco",
  "Minimal / Deep Tech",
  "Progressive House",
  "Psy-Trance",
  "Reggae / Dancehall / Dub",
  "Tech House",
  "Techno",
  "Trance"
] as const

export const SONGWRITER_CREDITS = ["music", "lyrics", "music and lyrics"] as const

/** Used when info.json does not name a label. */
export const DEFAULT_RECORD_LABEL = "ZONE MUSIC"

export type SongwriterCredit = (typeof SONGWRITER_CREDITS)[number]

export type SongWriter = {
  firstName: string
  middleName: string
  lastName: string
  credit: SongwriterCredit
}

export type DistrokidRelease = {
  artist: string
  releaseDate: string
  primaryGenre: string
  electronicSubGenre: string
  secondaryGenre: string
  isApplePublish: boolean
  songTitle: string
  version: string
  songWriters: SongWriter[]
  instrumental: boolean
  /** Checks Explicit lyrics on the DistroKid upload form. */
  isExplicit: boolean
  recordLabel: string
  creditPerformerRole: string
  creditPerformerName: string
  /** Producer role, matching the Apple producer dropdown. */
  creditProducer: string
  creditProducerName: string
}

export type DistrokidFillResult = {
  ok: boolean
  message: string
  warnings: string[]
  filled: string[]
}

const AUDIO_EXTS = [".wav", ".m4a", ".mp3"] as const
const AUDIO_RANK: Record<string, number> = { ".wav": 0, ".m4a": 1, ".mp3": 2 }
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"]

export function titleCaseSong(value: string): string {
  return value
    .trim()
    .split(/(\s+)/)
    .map((part) => {
      if (!part.trim()) return part
      const letters = part.replace(/[^A-Za-z]/g, "")
      if (
        letters.length > 1 &&
        letters === letters.toUpperCase() &&
        /[A-Z]/.test(letters)
      ) {
        return part
      }
      const lower = part.toLowerCase()
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join("")
}

function normLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*&\s*/g, " & ")
    .replace(/\s+/g, " ")
}

export function matchLabel(list: readonly string[], value: string): string | null {
  const want = normLabel(value)
  if (!want) return null
  return list.find((item) => normLabel(item) === want) ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  const folded = new Map(
    Object.keys(obj).map((key) => [key.toLowerCase().replace(/[\s_]+/g, ""), key])
  )
  for (const key of keys) {
    const found = folded.get(key.toLowerCase().replace(/[\s_]+/g, ""))
    if (!found) continue
    const value = obj[found]
    if (value !== undefined && value !== null && value !== "") return value
  }
  return undefined
}

function asBool(value: unknown): boolean | null {
  if (typeof value === "boolean") return value
  if (typeof value === "number") {
    if (value === 1) return true
    if (value === 0) return false
    return null
  }
  if (typeof value === "string") {
    const s = value.trim().toLowerCase()
    if (["true", "yes", "1"].includes(s)) return true
    if (["false", "no", "0"].includes(s)) return false
  }
  return null
}

function asCredit(value: unknown): SongwriterCredit | null {
  if (typeof value !== "string") return null
  const s = value.trim().toLowerCase().replace(/\s+/g, " ")
  if (s === "music") return "music"
  if (s === "lyrics" || s === "lyric") return "lyrics"
  if (
    s === "music and lyrics" ||
    s === "music & lyrics" ||
    s === "music and lyric" ||
    s === "both"
  ) {
    return "music and lyrics"
  }
  return matchLabel(SONGWRITER_CREDITS, s) as SongwriterCredit | null
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

export function parseDistrokidInfo(raw: unknown): {
  release: DistrokidRelease
  errors: string[]
} {
  const obj = asRecord(raw)
  const errors: string[] = []
  if (!obj) {
    return { release: emptyRelease(), errors: ["info.json must be a JSON object."] }
  }

  const primaryRaw = asText(
    pick(obj, ["primaryGenre", "priamryGene", "primaryGene", "priamryGenre"])
  )
  const primary = matchLabel(PRIMARY_GENRES, primaryRaw)
  if (!primaryRaw) errors.push("primaryGenre is missing.")
  else if (!primary) errors.push(`primaryGenre "${primaryRaw}" is not in the DistroKid list.`)

  const secondaryRaw = asText(pick(obj, ["secondaryGenre", "secondaryGene"]))
  const secondary = secondaryRaw ? matchLabel(SECONDARY_GENRES, secondaryRaw) : ""
  if (secondaryRaw && !secondary) {
    errors.push(
      `secondaryGenre "${secondaryRaw}" is not in the DistroKid list. Soundtrack is primary-only.`
    )
  }

  const electronicRaw = asText(
    pick(obj, ["electronicSubGenre", "electronicSubgenre", "subGenre"])
  )
  const electronic = electronicRaw
    ? matchLabel(ELECTRONIC_SUBGENRES, electronicRaw)
    : ""
  const needsElectronic = primary === "Electronic" || secondary === "Electronic"
  if (needsElectronic && !electronicRaw) {
    errors.push("electronicSubGenre is required when Electronic is selected.")
  } else if (electronicRaw && !electronic) {
    errors.push(`electronicSubGenre "${electronicRaw}" is not in the DistroKid list.`)
  } else if (!needsElectronic && electronic) {
    errors.push("electronicSubGenre is set, but neither genre is Electronic.")
  }

  const apple = asBool(
    pick(obj, ["isApplePublish", "isAPplePublish", "isApplepublish"])
  )
  if (apple === null) errors.push("isApplePublish must be true or false.")

  const artist = asText(pick(obj, ["artist"]))
  if (!artist) errors.push("artist is missing.")

  const releaseDate = asText(pick(obj, ["releaseDate", "releasedate"]))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    errors.push("releaseDate must be YYYY-MM-DD.")
  }

  const songTitleRaw = asText(pick(obj, ["songTitle", "songtitle"]))
  if (!songTitleRaw) errors.push("songTitle is missing.")
  const songTitle = songTitleRaw ? titleCaseSong(songTitleRaw) : ""

  const version = asText(pick(obj, ["version"]))

  const instrumental = asBool(pick(obj, ["instrumental"]))
  if (instrumental === null) errors.push("instrumental must be true or false.")

  const explicitRaw = pick(obj, ["isExplicit", "explicit"])
  const explicit = explicitRaw === undefined ? false : asBool(explicitRaw)
  if (explicit === null) errors.push("isExplicit must be true or false.")

  const recordLabel =
    asText(pick(obj, ["recordLabel", "labelName"])) || DEFAULT_RECORD_LABEL

  const writersRaw = pick(obj, ["songWriters", "songWrites", "songwriters"])
  const songWriters: SongWriter[] = []
  if (!Array.isArray(writersRaw) || writersRaw.length === 0) {
    errors.push("songWriters must list at least one songwriter.")
  } else {
    writersRaw.forEach((entry, index) => {
      const row = asRecord(entry)
      const n = index + 1
      if (!row) {
        errors.push(`Songwriter ${n} must be an object.`)
        return
      }
      const firstName = asText(pick(row, ["firstName", "firstname", "first"]))
      const middleName = asText(pick(row, ["middleName", "middlename", "middle"]))
      const lastName = asText(pick(row, ["lastName", "lastname", "last"]))
      const credit = asCredit(pick(row, ["credit"]))
      if (!firstName) errors.push(`Songwriter ${n} is missing firstName.`)
      if (!lastName) errors.push(`Songwriter ${n} is missing lastName.`)
      if (!credit) {
        errors.push(
          `Songwriter ${n} credit must be "music", "lyrics", or "music and lyrics".`
        )
      }
      if (firstName && lastName && credit) {
        songWriters.push({ firstName, middleName, lastName, credit })
      }
    })
  }

  const creditPerformerRole = asText(pick(obj, ["creditPerformerRole"]))
  const creditPerformerName = asText(pick(obj, ["creditPerformerName"]))
  const creditProducer = asText(
    pick(obj, ["creditProducer", "creditProducerRole"])
  )
  const creditProducerName = asText(pick(obj, ["creditProducerName"]))
  if (apple) {
    if (!creditPerformerRole) errors.push("creditPerformerRole is required when isApplePublish is true.")
    if (!creditPerformerName) errors.push("creditPerformerName is required when isApplePublish is true.")
    if (!creditProducer) errors.push("creditProducer is required when isApplePublish is true.")
    if (!creditProducerName) errors.push("creditProducerName is required when isApplePublish is true.")
  }

  return {
    release: {
      artist,
      releaseDate,
      primaryGenre: primary || primaryRaw,
      electronicSubGenre: electronic || "",
      secondaryGenre: secondary || "",
      isApplePublish: apple === true,
      songTitle,
      version,
      songWriters,
      instrumental: instrumental === true,
      isExplicit: explicit === true,
      recordLabel,
      creditPerformerRole,
      creditPerformerName,
      creditProducer,
      creditProducerName
    },
    errors
  }
}

function emptyRelease(): DistrokidRelease {
  return {
    artist: "",
    releaseDate: "",
    primaryGenre: "",
    electronicSubGenre: "",
    secondaryGenre: "",
    isApplePublish: false,
    songTitle: "",
    version: "",
    songWriters: [],
    instrumental: false,
    isExplicit: false,
    recordLabel: "",
    creditPerformerRole: "",
    creditPerformerName: "",
    creditProducer: "",
    creditProducerName: ""
  }
}

export function fileExt(name: string): string {
  const base = name.split(/[/\\]/).pop() || name
  const dot = base.lastIndexOf(".")
  return dot >= 0 ? base.slice(dot).toLowerCase() : ""
}

export function fileStem(name: string): string {
  const base = name.split(/[/\\]/).pop() || name
  return base.replace(/\.[^.]+$/, "").toLowerCase()
}

export function isIgnoredReleaseFile(file: File): boolean {
  const path = file.webkitRelativePath || file.name
  const parts = path.split(/[/\\]/)
  if (parts.some((part) => part === "__MACOSX" || part.startsWith("."))) return true
  const base = parts[parts.length - 1] || ""
  return base.startsWith("._") || base.startsWith(".")
}

/** One file per song. Extra formats of the same name keep wav, then m4a, then mp3. */
export function pickAudioTracks(files: File[]): { tracks: File[]; note: string } {
  const audio = files.filter((file) =>
    (AUDIO_EXTS as readonly string[]).includes(fileExt(file.name))
  )
  const groups = new Map<string, File[]>()
  for (const file of audio) {
    const stem = fileStem(file.name)
    const list = groups.get(stem) || []
    list.push(file)
    groups.set(stem, list)
  }
  const tracks = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, group]) =>
      [...group].sort(
        (a, b) =>
          (AUDIO_RANK[fileExt(a.name)] ?? 9) - (AUDIO_RANK[fileExt(b.name)] ?? 9)
      )[0]
    )
  const skipped = audio.length - tracks.length
  const note =
    tracks.length === 0
      ? "No .wav, .m4a, or .mp3 file in this folder."
      : skipped > 0
        ? `${tracks.length} track${tracks.length === 1 ? "" : "s"}. Skipped ${skipped} extra format${skipped === 1 ? "" : "s"} of the same name (wav, then m4a, then mp3).`
        : `${tracks.length} audio file${tracks.length === 1 ? "" : "s"}.`
  return { tracks, note }
}

export function isCoverCandidate(file: File): boolean {
  return IMAGE_EXTS.includes(fileExt(file.name))
}

export function findInfoJson(files: File[]): File | null {
  const matches = files.filter((file) => file.name.toLowerCase() === "info.json")
  matches.sort(
    (a, b) =>
      (a.webkitRelativePath || a.name).split(/[/\\]/).length -
      (b.webkitRelativePath || b.name).split(/[/\\]/).length
  )
  return matches[0] || null
}

export function findLyricsFile(files: File[]): File | null {
  const json = files.filter(
    (file) =>
      fileExt(file.name) === ".json" && file.name.toLowerCase() !== "info.json"
  )
  json.sort((a, b) => {
    const aLyric = /lyric/i.test(a.name) ? 0 : 1
    const bLyric = /lyric/i.test(b.name) ? 0 : 1
    return aLyric - bLyric || a.name.localeCompare(b.name)
  })
  return json[0] || null
}

export async function readInfoFile(file: File): Promise<{
  release: DistrokidRelease
  errors: string[]
}> {
  let text = ""
  try {
    text = (await file.text()).replace(/^\uFEFF/, "")
  } catch {
    return { release: emptyRelease(), errors: ["Could not read info.json."] }
  }
  try {
    return parseDistrokidInfo(JSON.parse(text))
  } catch {
    return { release: emptyRelease(), errors: ["info.json is not valid JSON."] }
  }
}
