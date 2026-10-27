import type { PlasmoCSConfig } from "plasmo"

import {
  titleCaseSong,
  type DistrokidFillResult,
  type DistrokidRelease,
  type SongWriter
} from "../lib/distrokidRelease"

export const config: PlasmoCSConfig = {
  matches: ["https://distrokid.com/new*", "https://www.distrokid.com/new*"],
  run_at: "document_idle"
}

const CREDIT_LABEL: Record<SongWriter["credit"], string> = {
  music: "Music",
  lyrics: "Lyrics",
  "music and lyrics": "Music and lyrics"
}

const GENRE_LANGUAGE: Record<string, string> = {
  "K-Pop": "ko",
  "J-Pop": "ja",
  "French Pop": "fr",
  "German Pop": "de",
  "German Folk": "de"
}

type FileStart = { type: "file-start"; id: string; name: string; mime: string; total: number }
// Port messages are JSON, so an ArrayBuffer would arrive as {}. Chunks travel
// as base64 text and are decoded here.
type FileChunk = { type: "chunk"; id: string; index: number; base64: string }
type FillMsg = {
  type: "fill"
  release: DistrokidRelease
  trackIds: string[]
  coverId: string
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.action === "giz-distrokid-ping") {
    sendResponse({
      ok: true,
      ready: !!document.getElementById("artistName") && !!document.getElementById("doneButton")
    })
    return true
  }
  return false
})

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "giz-distrokid") return
  const bins = new Map<string, { name: string; mime: string; total: number; parts: Uint8Array[] }>()

  port.onMessage.addListener((msg: FileStart | FileChunk | FillMsg) => {
    if (msg.type === "file-start") {
      bins.set(msg.id, { name: msg.name, mime: msg.mime, total: msg.total, parts: [] })
      return
    }
    if (msg.type === "chunk") {
      const bin = bins.get(msg.id)
      if (bin && typeof msg.base64 === "string") bin.parts[msg.index] = base64ToBytes(msg.base64)
      return
    }
    if (msg.type === "fill") {
      const take = (id: string) => {
        const bin = bins.get(id)
        if (!bin || bin.parts.length !== bin.total || bin.parts.some((part) => !part)) {
          return null
        }
        return new File(bin.parts, safeName(bin.name), {
          type: bin.mime || guessMime(bin.name)
        })
      }
      const tracks = msg.trackIds.map(take)
      const cover = take(msg.coverId)
      void fillForm(msg.release, tracks, cover).then((result) => {
        port.postMessage({ type: "result", result })
      })
    }
  })
})

function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() || "file"
  if (base.length <= 160) return base
  const dot = base.lastIndexOf(".")
  const ext = dot > 0 ? base.slice(dot) : ""
  return base.slice(0, 160 - ext.length) + ext
}

function guessMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase()
  if (ext === "wav") return "audio/wav"
  if (ext === "mp3") return "audio/mpeg"
  if (ext === "m4a") return "audio/mp4"
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "png") return "image/png"
  if (ext === "gif") return "image/gif"
  return ""
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now()
  return new Promise((resolve) => {
    const timer = window.setInterval(() => {
      if (pred()) {
        window.clearInterval(timer)
        resolve(true)
      } else if (Date.now() - start > ms) {
        window.clearInterval(timer)
        resolve(false)
      }
    }, 50)
  })
}

function setNativeValue(
  el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string
) {
  const proto = Object.getPrototypeOf(el)
  const desc = Object.getOwnPropertyDescriptor(proto, "value")
  if (desc?.set) desc.set.call(el, value)
  else el.value = value
}

