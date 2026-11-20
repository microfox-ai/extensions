// Readers for DistroKid's own pages. Each exported function runs inside a
// distrokid.com tab: chrome.scripting.executeScript sends it as source text,
// so it must not use anything from outside its own body. The album page's
// content script (Sync links) calls readDistrokidAlbum directly.

export type DistrokidStoreLink = { store: string; url: string }

export type DistrokidCredit = {
  /** DistroKid's category, e.g. Songwriter, Producer, Musician. */
  category: string
  /** The role shown, e.g. "Music and lyrics". */
  role: string
  names: string[]
}

export type DistrokidTrack = {
  number: number
  title: string
  isrc: string
  plainLyrics: string
  credits: DistrokidCredit[]
  /** The track's Download link (DistroKid Vault): the audio as uploaded. */
  audioUrl: string
  /** The file name and type DistroKid serves it under, when audio was asked for. */
  audioName: string
  audioType: string
}

export type DistrokidAlbum = {
  albumUuid: string
  distrokidLink: string
  title: string
  artist: string
  recordLabel: string
  /** As DistroKid prints them ("November 18, 2026") and as YYYY-MM-DD. */
  uploadDateText: string
  uploadDate: string
  releaseDateText: string
  releaseDate: string
  upc: string
  status: string
  aiTagged: boolean
  storeLinks: DistrokidStoreLink[]
  tracks: DistrokidTrack[]
  /** The largest cover DistroKid keeps (3000×3000 when it has one), and its size. */
  artworkUrl: string
  artworkSize: string
  warnings: string[]
}

export type DistrokidReleaseRow = {
  title: string
  artist: string
  /** "Single", "5 tracks"… */
  kind: string
  albumUuid: string
  url: string
}

