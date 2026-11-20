// DistroKid song details, in the background worker: reads release pages in a
// background tab (closed when done), adds the primary genre from Apple Music,
// saves one JSON per song under Downloads/DistroKid/<artist>/, and syncs the
// store links to the MediaMake Library records linked to a release.

import { downloadFile } from "./downloads"
import { downloadFinished, saveJsonFile } from "./libraryFiles"
import { mediamakeFetch } from "./mediamake"
import {
  readDistrokidAlbum,
  readDistrokidReleases,
  type DistrokidAlbum,
  type DistrokidCredit,
  type DistrokidReleaseRow,
  type DistrokidStoreLink
} from "./distrokidPage"
import { waitForTabLoad } from "./tabs"

export const DETAILS_JOB_KEY = "distrokidDetailsJob"
export const UPLOADS_KEY = "distrokidUploads"

export type DistrokidSong = {
  title: string
  artist: string
  release: string
  trackNumber: number
  trackCount: number
  distrokidUpc: string
  releaseDate: string
  uploadDate: string
  recordLabel: string
  isrc: string
  links: { spotify: string; appleMusic: string; itunes: string; amazon: string }
  /** Every store link in Delivered to. */
  storeLinks: DistrokidStoreLink[]
  plainLyrics: string
  credits: DistrokidCredit[]
  /** Where the song's audio (DistroKid's Download) was saved, when it was downloaded. */
  audioFile: string
  distrokidLink: string
  albumUuid: string
  /** Apple Music's primary genre for the release (iTunes lookup). */
  primaryGenre: string
  status: string
  aiTagged: boolean
  fetchedAt: string
}

export type DetailsJob = {
  running: boolean
  label: string
  done: number
  total: number
  current: string
  saved: string[]
  errors: string[]
  startedAt: number
  finishedAt?: number
}

export type DistrokidUpload = {
  /** The release folder the MCP filled the form from, when it was filled that way. */
  folder: string
  title: string
  artist: string
  albumUuid: string
  at: number
}

const MY_MUSIC = "https://distrokid.com/mymusic/"

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function albumUuidOf(input: string): string {
  const text = String(input || "").trim()
  try {
    const fromUrl = new URL(text).searchParams.get("albumuuid")
    if (fromUrl) return fromUrl
  } catch {
    // not a URL
  }
  return /^[0-9A-F-]{20,}$/i.test(text) ? text : ""
}

// --- Reading pages in a tab of our own -------------------------------------------------

/** One background tab, reused for every page of a run, closed at the end. */
class WorkerTab {
  private tabId: number | null = null

  async open(url: string) {
    if (this.tabId == null) {
      const tab = await chrome.tabs.create({ url, active: false })
      this.tabId = tab.id ?? null
      if (this.tabId == null) throw new Error("Chrome did not open a DistroKid tab.")
    } else {
      await chrome.tabs.update(this.tabId, { url })
    }
    // Let the navigation start before waiting for it to finish.
    await new Promise((resolve) => setTimeout(resolve, 300))
    const tab = await waitForTabLoad(this.tabId, 45_000)
    if (/\/(signin|login)/i.test(tab.url || "")) {
      throw new Error("DistroKid asked to sign in. Sign in at https://distrokid.com in this Chrome profile, then try again.")
    }
    return this.tabId
  }

  async run<T>(func: (...args: any[]) => Promise<T>, args: unknown[] = []): Promise<T> {
    if (this.tabId == null) throw new Error("No DistroKid tab is open.")
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: this.tabId },
      func: func as any,
      args: args as any[]
    })
    return injection?.result as T
  }

  async close() {
    if (this.tabId == null) return
    const id = this.tabId
    this.tabId = null
    await chrome.tabs.remove(id).catch(() => {})
  }
}

async function readAlbumIn(
  tab: WorkerTab,
  albumUuid: string,
  options: { lyrics?: boolean; credits?: boolean; audio?: boolean } = {}
) {
  await tab.open(`https://distrokid.com/dashboard/album/?albumuuid=${albumUuid}`)
  const album = await tab.run(readDistrokidAlbum, [options])
  if (!album || (!album.title && !album.tracks?.length)) {
    throw new Error(`DistroKid did not show release ${albumUuid}. Is it in this account?`)
  }
  return album
}

/** Every release on My Music, read in a background tab that is closed again. */
export async function listDistrokidReleases(artist?: string): Promise<DistrokidReleaseRow[]> {
  const tab = new WorkerTab()
  try {
    await tab.open(MY_MUSIC)
    const rows = (await tab.run(readDistrokidReleases)) || []
    return artist ? rows.filter((row) => sameName(row.artist, artist)) : rows
  } finally {
    await tab.close()
  }
}