function writeText(el: HTMLInputElement | null, value: string) {
  if (!el) return false
  el.focus()
  setNativeValue(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("keyup", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  el.dispatchEvent(new FocusEvent("blur", { bubbles: true }))
  return true
}

function chooseSelect(select: HTMLSelectElement | null, label: string): boolean {
  if (!select || !label) return false
  const want = label.trim().toLowerCase()
  const option = Array.from(select.options).find((item) => {
    const text = item.text.replace(/\s+/g, " ").trim().toLowerCase()
    const data = (item.getAttribute("data-genre") || item.getAttribute("genre") || "")
      .trim()
      .toLowerCase()
    return text === want || data === want
  })
  if (!option || option.value === "") return false
  setNativeValue(select, option.value)
  select.dispatchEvent(new Event("input", { bubbles: true }))
  select.dispatchEvent(new Event("change", { bubbles: true }))
  select.dispatchEvent(new FocusEvent("blur", { bubbles: true }))
  return select.value === option.value
}

function setChecked(id: string, want: boolean): boolean {
  const el = document.getElementById(id) as HTMLInputElement | null
  if (!el) return false
  if (el.checked !== want) el.click()
  return el.checked === want
}

function inputLabel(input: HTMLInputElement): string {
  const bits: string[] = []
  if (input.id) {
    document.querySelectorAll(`label[for="${CSS.escape(input.id)}"]`).forEach((label) => {
      if (label.textContent) bits.push(label.textContent)
    })
  }
  const wrapping = input.closest("label")
  if (wrapping?.textContent) bits.push(wrapping.textContent)
  for (const sibling of [input.previousElementSibling, input.nextElementSibling]) {
    if (sibling && sibling.childElementCount === 0 && sibling.textContent) {
      bits.push(sibling.textContent)
    }
  }
  return bits.join(" ").replace(/\s+/g, " ").trim().toLowerCase()
}

function explicitPolarity(input: HTMLInputElement): "yes" | "no" | null {
  const idName = `${input.id} ${input.name} ${input.className}`.toLowerCase()
  const label = inputLabel(input)
  const blob = `${idName} ${label}`
  if (!blob.includes("explicit")) return null
  const value = input.value.trim().toLowerCase()
  const valueSaysYes = value === "1" || value === "yes" || value === "true"
  const idSaysNo = /not[-_\s]?explicit|non[-_\s]?explicit|no[-_\s]?explicit/.test(idName)
  const labelSaysNo = /not[-_\s]?explicit|does not|doesn't|\bno\b/.test(label)
  const valueSaysNo = value === "0" || value === "no" || value === "false"
  if ((idSaysNo || labelSaysNo || valueSaysNo) && !valueSaysYes) return "no"
  if (input.type === "checkbox") return "yes"
  if (
    value === "1" ||
    value === "yes" ||
    value === "true" ||
    /\byes\b/.test(label) ||
    /has explicit|explicit lyrics/.test(label)
  ) {
    return "yes"
  }
  return null
}

/** Explicit lyrics is a per-track checkbox, or a yes/no pair styled like the instrumental radios. */
function setExplicit(trackNum: number, want: boolean): boolean {
  const root = document.getElementById(`js-track-table-${trackNum}`) || document.body
  const direct = document.getElementById(
    want ? `js-explicit-radio-button-${trackNum}` : `js-not-explicit-radio-button-${trackNum}`
  ) as HTMLInputElement | null
  const tagged = Array.from(
    root.querySelectorAll<HTMLInputElement>("input[type='checkbox'], input[type='radio']")
  )
    .map((input) => ({ input, polarity: explicitPolarity(input) }))
    .filter((item): item is { input: HTMLInputElement; polarity: "yes" | "no" } => !!item.polarity)
  const choice =
    direct || tagged.find((item) => item.polarity === (want ? "yes" : "no"))?.input || null
  if (!choice) {
    const box = tagged.find((item) => item.input.type === "checkbox")?.input
    if (!box || want) return false
    if (box.checked) box.click()
    return box.checked === false
  }
  if (choice.type === "checkbox") {
    if (choice.checked !== want) choice.click()
    return choice.checked === want
  }
  if (!choice.checked) choice.click()
  return choice.checked
}

/** Shown after "not explicit". Picks clean-always, or the clean version of an explicit song. */
async function answerRadioEditQuestion(trackNum: number, radioEdit: boolean): Promise<boolean | null> {
  const root = document.getElementById(`js-track-table-${trackNum}`)
  if (!root) return null
  const appeared = await waitFor(() => {
    return Array.from(root.querySelectorAll("label, div, p, span, b, strong")).some((el) => {
      if (!visible(el as HTMLElement)) return false
      const text = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase()
      return text.length > 0 && text.length < 160 && /is this a ["']?radio edit/.test(text)
    })
  }, 200)
  if (!appeared) return null
  const target = Array.from(
    root.querySelectorAll<HTMLInputElement>("input[type='radio'], input[type='checkbox']")
  ).find((input) => {
    if (!visible(input)) return false
    if (input.id === `track-${trackNum}-version-radio-edit`) return false
    if (input.classList.contains("distroVersion")) return false
    const text = inputLabel(input)
    if (radioEdit) return /radio edit|censored|clean version|explicit version/.test(text) && !/always/.test(text)
    return /always/.test(text)
  })
  if (!target) return false
  if (!target.checked) target.click()
  return target.checked
}

function fillRecordLabel(label: string): boolean {
  const input = document.getElementById("recordLabel") as HTMLInputElement | null
  const named = document.querySelector(
    'input[name="recordLabelLabel"]'
  ) as HTMLInputElement | null
  const shown = input && input.type !== "hidden" && visible(input)
  if (shown && writeText(input, label)) {
    if (named) writeText(named, label)
    return true
  }
  if (named && writeText(named, label)) return true
  if (input && writeText(input, label)) return true
  return false
}

function visible(el: HTMLElement | null): boolean {
  let node: HTMLElement | null = el
  while (node) {
    const style = getComputedStyle(node)
    if (style.display === "none" || style.visibility === "hidden") return false
    node = node.parentElement
  }
  return !!el
}

function setFile(input: HTMLInputElement | null, file: File): boolean {
  if (!input) return false
  const transfer = new DataTransfer()
  transfer.items.add(file)
  input.files = transfer.files
  input.dispatchEvent(new Event("change", { bubbles: true }))
  return input.files?.[0]?.name === file.name
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function shown(selector: string): boolean {
  const el = document.querySelector(selector) as HTMLElement | null
  return !!el && getComputedStyle(el).display !== "none"
}

// DistroKid's own onchange handler reads the file, swaps in a data: preview,
// and checks the size. It shows .imageTooSmall/.imageTooBig/.imageNotSquare
// or clears the input when the image is bad.
async function attachCover(
  cover: File
): Promise<"preview" | "cleared" | "invalid" | "no-preview" | "missing"> {
  const artwork = document.getElementById("artwork") as HTMLInputElement | null
  if (!artwork) return "missing"
  const bad = () =>
    shown(".imageTooSmall") || shown(".imageTooBig") || shown(".imageNotSquare")
  const previewed = () => {
    const img = document.querySelector(".artworkVisible img.artworkPreview") as HTMLImageElement | null
    return !!img && img.src.startsWith("data:image")
  }
  setFile(artwork, cover)
  await waitFor(() => previewed() || bad() || !artwork.files?.length, 8000)
  await sleep(1000)
  if (bad()) return "invalid"
  if (!artwork.files?.length) return "cleared"
  return previewed() ? "preview" : "no-preview"
}

async function chooseSearchable(select: HTMLSelectElement | null, label: string) {
  if (!select || !label) return false
  const want = label.trim().toLowerCase()
  const option = Array.from(select.options).find(
    (item) =>
      item.value.trim().toLowerCase() === want ||
      item.text.replace(/\s+/g, " ").trim().toLowerCase() === want
  )
  if (!option || option.value === "" || option.value === "unselected") return false

  const widget = select.nextElementSibling as HTMLElement | null
  const choice = widget
    ? (Array.from(widget.querySelectorAll('[role="option"]')).find((item) => {
        const value = (item.getAttribute("data-value") || item.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase()
        return value === option.text.replace(/\s+/g, " ").trim().toLowerCase()
      }) as HTMLElement | undefined)
    : undefined
  choice?.click()
  setNativeValue(select, option.value)
  select.dispatchEvent(new Event("change", { bubbles: true }))
  select.dispatchEvent(new FocusEvent("blur", { bubbles: true }))
  const box = widget?.querySelector(
    "input.dk-searchable-select__input"
  ) as HTMLInputElement | null
  if (box) {
    setNativeValue(box, option.text.trim())
    box.dispatchEvent(new Event("input", { bubbles: true }))
  }
  await sleep(150)
  if (select.value !== option.value) setNativeValue(select, option.value)
  return select.value === option.value
}

async function fillWriters(trackNum: number, writers: SongWriter[], warnings: string[]) {
  const root = document.getElementById(`js-track-table-${trackNum}`) || document.body
  for (let i = 0; i < writers.length; i++) {
    const count = () =>
      root.querySelectorAll(`.songwriter_real_name_first[tracknum="${trackNum}"]`).length
    if (count() <= i) {
      const add = document.getElementById(`js-add-another-songwriter-link-${trackNum}`)
      ;(add as HTMLElement | null)?.click()
      const grew = await waitFor(() => count() > i)
      if (!grew) {
        warnings.push(`Could not add songwriter ${i + 1} on track ${trackNum}.`)
        return
      }
    }
    const firsts = root.querySelectorAll(
      `.songwriter_real_name_first[tracknum="${trackNum}"]`
    )
    const first = firsts[i] as HTMLInputElement | undefined
    const block = first?.closest(".songwriter_red_name_block_sub, .songwriter_row")
    const writer = writers[i]
    const role = block?.querySelector(
      "select.songwriter_real_name_role"
    ) as HTMLSelectElement | null
    if (!chooseSelect(role, CREDIT_LABEL[writer.credit])) {
      warnings.push(`Track ${trackNum} songwriter ${i + 1}: credit was not set.`)
    }
    writeText(first || null, writer.firstName)
    writeText(
      (block?.querySelector(".songwriter_real_name_middle") as HTMLInputElement | null) ||
        null,
      writer.middleName
    )
    writeText(
      (block?.querySelector(".songwriter_real_name_last") as HTMLInputElement | null) ||
        null,
      writer.lastName
    )
  }
}

function setVersion(trackNum: number, version: string) {
  if (!version.trim()) {
    document.getElementById(`track-${trackNum}-version-no`)?.click()
    return
  }
  if (version.trim().toLowerCase() === "radio edit") {
    document.getElementById(`track-${trackNum}-version-radio-edit`)?.click()
    return
  }
  const root = document.getElementById(`js-track-table-${trackNum}`)
  const other = root?.querySelector(
    'input.distroVersion[value="Other..."]'
  ) as HTMLInputElement | null
  other?.click()
  const input = root?.querySelector(
    `.versionInput${trackNum}Other, .versionInput${trackNum}`
  ) as HTMLInputElement | null
  writeText(input, version.trim())
}

function trackTitle(release: DistrokidRelease, file: File, index: number): string {
  if (index === 0) return titleCaseSong(release.songTitle)
  const stem = (file.name.split(/[/\\]/).pop() || file.name).replace(/\.[^.]+$/, "")
  return titleCaseSong(stem)
}

async function fillForm(
  release: DistrokidRelease,
  tracks: (File | null)[],
  cover: File | null
): Promise<DistrokidFillResult> {
  const warnings: string[] = []
  const filled: string[] = []
  if (!document.getElementById("artistName") || !document.getElementById("doneButton")) {
    return {
      ok: false,
      message:
        "DistroKid's upload form is not on this page. Open https://distrokid.com/new/ while logged in, then fill again.",
      warnings,
      filled
    }
  }

  const audio = tracks.filter((file): file is File => !!file)
  if (audio.length === 0 || tracks.some((file) => !file)) {
    return {
      ok: false,
      message: "The audio file did not reach the page. Choose the folder and try again.",
      warnings,
      filled
    }
  }
  if (!cover) {
    return {
      ok: false,
      message: "The album cover did not reach the page. Choose the folder and try again.",
      warnings,
      filled
    }
  }
  if (audio.length > 35) {
    return {
      ok: false,
      message: "DistroKid's form stops at 35 songs. This folder has more audio files.",
      warnings,
      filled
    }
  }

  const songCount = document.getElementById(
    "howManySongsOnThisAlbum"
  ) as HTMLSelectElement | null
  if (songCount && songCount.value !== String(audio.length)) {
    setNativeValue(songCount, String(audio.length))
    songCount.dispatchEvent(new Event("change", { bubbles: true }))
    const ready = await waitFor(
      () => !!document.getElementById(`js-track-upload-${audio.length}`)
    )
    if (!ready) warnings.push("The extra track rows did not appear. Check the song count.")
    else filled.push(`${audio.length} songs`)
  }

  const artist = document.getElementById("artistName") as HTMLInputElement | null
  if (writeText(artist, release.artist)) filled.push(`Artist ${release.artist}`)
  else warnings.push("Artist field was not found.")
  await sleep(400)
  const compound = document.querySelector(".compoundBandname") as HTMLElement | null
  if (compound && visible(compound)) {
    const band = document.getElementById(
      "js-non-compound-band-name-radio"
    ) as HTMLInputElement | null
    if (band && !band.checked) band.click()
    warnings.push(
      "DistroKid asked if this artist name is a band or a collaboration. It is marked as a band name. Change that on the page if it is a collaboration."
    )
  }

  const date = document.getElementById("release-date-dp") as HTMLInputElement | null
  if (date && visible(date)) {
    writeText(date, release.releaseDate)
    filled.push(`Release date ${release.releaseDate}`)
    const min = date.min
    const max = date.max
    if ((min && release.releaseDate < min) || (max && release.releaseDate > max)) {
      warnings.push(
        `Release date ${release.releaseDate} is outside the dates DistroKid is offering (${min || "any"} to ${max || "any"}). The field was still filled. Change it on the page if the store rejects it.`
      )
    }
  } else {
    warnings.push("Release date field is hidden on this plan. Set it on the page if you can.")
  }

  const primary = document.getElementById("genrePrimary") as HTMLSelectElement | null
  if (chooseSelect(primary, release.primaryGenre)) filled.push(release.primaryGenre)
  else warnings.push(`Primary genre "${release.primaryGenre}" was not selected.`)

  if (release.primaryGenre === "Electronic") {
    await waitFor(() => {
      const sub = document.getElementById("subGenrePrimary") as HTMLSelectElement | null
      return !!sub && sub.options.length > 1 && visible(sub)
    })
    const sub = document.getElementById("subGenrePrimary") as HTMLSelectElement | null
    if (chooseSelect(sub, release.electronicSubGenre)) filled.push(release.electronicSubGenre)
    else warnings.push(`Electronic subgenre "${release.electronicSubGenre}" was not selected.`)
  }

  if (release.secondaryGenre) {
    const secondary = document.getElementById("genreSecondary") as HTMLSelectElement | null
    if (chooseSelect(secondary, release.secondaryGenre)) filled.push(release.secondaryGenre)
    else warnings.push(`Secondary genre "${release.secondaryGenre}" was not selected.`)
    if (release.secondaryGenre === "Electronic") {
      await waitFor(() => {
        const sub = document.getElementById("subGenreSecondary") as HTMLSelectElement | null
        return !!sub && sub.options.length > 1
      })
      const sub = document.getElementById("subGenreSecondary") as HTMLSelectElement | null
      if (!chooseSelect(sub, release.electronicSubGenre)) {
        warnings.push("Secondary electronic subgenre was not selected.")
      }
    }
  }

  const primaryLang = GENRE_LANGUAGE[release.primaryGenre]
  const secondaryLang = GENRE_LANGUAGE[release.secondaryGenre]
  if (primaryLang && secondaryLang && primaryLang !== secondaryLang) {
    warnings.push(
      "Primary and secondary genres need different store languages. The primary genre's language was used."
    )
  }
  const requiredLang = primaryLang || secondaryLang
  if (requiredLang) {
    const language = document.getElementById("language") as HTMLSelectElement | null
    const option = language
      ? Array.from(language.options).find((item) => item.getAttribute("data-lang") === requiredLang)
      : undefined
    if (language && option) {
      setNativeValue(language, option.value)
      language.dispatchEvent(new Event("change", { bubbles: true }))
      filled.push(`Language ${option.text.trim()}`)
    }
  }

  if (release.primaryGenre === "Soundtrack" && !/soundtrack/i.test(`${release.songTitle} ${release.version}`)) {
    warnings.push(
      'Soundtrack releases need the type in parentheses, for example version "Original Motion Picture Soundtrack".'
    )
  }
  if (release.primaryGenre === "Classical") {
    warnings.push(
      "Classical is not delivered to Apple Music, and DistroKid also wants a composer on each track. Add the composer on the page."
    )
  }

  if (fillRecordLabel(release.recordLabel)) filled.push(`Record label ${release.recordLabel}`)
  else {
    warnings.push(
      "Record label field was not on the page. DistroKid only shows it on Musician Plus and Ultimate, and otherwise assigns its own label name."
    )
  }

  const appleOn = setChecked("chkapplemusic", release.isApplePublish)
  const itunesOn = setChecked("chkitunes", release.isApplePublish)
  if (appleOn && itunesOn) {
    filled.push(release.isApplePublish ? "Apple Music and iTunes on" : "Apple Music and iTunes off")
  } else {
    warnings.push("Apple Music or iTunes checkbox was not found.")
  }

  if (audio.length > 1) {
    warnings.push(
      "Extra audio files were added as more tracks. They share the songwriters and Apple credits. The version text is only on track 1. Edit the other tracks before you continue."
    )
    const shown = await waitFor(() => {
      const box = document.getElementById("albumTitle")
      return !!box && visible(box)
    })
    const album = document.getElementById("albumTitleInput") as HTMLInputElement | null
    if (shown && writeText(album, titleCaseSong(release.songTitle))) {
      filled.push("Album title from the song title")
    } else {
      warnings.push("Album title field did not appear. Set it before you continue.")
    }
  }

  for (let i = 0; i < audio.length; i++) {
    const n = i + 1
    const title = document.querySelector(
      `#js-track-table-${n} input.uploadFileTitle`
    ) as HTMLInputElement | null
    const titled = trackTitle(release, audio[i], i)
    if (writeText(title, titled)) filled.push(`Track ${n}: ${titled}`)
    else warnings.push(`Track ${n} title field was not found.`)
    setVersion(n, i === 0 ? release.version : "")
    if (i === 0 && release.version) filled.push(`Version (${release.version})`)
    await fillWriters(n, release.songWriters, warnings)
    const instrumentalId = release.instrumental
      ? `js-instrumental-radio-button-${n}`
      : `js-not-instrumental-radio-button-${n}`
    document.getElementById(instrumentalId)?.click()
    if (release.instrumental && release.isExplicit) {
      warnings.push(
        `Track ${n} is instrumental and explicit. Explicit lyrics was still checked. Change it on the page if this song has no lyric.`
      )
    }
    if (setExplicit(n, release.isExplicit)) {
      if (n === 1) filled.push(release.isExplicit ? "Explicit lyrics" : "Not explicit")
    } else {
      warnings.push(`Track ${n} explicit lyrics control was not found.`)
    }
    if (!release.isExplicit) {
      const clean = await answerRadioEditQuestion(
        n,
        release.version.trim().toLowerCase() === "radio edit"
      )
      if (clean === false) {
        warnings.push(
          `Track ${n} still needs the "Is this a radio edit?" answer. Set it on the page before you continue.`
        )
      }
    }
    const audioInput = document.getElementById(
      `js-track-upload-${n}`
    ) as HTMLInputElement | null
    if (setFile(audioInput, audio[i])) filled.push(audio[i].name)
    else warnings.push(`Track ${n} audio was not attached.`)
  }

  if (release.isApplePublish) {
    const creditsReady = await waitFor(
      () => !!document.getElementById("track-1-performer-1-role")
    )
    if (!creditsReady) {
      warnings.push("Apple performer and producer fields did not appear.")
    }
    for (let i = 0; i < audio.length; i++) {
      const n = i + 1
      const role = document.getElementById(
        `track-${n}-performer-1-role`
      ) as HTMLSelectElement | null
      const name = document.getElementById(
        `track-${n}-performer-1-name`
      ) as HTMLInputElement | null
      if (!(await chooseSearchable(role, release.creditPerformerRole))) {
        warnings.push(`Track ${n} performer role "${release.creditPerformerRole}" was not selected.`)
      }
      writeText(name, release.creditPerformerName)
      const producerRole = document.getElementById(
        `track-${n}-producer-1-role`
      ) as HTMLSelectElement | null
      const producerName = document.getElementById(
        `track-${n}-producer-1-name`
      ) as HTMLInputElement | null
      if (!(await chooseSearchable(producerRole, release.creditProducer))) {
        warnings.push(`Track ${n} producer role "${release.creditProducer}" was not selected.`)
      }
      writeText(producerName, release.creditProducerName)
    }
    if (creditsReady) filled.push("Apple performer and producer")
  }

  await sleep(200)
  const checks: string[] = []
  document.querySelectorAll<HTMLInputElement>("input.areyousure").forEach((box) => {
    if (!visible(box)) return
    if (!box.checked) box.click()
    box.dispatchEvent(new FocusEvent("blur", { bubbles: true }))
    checks.push(box.id)
  })
  if (checks.length) filled.push(`${checks.length} important checkboxes`)

  // DistroKid resets the cover input if the file arrives while the rest of the
  // form is still being filled. Pause, then attach it once the page is quiet.
  await sleep(2000)
  const coverState = await attachCover(cover)
  if (coverState === "preview") filled.push(`Cover ${cover.name}`)
  else if (coverState === "invalid") {
    const width = document.querySelector(".clientSideImageWidth")?.textContent?.trim()
    const height = document.querySelector(".clientSideImageHeight")?.textContent?.trim()
    warnings.push(
      width && height
        ? `DistroKid rejected the album cover (${width}×${height}). Use a square JPG, PNG, or GIF between 1000 and 5000 pixels.`
        : "DistroKid rejected the album cover. Use a square JPG, PNG, or GIF between 1000 and 5000 pixels."
    )
  } else if (coverState === "cleared") {
    warnings.push(
      "DistroKid rejected the album cover. Use a square JPG, PNG, or GIF between 1000 and 5000 pixels."
    )
  } else if (coverState === "missing") {
    warnings.push("Album cover field was not on the page.")
  } else {
    warnings.push(
      "The cover file is on the form, but DistroKid did not preview it. Reload this tab and fill again. If the cover box is still empty, drag the image onto it."
    )
  }

  const note = document.createElement("div")
  note.id = "giz-distrokid-banner"
  note.style.cssText =
    "margin:16px 0;padding:14px 16px;border-radius:8px;background:#ecfdf5;border:1px solid #6ee7b7;color:#064e3b;line-height:1.45;font-size:14px;"
  const warningHtml =
    warnings.length > 0
      ? `<ul style="margin:8px 0 0;padding-left:18px;">${warnings
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("")}</ul>`
      : ""
  note.innerHTML = `<strong>Browse Hack filled this form.</strong> Review it, then click Continue yourself. Nothing was submitted.${warningHtml}`
  document.getElementById("giz-distrokid-banner")?.remove()
  const button = document.getElementById("doneButton")
  button?.parentElement?.insertBefore(note, button)
  button?.scrollIntoView({ block: "center", behavior: "smooth" })

  return {
    ok: true,
    message: warnings.length
      ? "Form filled with some items still to check. Click Continue yourself when it looks right."
      : "Form filled. Review the page, then click Continue yourself. Nothing was submitted.",
    warnings,
    filled
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}