/** Reads the album page this runs in (https://distrokid.com/dashboard/album/?albumuuid=…). */
export async function readDistrokidAlbum(
  options: { lyrics?: boolean; credits?: boolean; audio?: boolean; artwork?: boolean } = {}
): Promise<DistrokidAlbum> {
  const wantLyrics = options.lyrics !== false
  const wantCredits = options.credits !== false
  const wantAudio = options.audio === true
  const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim()
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const isoDate = (text: string) => {
    const match = /([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/.exec(text)
    if (!match) return ""
    const month = [
      "january",
      "february",
      "march",
      "april",
      "may",
      "june",
      "july",
      "august",
      "september",
      "october",
      "november",
      "december"
    ].indexOf(match[1].toLowerCase())
    if (month < 0) return ""
    return `${match[3]}-${String(month + 1).padStart(2, "0")}-${match[2].padStart(2, "0")}`
  }
  const warnings: string[] = []

  // The page draws its header and track list on load; the store icons can come a moment later.
  for (let i = 0; i < 40 && !document.querySelector(".album-title, .track-row"); i++) await sleep(250)
  for (let i = 0; i < 20 && !document.querySelector(".store-icons"); i++) await sleep(250)

  const albumUuid = new URL(location.href).searchParams.get("albumuuid") || ""
  const info: Record<string, string> = {}
  document.querySelectorAll(".release-info > div").forEach((row) => {
    const label = clean(row.querySelector("span:not(.info-value)")?.textContent).replace(/:$/, "")
    const value = clean(row.querySelector(".info-value")?.textContent)
    if (label) info[label.toLowerCase()] = value
  })
  // Fall back to the page's text when the header changes shape.
  const bodyText = document.body.innerText || ""
  const lineAfter = (label: string) => {
    const match = new RegExp(`${label}\\s*:?\\s*([^\\n]+)`, "i").exec(bodyText)
    return match ? clean(match[1]) : ""
  }
  const uploadDateText = info["upload date"] || lineAfter("Upload date")
  const releaseDateText = info["release date"] || lineAfter("Release date")
  const upc = (info["distrokid upc"] || lineAfter("DistroKid UPC")).replace(/[^\d]/g, "")
  const recordLabel = info["record label"] || lineAfter("Record Label")

  let title = clean(document.querySelector(".album-title")?.textContent)
  let artist = clean(document.querySelector(".band-name")?.textContent)
  if (!title || !artist) {
    // The tab title reads "Artist - Title - DistroKid".
    const parts = document.title.split(" - ")
    if (parts.length >= 3) {
      artist = artist || clean(parts[0])
      title = title || clean(parts.slice(1, -1).join(" - "))
    }
  }

  const storeLinks: DistrokidStoreLink[] = []
  document.querySelectorAll<HTMLAnchorElement>(".store-icons a[href]").forEach((link) => {
    const img = link.querySelector("img")
    const label = clean(img?.getAttribute("title") || img?.getAttribute("alt") || link.title)
    const store = label.replace(/^(submitted|delivered|live|sent)\s+(to|on)\s+/i, "") || new URL(link.href).hostname
    if (!/^https?:/i.test(link.href)) return
    if (!storeLinks.some((item) => item.store === store)) storeLinks.push({ store, url: link.href })
  })

  const status = clean(
    Array.from(document.querySelectorAll("p, div, span"))
      .map((el) => (el.childElementCount === 0 ? el.textContent || "" : ""))
      .find((text) => /successfully processed|being processed|delivered to stores|in review|rejected/i.test(text))
  )

  const fetchDoc = async (href: string) => {
    const response = await fetch(href, { credentials: "include" })
    if (!response.ok) throw new Error(`${response.status}`)
    return new DOMParser().parseFromString(await response.text(), "text/html")
  }

  const tracks: DistrokidTrack[] = []
  const rows = Array.from(document.querySelectorAll(".track-row"))
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const nameCell = row.querySelector(".track-name")
    const name = clean(
      Array.from(nameCell?.childNodes || [])
        .filter((node) => !(node instanceof HTMLElement && node.classList.contains("release-ai-tag")))
        .map((node) => node.textContent)
        .join(" ")
    )
    const number = Number(clean(row.querySelector(".track-num")?.textContent)) || index + 1
    const isrc = clean(row.querySelector(".isrc-value")?.textContent)
    const downloadLink = row.querySelector<HTMLAnchorElement>(".track-download a[href*='/vault/download']")
    const track: DistrokidTrack = {
      number,
      title: name,
      isrc,
      plainLyrics: "",
      credits: [],
      audioUrl: downloadLink?.href || "",
      audioName: "",
      audioType: ""
    }
    if (wantAudio && downloadLink) {
      // Only the headers: the file name and type DistroKid serves, then stop.
      const stop = new AbortController()
      try {
        const response = await fetch(downloadLink.href, { credentials: "include", signal: stop.signal })
        track.audioType = (response.headers.get("content-type") || "").split(";")[0].trim()
        const disposition = response.headers.get("content-disposition") || ""
        const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(disposition)
        const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(disposition)
        track.audioName = star ? decodeURIComponent(star[1]) : plain ? plain[1].trim() : ""
        if (/text\/html/i.test(track.audioType)) {
          warnings.push(`Track ${number}: Download opened a page, not the audio. Nothing was downloaded for it.`)
          track.audioUrl = ""
        }
      } catch (error) {
        warnings.push(`Track ${number}: could not reach its Download link (${String(error)}).`)
      } finally {
        stop.abort()
      }
    }

    const lyricsLink = row.querySelector<HTMLAnchorElement>(".track-lyrics a[href*='/lyrics/track']")
    if (wantLyrics && lyricsLink) {
      try {
        const doc = await fetchDoc(lyricsLink.href)
        const box = doc.getElementById("lu-lyrics-input") as HTMLTextAreaElement | null
        track.plainLyrics = (box?.value || box?.textContent || "").replace(/\r\n/g, "\n").trim()
      } catch (error) {
        warnings.push(`Track ${number}: could not read the lyrics page (${String(error)}).`)
      }
    }
    const creditsLink = row.querySelector<HTMLAnchorElement>(".track-credits a[href*='/credits/']")
    if (wantCredits && creditsLink) {
      try {
        const doc = await fetchDoc(creditsLink.href)
        doc.querySelectorAll("#creditsTable tr.creditRow").forEach((creditRow) => {
          const category =
            Array.from(creditRow.classList)
              .find((cls) => /^role\d+-/.test(cls))
              ?.replace(/^role\d+-/, "") || ""
          const role = clean(creditRow.querySelector(".creditColRole")?.textContent)
          const nameBox = creditRow.querySelector(".creditColName")?.cloneNode(true) as HTMLElement | undefined
          nameBox?.querySelectorAll(".creditReadMoreLink, .creditReadLessLink, input, select, script").forEach((el) => el.remove())
          const names = clean(nameBox?.textContent)
            .split(/\s*,\s*/)
            .filter(Boolean)
          if (role || names.length) track.credits.push({ category, role, names })
        })
      } catch (error) {
        warnings.push(`Track ${number}: could not read the credits page (${String(error)}).`)
      }
    }
    tracks.push(track)
  }
  if (!tracks.length) warnings.push("No tracks were found on this release page.")

  // The page shows an 800×800 cover on S3 ("800x800-<name>"). Beside it DistroKid
  // keeps the store copy ("3000x3000-<name>") and the cover without a size
  // prefix; take the largest that loads.
  let artworkUrl = ""
  let artworkSize = ""
  const shown = document.querySelector<HTMLImageElement>("img.album-image")
  const shownSrc = shown?.currentSrc || shown?.src || ""
  if (shownSrc) {
    artworkUrl = shownSrc
    artworkSize = shown?.naturalWidth ? `${shown.naturalWidth}x${shown.naturalHeight}` : ""
    if (options.artwork !== false) {
      const cut = shownSrc.lastIndexOf("/") + 1
      const folder = shownSrc.slice(0, cut)
      const file = decodeURIComponent(shownSrc.slice(cut))
      const bare = file.replace(/^\d+x\d+-/, "")
      const load = (url: string) =>
        new Promise<string>((resolve) => {
          const probe = new Image()
          const timer = setTimeout(() => resolve(""), 15_000)
          probe.onload = () => {
            clearTimeout(timer)
            resolve(`${probe.naturalWidth}x${probe.naturalHeight}`)
          }
          probe.onerror = () => {
            clearTimeout(timer)
            resolve("")
          }
          probe.src = url
        })
      for (const name of [`3000x3000-${bare}`, bare]) {
        if (name === file) continue
        const url = folder + encodeURIComponent(name)
        const size = await load(url)
        if (size && Number(size.split("x")[0]) > (Number(artworkSize.split("x")[0]) || 0)) {
          artworkUrl = url
          artworkSize = size
          break
        }
      }
    }
  } else {
    warnings.push("No cover art was found on this release page.")
  }

  return {
    albumUuid,
    distrokidLink: albumUuid
      ? `https://distrokid.com/dashboard/album/?albumuuid=${albumUuid}`
      : location.href,
    title,
    artist,
    recordLabel,
    uploadDateText,
    uploadDate: isoDate(uploadDateText),
    releaseDateText,
    releaseDate: isoDate(releaseDateText),
    upc,
    status,
    aiTagged: !!document.querySelector(".release-ai-badge, .release-section-has-ai"),
    storeLinks,
    tracks,
    artworkUrl,
    artworkSize,
    warnings
  }
}

/** Lists every release on My Music (https://distrokid.com/mymusic/), after "Show all releases". */
export async function readDistrokidReleases(): Promise<DistrokidReleaseRow[]> {
  const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim()
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  for (let i = 0; i < 40 && !document.querySelector("a.release-row"); i++) await sleep(250)

  // My Music shows a few releases and hides the rest behind "Show all releases".
  // Click it (and any later "more" button) until the list stops growing.
  const count = () => document.querySelectorAll("a.tableRow.release-row").length
  for (let round = 0; round < 30; round++) {
    const button = Array.from(document.querySelectorAll<HTMLElement>("#show-all-btn, button, a")).find(
      (el) =>
        /^(show all releases|show more|load more|see more)/i.test(clean(el.textContent)) &&
        (el as HTMLElement).offsetParent !== null
    )
    if (!button) break
    const before = count()
    const shownBefore = document.querySelectorAll("a.tableRow.release-row.release-row-show").length
    button.click()
    let grew = false
    for (let i = 0; i < 20; i++) {
      await sleep(250)
      const shown = document.querySelectorAll("a.tableRow.release-row.release-row-show").length
      if (count() > before || shown > shownBefore) {
        grew = true
        break
      }
    }
    if (!grew) break
  }

  const rows: DistrokidReleaseRow[] = []
  const seen = new Set<string>()
  document.querySelectorAll<HTMLAnchorElement>("a.tableRow.release-row[href*='albumuuid']").forEach((row) => {
    const url = new URL(row.getAttribute("href") || "", location.origin)
    const albumUuid = url.searchParams.get("albumuuid") || ""
    if (!albumUuid || seen.has(albumUuid)) return
    seen.add(albumUuid)
    const cell = row.querySelector(".item-title")
    const title = clean(cell?.querySelector(":scope > span")?.textContent)
    const kind = clean(cell?.querySelector(":scope > span > div")?.textContent)
    const artist = clean(cell?.querySelector(":scope > div")?.textContent)
    rows.push({
      title,
      artist,
      kind,
      albumUuid,
      url: `https://distrokid.com/dashboard/album/?albumuuid=${albumUuid}`
    })
  })
  return rows
}