export function sameName(a: string, b: string) {
  const norm = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  return norm(a) === norm(b)
}

// --- Apple Music genre -------------------------------------------------------------------

/** The primary genre Apple gives the release, from its Apple Music or iTunes link. */
export async function appleGenre(links: DistrokidStoreLink[]): Promise<string> {
  for (const link of links) {
    let url: URL
    try {
      url = new URL(link.url)
    } catch {
      continue
    }
    if (!/(^|\.)apple\.com$/.test(url.hostname)) continue
    const trackId = url.searchParams.get("i")
    const id = trackId || url.pathname.split("/").filter(Boolean).pop() || ""
    if (!/^\d+$/.test(id)) continue
    const country = url.pathname.split("/").filter(Boolean)[0] || "us"
    try {
      const response = await fetch(
        `https://itunes.apple.com/lookup?id=${id}&country=${encodeURIComponent(country)}`
      )
      const data = await response.json()
      const genre = data?.results?.[0]?.primaryGenreName
      if (genre) return String(genre)
    } catch {
      // Try the next Apple link.
    }
  }
  return ""
}

// --- Songs from a release ------------------------------------------------------------------

function storeLink(links: DistrokidStoreLink[], test: RegExp) {
  return links.find((link) => test.test(link.store))?.url || ""
}

export function songsOf(album: DistrokidAlbum, primaryGenre: string): DistrokidSong[] {
  const fetchedAt = new Date().toISOString()
  const links = {
    spotify: storeLink(album.storeLinks, /spotify/i),
    appleMusic: storeLink(album.storeLinks, /apple\s*music/i),
    itunes: storeLink(album.storeLinks, /itunes/i),
    amazon: storeLink(album.storeLinks, /amazon/i)
  }
  return album.tracks.map((track) => ({
    title: track.title || album.title,
    artist: album.artist,
    release: album.title,
    trackNumber: track.number,
    trackCount: album.tracks.length,
    distrokidUpc: album.upc,
    releaseDate: album.releaseDate || album.releaseDateText,
    uploadDate: album.uploadDate || album.uploadDateText,
    recordLabel: album.recordLabel,
    isrc: track.isrc,
    links,
    storeLinks: album.storeLinks,
    plainLyrics: track.plainLyrics,
    credits: track.credits,
    audioFile: "",
    distrokidLink: album.distrokidLink,
    albumUuid: album.albumUuid,
    primaryGenre,
    status: album.status,
    aiTagged: album.aiTagged,
    fetchedAt
  }))
}

const safePart = (value: string) =>
  (value || "Untitled")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120) || "Untitled"

function songName(song: DistrokidSong) {
  const name = song.trackCount > 1 ? `${song.release} - ${String(song.trackNumber).padStart(2, "0")} ${song.title}` : song.title
  return `DistroKid/${safePart(song.artist)}/${safePart(name)}`
}

async function saveSong(song: DistrokidSong) {
  return saveJsonFile(`${songName(song)}.json`, JSON.stringify(song, null, 2))
}

const AUDIO_EXT: Record<string, string> = {
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/vnd.wave": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aiff": "aiff",
  "audio/x-aiff": "aiff"
}

/** Saves the track's audio from DistroKid's Download link, beside its JSON. */
async function saveAudio(song: DistrokidSong, url: string, served: { name: string; type: string }) {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(served.name)?.[1]?.toLowerCase()
  const ext = AUDIO_EXT[served.type.toLowerCase()] || fromName || "wav"
  const id = await downloadFile({
    url,
    filename: `${songName(song)}.${ext}`,
    conflictAction: "overwrite",
    saveAs: false
  })
  return downloadFinished(id)
}

// --- A details run: one release or a whole artist ----------------------------------------

async function setJob(job: DetailsJob) {
  await chrome.storage.session.set({ [DETAILS_JOB_KEY]: job }).catch(() => {})
}

export async function detailsJob(): Promise<DetailsJob | null> {
  const value = await chrome.storage.session.get(DETAILS_JOB_KEY).catch(() => ({}) as Record<string, any>)
  return (value as Record<string, any>)[DETAILS_JOB_KEY] ?? null
}

let running = false

export type DetailsRequest = {
  /** A release page URL or its albumuuid: that release only. */
  album?: string
  /** All releases of this artist (as My Music names it). */
  artist?: string
  /** Every release on My Music. */
  all?: boolean
  lyrics?: boolean
  credits?: boolean
  genre?: boolean
  /** Also download each song's audio with DistroKid's Download button (default true). */
  audio?: boolean
  /** Save one JSON per song in Downloads/DistroKid/<artist>/ (default true). */
  save?: boolean
}

