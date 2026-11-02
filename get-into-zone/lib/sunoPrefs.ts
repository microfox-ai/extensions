// Browse Hack's Suno settings, in chrome.storage.local. A channel is one of
// MediaMake's (its id from ~/.mediamake/config.json, e.g. animemusiczone),
// linked to the Suno workspace its songs are made in and the MediaMake cloud
// project its songs are recorded under. The MCP server fills in the channels
// and the library's inbox when it runs; the user links them in the popup's
// Suno tab. allowUploadTerms changes only there, never through Claude.

export const SUNO_PREFS_KEY = "sunoPrefs"

export interface SunoChannel {
  /** The library's channel id. */
  id: string
  /** Its folder in Downloads, from the library config (AMZ). */
  folder?: string
  workspaceId?: string
  workspaceName?: string
  /** The MediaMake cloud project its songs are recorded under. */
  projectId?: string
  projectName?: string
}

export interface SunoPrefs {
  channels: SunoChannel[]
  /** The library inbox, relative to Downloads. */
  inboxFolder: string
  downloadFormat: "mp3" | "wav"
  /** File songs downloaded by hand on suno.com into the inbox too. */
  routeDownloads: boolean
  /** Let Browse Hack accept Suno's upload terms (the user owns or licenses what they cover). */
  allowUploadTerms: boolean
}

export const DEFAULT_SUNO_PREFS: SunoPrefs = {
  channels: [],
  inboxFolder: "_INBOX",
  downloadFormat: "mp3",
  routeDownloads: false,
  allowUploadTerms: false
}

export function readSunoPrefs(value: unknown): SunoPrefs {
  const v = (value && typeof value === "object" ? value : {}) as Partial<SunoPrefs>
  return {
    channels: Array.isArray(v.channels)
      ? v.channels.filter((c): c is SunoChannel => typeof c?.id === "string" && c.id.trim() !== "")
      : [],
    inboxFolder: typeof v.inboxFolder === "string" && v.inboxFolder.trim() ? v.inboxFolder.trim() : DEFAULT_SUNO_PREFS.inboxFolder,
    downloadFormat: v.downloadFormat === "wav" ? "wav" : "mp3",
    routeDownloads: v.routeDownloads === true,
    allowUploadTerms: v.allowUploadTerms === true
  }
}

export async function loadSunoPrefs() {
  const stored = await chrome.storage.local.get(SUNO_PREFS_KEY)
  return readSunoPrefs(stored[SUNO_PREFS_KEY])
}

export async function saveSunoPrefs(update: Partial<SunoPrefs>) {
  const next = readSunoPrefs({ ...(await loadSunoPrefs()), ...update })
  await chrome.storage.local.set({ [SUNO_PREFS_KEY]: next })
  return next
}

/** Merges channels the MCP server read from the library config, keeping the user's links. */
export function mergeChannels(current: SunoChannel[], incoming: SunoChannel[]) {
  const byId = new Map(current.map((c) => [c.id, c]))
  for (const c of incoming) {
    const had = byId.get(c.id)
    byId.set(c.id, {
      ...c,
      ...had,
      folder: c.folder ?? had?.folder,
      // The config's project link wins once it has one (MediaMake's media CLI sets it).
      projectId: c.projectId ?? had?.projectId,
      projectName: c.projectId ? c.projectName ?? had?.projectName : had?.projectName
    })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** The channel for a Suno workspace, or by id or folder name. */
export function findChannel(prefs: SunoPrefs, by: { channel?: string; workspaceId?: string }) {
  const want = by.channel?.trim().toLowerCase()
  if (want) {
    const hit = prefs.channels.find((c) => c.id.toLowerCase() === want || c.folder?.toLowerCase() === want)
    if (hit) return hit
  }
  if (by.workspaceId) return prefs.channels.find((c) => c.workspaceId === by.workspaceId)
  return undefined
}

const squash = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
const words = (value: string) =>
  value
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2)

/**
 * How well a name (a Suno workspace's, a MediaMake project's) fits a channel,
 * by its id or folder: 3 the same name ("Inverted Devils" for inverteddevils),
 * 2 close ("anime zone" or "AnimeZone" for animemusiczone, "Omkaram" for
 * omkara), 0 not.
 */
export function channelNameScore(channel: Pick<SunoChannel, "id" | "folder">, name: string) {
  const target = squash(name)
  if (!target) return 0
  let score = 0
  for (const key of [channel.id, channel.folder ?? ""].map(squash).filter(Boolean)) {
    if (key === target) return 3
    const parts = words(name)
    const holds = key.length >= 4 && target.length >= 4 && (key.includes(target) || target.includes(key))
    if (holds || (parts.length >= 2 && parts.every((word) => key.includes(word)))) score = 2
  }
  return score
}

/** The option whose name clearly fits the channel best, if one does. */
export function suggestFor<T extends { name: string }>(channel: Pick<SunoChannel, "id" | "folder">, options: T[]) {
  const ranked = options
    .map((option) => ({ option, score: channelNameScore(channel, option.name) }))
    .filter((r) => r.score >= 2)
    .sort((a, b) => b.score - a.score)
  return ranked[0] && ranked[0].score !== ranked[1]?.score ? ranked[0].option : undefined
}

/** A folder name for a set of songs: the song's name without what Suno adds. */
export const songSet = (title: string) =>
  title
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+-\s+/)
    .slice(0, 2)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "songs"
