import { useRef, useState, type CSSProperties } from "react"

import {
  findInfoJson,
  findLyricsFile,
  isCoverCandidate,
  isIgnoredReleaseFile,
  pickAudioTracks,
  readInfoFile,
  type DistrokidFillResult,
  type DistrokidRelease
} from "../lib/distrokidRelease"

type Loaded = {
  folder: string
  release: DistrokidRelease
  errors: string[]
  tracks: File[]
  audioNote: string
  cover: File | null
  coverNote: string
  lyricsName: string | null
}

const CHUNK = 512 * 1024

export function DistroKidTab() {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState("")
  const [result, setResult] = useState<DistrokidFillResult | null>(null)

  const chooseFolder = () => {
    const input = inputRef.current
    if (!input) return
    input.value = ""
    input.click()
  }

  const onFolder = async (files: FileList | null) => {
    setResult(null)
    setStatus("")
    if (!files || files.length === 0) return
    const list = Array.from(files).filter((file) => !isIgnoredReleaseFile(file))
    const folder =
      (list[0]?.webkitRelativePath || "").split(/[/\\]/)[0] || "Release folder"
    const infoFile = findInfoJson(list)
    if (!infoFile) {
      setLoaded({
        folder,
        release: blankRelease(),
        errors: ["This folder has no info.json."],
        tracks: [],
        audioNote: "",
        cover: null,
        coverNote: "",
        lyricsName: findLyricsFile(list)?.name || null
      })
      return
    }
    const parsed = await readInfoFile(infoFile)
    const audio = pickAudioTracks(list)
    const images = list.filter(isCoverCandidate)
    const sized = await Promise.all(
      images.map(async (file) => {
        try {
          const bitmap = await createImageBitmap(file)
          const size = { file, w: bitmap.width, h: bitmap.height }
          bitmap.close()
          return size
        } catch {
          return { file, w: 0, h: 0 }
        }
      })
    )
    const coverPick = pickCover(sized)
    const errors = [...parsed.errors]
    if (audio.tracks.length === 0) errors.push(audio.note)
    if (!coverPick.cover) errors.push(coverPick.note)
    if (coverPick.cover && fileExt(coverPick.cover.name) === ".webp") {
      errors.push("DistroKid accepts JPG, PNG, or GIF covers. Export this image out of WebP.")
    }
    setLoaded({
      folder,
      release: parsed.release,
      errors,
      tracks: audio.tracks,
      audioNote: audio.note,
      cover: coverPick.cover,
      coverNote: coverPick.note,
      lyricsName: findLyricsFile(list)?.name || null
    })
  }

  const fill = async () => {
    if (!loaded || loaded.errors.length || !loaded.cover) return
    setBusy(true)
    setResult(null)
    setStatus("Looking for the DistroKid upload tab…")
    try {
      const tab = await findOrOpenUploadTab()
      if (!tab?.id) {
        setStatus("Could not open https://distrokid.com/new/.")
        return
      }
      setStatus("Connecting to the upload page…")
      const ready = await waitForPage(tab.id)
      if (!ready) {
        setStatus(
          "The upload form is not ready. Log in, open https://distrokid.com/new/, refresh that tab, then click Fill again."
        )
        return
      }
      const outcome = await sendFill(tab.id, loaded, setStatus)
      setResult(outcome)
      setStatus(outcome.message)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Fill failed.")
    } finally {
      setBusy(false)
    }
  }

  const blocked = !loaded || loaded.errors.length > 0 || !loaded.cover || busy

  return (
    <div>
      <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>DistroKid</h2>
      <p style={{ margin: "0 0 12px", fontSize: 12, lineHeight: 1.45, color: "#444" }}>
        Choose the release folder. The form at distrokid.com/new is filled from
        info.json, the audio, and the square cover. You click Continue yourself.
      </p>
      <input
        ref={(node) => {
          inputRef.current = node
          node?.setAttribute("webkitdirectory", "")
          node?.setAttribute("directory", "")
        }}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) => void onFolder(event.target.files)}
      />
      <button onClick={chooseFolder} style={buttonStyle("#E0E0E0", "#111")} type="button">
        {loaded ? "Choose a different folder" : "Choose release folder"}
      </button>

      {loaded && (
        <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.45 }}>
          <div style={{ fontWeight: 700 }}>{loaded.folder}</div>
          {loaded.release.songTitle && (
            <div>
              {loaded.release.songTitle}
              {loaded.release.version ? ` (${loaded.release.version})` : ""} —{" "}
              {loaded.release.artist}
            </div>
          )}
          {loaded.release.primaryGenre && (
            <div>
              {loaded.release.primaryGenre}
              {loaded.release.electronicSubGenre
                ? ` / ${loaded.release.electronicSubGenre}`
                : ""}
              {loaded.release.secondaryGenre ? ` · ${loaded.release.secondaryGenre}` : ""}
            </div>
          )}
          <div>{loaded.audioNote}</div>
          {loaded.tracks.map((file) => (
            <div key={file.name}>Audio: {file.name}</div>
          ))}
          <div>Cover: {loaded.coverNote}</div>
          {loaded.lyricsName && <div>Lyrics file (not uploaded): {loaded.lyricsName}</div>}
          {loaded.errors.length > 0 && (
            <ul style={{ color: "#9f1239", paddingLeft: 18, margin: "8px 0" }}>
              {loaded.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={() => void fill()}
            disabled={blocked}
            style={{
              ...buttonStyle(blocked ? "#E0E0E0" : "#0073C7", blocked ? "#666" : "#fff"),
              marginTop: 8
            }}>
            {busy ? "Filling…" : "Fill DistroKid form"}
          </button>
        </div>
      )}

      {status && <p style={{ marginTop: 10, fontSize: 12, lineHeight: 1.45 }}>{status}</p>}
      {result && (
        <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.45 }}>
          {result.filled.length > 0 && (
            <ul style={{ paddingLeft: 18, margin: "4px 0" }}>
              {result.filled.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          {result.warnings.length > 0 && (
            <ul style={{ color: "#9a3412", paddingLeft: 18, margin: "4px 0" }}>
              {result.warnings.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function buttonStyle(background: string, color: string): CSSProperties {
  return {
    width: "100%",
    padding: "10px",
    border: "none",
    borderRadius: 6,
    background,
    color,
    cursor: "pointer",
    fontSize: 13
  }
}

function fileExt(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

function blankRelease(): DistrokidRelease {
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

function pickCover(images: { file: File; w: number; h: number }[]): {
  cover: File | null
  note: string
} {
  if (images.length === 0) {
    return { cover: null, note: "No JPG, PNG, or GIF in this folder." }
  }
  const squares = images.filter((image) => image.w > 0 && image.w === image.h)
  if (squares.length === 0) {
    const listed = images
      .map((image) => `${image.file.name} (${image.w || "?"}×${image.h || "?"})`)
      .join(", ")
    return {
      cover: null,
      note: `No square image. DistroKid needs a square cover. Found ${listed}.`
    }
  }
  const valid = squares.filter((image) => image.w >= 1000 && image.w <= 5000)
  const pool = (valid.length ? valid : squares).slice().sort(
    (a, b) => Math.abs(a.w - 3000) - Math.abs(b.w - 3000)
  )
  const chosen = pool[0]
  let note = `${chosen.file.name} (${chosen.w}×${chosen.h})`
  if (chosen.w < 1000 || chosen.w > 5000) {
    note += ". DistroKid wants 1000–5000 px, so this cover may be rejected."
  }
  if (squares.length > 1) note += `. ${squares.length} square images; using the one closest to 3000 px.`
  return { cover: chosen.file, note }
}

async function findOrOpenUploadTab(): Promise<chrome.tabs.Tab | undefined> {
  const open = await chrome.tabs.query({
    url: ["https://distrokid.com/new*", "https://www.distrokid.com/new*"]
  })
  const active = open.find((tab) => tab.active) || open[0]
  if (active?.id) return active
  const created = await chrome.tabs.create({ url: "https://distrokid.com/new/" })
  if (!created.id || created.status === "complete") return created
  await new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener)
      resolve()
    }, 20000)
    const listener = (tabId: number, info: chrome.tabs.TabChangeInfo) => {
      if (tabId === created.id && info.status === "complete") {
        window.clearTimeout(timer)
        chrome.tabs.onUpdated.removeListener(listener)
        resolve()
      }
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
  return created
}

function ping(tabId: number): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: "giz-distrokid-ping" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok || !response?.ready) {
        resolve(false)
        return
      }
      resolve(true)
    })
  })
}

async function waitForPage(tabId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 24; attempt++) {
    if (await ping(tabId)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

function sendFill(
  tabId: number,
  loaded: Loaded,
  onStatus: (text: string) => void
): Promise<DistrokidFillResult> {
  const cover = loaded.cover
  if (!cover) {
    return Promise.resolve({
      ok: false,
      message: "Choose a folder with a square cover first.",
      warnings: [],
      filled: []
    })
  }
  return new Promise((resolve, reject) => {
    const port = chrome.tabs.connect(tabId, { name: "giz-distrokid" })
    let settled = false
    const finish = (done: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      done()
    }
    const timer = window.setTimeout(() => {
      finish(() => {
        port.disconnect()
        reject(new Error("DistroKid took too long to respond. Refresh the upload tab and try again."))
      })
    }, 90000)
    port.onMessage.addListener((msg) => {
      if (msg?.type === "result" && msg.result) {
        finish(() => resolve(msg.result as DistrokidFillResult))
      }
    })
    port.onDisconnect.addListener(() => {
      finish(() =>
        reject(
          new Error(
            "Lost the DistroKid tab. Refresh https://distrokid.com/new/ and click Fill again."
          )
        )
      )
    })
    void (async () => {
      const trackIds = loaded.tracks.map((_, index) => `track-${index}`)
      for (let index = 0; index < loaded.tracks.length; index++) {
        onStatus(`Sending ${loaded.tracks[index].name}…`)
        await postFile(port, trackIds[index], loaded.tracks[index])
      }
      onStatus(`Sending ${cover.name}…`)
      await postFile(port, "cover", cover)
      onStatus("Filling the form…")
      port.postMessage({
        type: "fill",
        release: loaded.release,
        trackIds,
        coverId: "cover"
      })
    })().catch((error) => {
      finish(() =>
        reject(error instanceof Error ? error : new Error("Could not send the files."))
      )
    })
  })
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

// Port messages are JSON, so an ArrayBuffer would arrive as {}. Send base64.
async function postFile(port: chrome.runtime.Port, id: string, file: File) {
  const buffer = await file.arrayBuffer()
  const total = Math.max(1, Math.ceil(buffer.byteLength / CHUNK))
  port.postMessage({
    type: "file-start",
    id,
    name: file.name,
    mime: file.type,
    total: buffer.byteLength === 0 ? 0 : total
  })
  for (let index = 0; index < total && buffer.byteLength > 0; index++) {
    port.postMessage({
      type: "chunk",
      id,
      index,
      base64: bytesToBase64(
        new Uint8Array(buffer, index * CHUNK, Math.min(CHUNK, buffer.byteLength - index * CHUNK))
      )
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