/**
 * Reads the releases asked for and returns their songs. The tab it reads them
 * in is closed at the end, also when a release fails.
 */
export async function distrokidSongDetails(request: DetailsRequest) {
  if (running) throw new Error("Browse Hack is already downloading DistroKid song details. Wait for it to finish.")
  running = true
  const save = request.save !== false
  const job: DetailsJob = {
    running: true,
    label: "",
    done: 0,
    total: 0,
    current: "Reading DistroKid…",
    saved: [],
    errors: [],
    startedAt: Date.now()
  }
  const tab = new WorkerTab()
  const songs: DistrokidSong[] = []
  try {
    let targets: { albumUuid: string; title: string }[]
    const single = albumUuidOf(request.album || "")
    if (request.album && !single) throw new Error("That is not a DistroKid release link (it needs ?albumuuid=…).")
    if (single) {
      targets = [{ albumUuid: single, title: "" }]
      job.label = "this release"
    } else {
      if (!request.artist && !request.all) throw new Error("Name a release (album), an artist, or all.")
      job.label = request.artist ? `${request.artist}'s releases` : "every release"
      job.current = "Reading My Music…"
      await setJob(job)
      await tab.open(MY_MUSIC)
      const rows = (await tab.run(readDistrokidReleases)) || []
      const picked = request.artist ? rows.filter((row) => sameName(row.artist, request.artist!)) : rows
      if (!picked.length) {
        const artists = [...new Set(rows.map((row) => row.artist))].join(", ")
        throw new Error(
          request.artist
            ? `No releases by "${request.artist}" on My Music. Artists there: ${artists || "none"}.`
            : "My Music has no releases."
        )
      }
      targets = picked.map((row) => ({ albumUuid: row.albumUuid, title: row.title }))
    }
    job.total = targets.length
    await setJob(job)

    for (const target of targets) {
      job.current = target.title || "Reading the release…"
      await setJob(job)
      try {
        const album = await readAlbumIn(tab, target.albumUuid, {
          lyrics: request.lyrics !== false,
          credits: request.credits !== false,
          audio: save && request.audio !== false
        })
        const genre = request.genre === false ? "" : await appleGenre(album.storeLinks)
        const found = songsOf(album, genre)
        for (const warning of album.warnings) job.errors.push(`${album.title}: ${warning}`)
        for (let index = 0; index < found.length; index++) {
          const song = found[index]
          const track = album.tracks[index]
          songs.push(song)
          if (save && request.audio !== false && track?.audioUrl) {
            job.current = `Downloading ${song.title}…`
            await setJob(job)
            try {
              song.audioFile = await saveAudio(song, track.audioUrl, {
                name: track.audioName,
                type: track.audioType
              })
              job.saved.push(song.audioFile)
            } catch (error) {
              job.errors.push(`${song.title}: the audio download failed (${message(error)}).`)
            }
          } else if (save && request.audio !== false) {
            job.errors.push(`${song.title}: no Download link on DistroKid, so no audio.`)
          }
          if (save) {
            try {
              job.saved.push(await saveSong(song))
            } catch (error) {
              job.errors.push(`${song.title}: could not save (${message(error)}).`)
            }
          }
        }
      } catch (error) {
        job.errors.push(`${target.title || target.albumUuid}: ${message(error)}`)
      }
      job.done += 1
      await setJob(job)
    }
    return { songs, saved: job.saved, errors: job.errors }
  } catch (error) {
    job.errors.push(message(error))
    throw error
  } finally {
    await tab.close()
    running = false
    job.running = false
    job.current = ""
    job.finishedAt = Date.now()
    await setJob(job)
  }
}

/** Details of one release without saving files, for the pack record and Sync links. */
export async function readRelease(albumUuid: string, options: { lyrics?: boolean; credits?: boolean } = {}) {
  const tab = new WorkerTab()
  try {
    return await readAlbumIn(tab, albumUuid, options)
  } finally {
    await tab.close()
  }
}

// --- Releases uploaded from a pack --------------------------------------------------------

export async function recordUpload(upload: Omit<DistrokidUpload, "at">) {
  const value = await chrome.storage.local.get(UPLOADS_KEY)
  const list: DistrokidUpload[] = Array.isArray(value[UPLOADS_KEY]) ? value[UPLOADS_KEY] : []
  const next = [{ ...upload, at: Date.now() }, ...list.filter((item) => !(item.folder && item.folder === upload.folder))]
  await chrome.storage.local.set({ [UPLOADS_KEY]: next.slice(0, 200) })
}

export async function listUploads(): Promise<DistrokidUpload[]> {
  const value = await chrome.storage.local.get(UPLOADS_KEY)
  return Array.isArray(value[UPLOADS_KEY]) ? value[UPLOADS_KEY] : []
}

// --- MediaMake Library records linked to a release ------------------------------------------

export type LinkedRecord = { spaceId: string; space: string; ref: string; title: string }

/**
 * Songs records whose `distrokid` group (its `link`) or a `link` field names
 * this release. Searched over every space the MediaMake account can open.
 */
export async function linkedRecords(albumUuid: string): Promise<LinkedRecord[]> {
  if (!albumUuid) return []
  const found = new Map<string, LinkedRecord>()
  for (const field of ["distrokid", "link"]) {
    const query = new URLSearchParams({ collection: "songs", limit: "20" })
    query.append("where", `${field}=${albumUuid}`)
    let data: any
    try {
      data = await mediamakeFetch(`/api/library/entries?${query}`)
    } catch (error) {
      // A field the template doesn't know, or no Library for this account: no links.
      if (field === "link") continue
      throw error
    }
    for (const hit of Array.isArray(data?.results) ? data.results : []) {
      const spaceId = String(hit?.spaceId || "")
      const ref = String(hit?.ref || "")
      if (!spaceId || !ref) continue
      found.set(`${spaceId}:${ref}`, {
        spaceId,
        space: String(hit?.space || ""),
        ref,
        title: String(hit?.card?.title || hit?.title || ref.split("/").pop() || ref)
      })
    }
  }
  return [...found.values()]
}

const PLATFORM: [RegExp, string][] = [
  [/spotify/i, "Spotify"],
  [/apple\s*music/i, "Apple Music"],
  [/itunes/i, "iTunes"],
  [/amazon/i, "Amazon Music"],
  [/youtube/i, "YouTube Music"],
  [/deezer/i, "Deezer"],
  [/tidal/i, "Tidal"]
]

function platformOf(store: string) {
  return PLATFORM.find(([test]) => test.test(store))?.[1] || store
}

/** What the record's distrokid group says about the release. */
export function distrokidGroup(album: DistrokidAlbum) {
  const group: Record<string, string> = {
    link: album.distrokidLink,
    albumUuid: album.albumUuid,
    upc: album.upc,
    uploadDate: album.uploadDate || album.uploadDateText,
    releaseDate: album.releaseDate || album.releaseDateText,
    recordLabel: album.recordLabel
  }
  return Object.fromEntries(Object.entries(group).filter(([, value]) => value))
}

/** Writes the release's store links (and its DistroKid details) to each linked record. */
export async function syncLinks(album: DistrokidAlbum) {
  const records = await linkedRecords(album.albumUuid)
  if (!records.length) throw new Error("No MediaMake Library record is linked to this release.")
  const storeLinks: Record<string, string> = {}
  for (const link of album.storeLinks) storeLinks[platformOf(link.store)] = link.url
  const results: { ref: string; space: string; ok: boolean; message: string }[] = []
  for (const record of records) {
    try {
      const query = new URLSearchParams({ space: record.spaceId, ref: record.ref })
      const current = await mediamakeFetch(`/api/library/entries?${query}`)
      const fields = current?.fields || current?.entry?.fields || {}
      const before = fields.distrokid && typeof fields.distrokid === "object" ? fields.distrokid : {}
      const patch: Record<string, unknown> = {
        distrokid: { ...before, ...distrokidGroup(album) }
      }
      if (Object.keys(storeLinks).length) patch.storeLinks = storeLinks
      // The ISRC only when the record has none and the track is clear.
      const track =
        album.tracks.length === 1
          ? album.tracks[0]
          : album.tracks.find((item) => sameName(item.title, String(fields.title || record.title)))
      if (!fields.isrc && track?.isrc) patch.isrc = track.isrc
      if (!fields.releaseDate && album.releaseDate) patch.releaseDate = album.releaseDate
      const [collection, slug] = record.ref.split("/")
      await mediamakeFetch("/api/library/entries", {
        method: "POST",
        body: JSON.stringify({ space: record.spaceId, collection, slug, fields: patch, agent: true })
      })
      results.push({
        ref: record.ref,
        space: record.space,
        ok: true,
        message: `${Object.keys(storeLinks).length} store link${Object.keys(storeLinks).length === 1 ? "" : "s"} saved`
      })
    } catch (error) {
      results.push({ ref: record.ref, space: record.space, ok: false, message: message(error) })
    }
  }
  return results
}
