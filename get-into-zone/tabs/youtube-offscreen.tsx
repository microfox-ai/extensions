// Offscreen document for YouTube downloads. The service worker can't hold
// large buffers or create blob URLs, so streams are fetched and merged here.
import { ByteChunks, mergeAudioVideo } from "../lib/mp4Merge"

// YouTube throttles whole-file requests to playback speed; ranged requests aren't.
const CHUNK_SIZE = 10 * 1024 * 1024
const CONCURRENCY = 4
const RETRIES = 4
const MAX_RENEWALS = 3
const PROGRESS_INTERVAL_MS = 300

interface StartJob {
  id: string
  streams: { url: string; contentLength?: number }[]
  merge: boolean
}

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`YouTube returned ${status}.`)
  }
}

// Retrying the same URL after these never helps; it needs a fresh one.
const isRejected = (error: unknown) =>
  error instanceof HttpError && (error.status === 403 || error.status === 410)

const controllers = new Map<string, AbortController>()
const blobUrls = new Map<string, string>()

const send = (message: Record<string, unknown>) =>
  chrome.runtime.sendMessage(message).catch(() => {
    // The service worker restarts on the next message; nothing to do here.
  })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Stream URLs for a job, renewed through the service worker when YouTube
// starts rejecting them. Workers that fail together share one renewal.
class StreamLinks {
  urls: string[]
  generation = 0
  private renewals = 0
  private pending: Promise<void> | null = null

  constructor(private jobId: string, streams: StartJob["streams"]) {
    this.urls = streams.map((s) => s.url)
  }

  renew(failedGeneration: number) {
    if (failedGeneration !== this.generation) return Promise.resolve()
    this.pending ??= this.fetchFresh().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async fetchFresh() {
    if (this.renewals >= MAX_RENEWALS) {
      throw new Error(
        "YouTube keeps refusing this download (HTTP 403) even with renewed links. Try again in a few minutes."
      )
    }
    this.renewals++
    const response = await chrome.runtime
      .sendMessage({ action: "ytOffscreenRefresh", jobId: this.jobId })
      .catch(() => undefined)
    if (!response?.success || !Array.isArray(response.urls)) {
      throw new Error(
        `YouTube stopped serving this download (HTTP 403). ${
          response?.message || "Couldn't renew the download link."
        }`
      )
    }
    this.urls = response.urls
    this.generation++
  }
}

async function fetchInto(
  url: string,
  target: Uint8Array,
  signal: AbortSignal,
  onBytes: (delta: number) => void
) {
  const resp = await fetch(url, { signal, credentials: "omit" })
  if (!resp.ok || !resp.body) throw new HttpError(resp.status)
  const reader = resp.body.getReader()
  let got = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (got + value.length > target.length) throw new Error("Unexpected stream size.")
      target.set(value, got)
      got += value.length
      onBytes(value.length)
    }
    if (got !== target.length) throw new Error("The download ended early.")
  } catch (error) {
    onBytes(-got)
    throw error
  }
}

async function fetchRange(
  links: StreamLinks,
  index: number,
  start: number,
  end: number,
  signal: AbortSignal,
  onBytes: (delta: number) => void
) {
  const target = new Uint8Array(end - start + 1)
  for (let attempt = 1; ; ) {
    const generation = links.generation
    try {
      await fetchInto(`${links.urls[index]}&range=${start}-${end}`, target, signal, onBytes)
      return target
    } catch (error) {
      if (signal.aborted) throw error
      if (isRejected(error)) {
        await links.renew(generation)
        continue
      }
      if (attempt >= RETRIES) throw error
      await sleep(1000 * attempt++)
    }
  }
}

async function fetchWhole(
  links: StreamLinks,
  index: number,
  signal: AbortSignal,
  onBytes: (delta: number) => void
) {
  for (;;) {
    const generation = links.generation
    const resp = await fetch(links.urls[index], { signal, credentials: "omit" })
    if (!resp.ok || !resp.body) {
      const error = new HttpError(resp.status)
      if (!isRejected(error)) throw error
      await links.renew(generation)
      continue
    }
    const reader = resp.body.getReader()
    const chunks: Uint8Array[] = []
    let got = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return chunks
        chunks.push(value)
        got += value.length
        onBytes(value.length)
      }
    } catch (error) {
      onBytes(-got)
      throw error
    }
  }
}

async function fetchStream(
  links: StreamLinks,
  index: number,
  total: number | undefined,
  signal: AbortSignal,
  onBytes: (delta: number) => void
) {
  if (!total) return fetchWhole(links, index, signal, onBytes)

  const ranges: [number, number][] = []
  for (let start = 0; start < total; start += CHUNK_SIZE) {
    ranges.push([start, Math.min(start + CHUNK_SIZE, total) - 1])
  }
  const chunks: Uint8Array[] = new Array(ranges.length)
  let next = 0
  let failed = false
  const worker = async () => {
    while (next < ranges.length && !signal.aborted && !failed) {
      const rangeIndex = next++
      const [start, end] = ranges[rangeIndex]
      try {
        chunks[rangeIndex] = await fetchRange(links, index, start, end, signal, onBytes)
      } catch (error) {
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  return chunks
}

async function runJob(job: StartJob) {
  const controller = new AbortController()
  controllers.set(job.id, controller)
  const links = new StreamLinks(job.id, job.streams)
  const total = job.streams.reduce((n, s) => n + (s.contentLength ?? 0), 0)
  let received = 0
  let lastReport = 0
  const report = (force = false) => {
    const now = Date.now()
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return
    lastReport = now
    send({ action: "ytOffscreenProgress", jobId: job.id, received, total })
  }
  const onBytes = (delta: number) => {
    received += delta
    report()
  }

  try {
    const downloaded: Uint8Array[][] = []
    for (let index = 0; index < job.streams.length; index++) {
      downloaded.push(
        await fetchStream(
          links,
          index,
          job.streams[index].contentLength,
          controller.signal,
          onBytes
        )
      )
    }
    report(true)

    let parts: BlobPart[]
    if (job.merge) {
      send({ action: "ytOffscreenProgress", jobId: job.id, status: "merging" })
      parts = mergeAudioVideo(
        new ByteChunks(downloaded[0]),
        new ByteChunks(downloaded[1])
      )
    } else {
      parts = downloaded[0]
    }
    if (controller.signal.aborted) return

    // A media MIME type makes Chrome rewrite the extension (".m4a" becomes ".mp4").
    const blob = new Blob(parts, { type: "application/octet-stream" })
    const blobUrl = URL.createObjectURL(blob)
    blobUrls.set(job.id, blobUrl)
    send({ action: "ytOffscreenDone", jobId: job.id, blobUrl })
  } catch (error) {
    if (controller.signal.aborted) return
    controller.abort()
    send({
      action: "ytOffscreenError",
      jobId: job.id,
      message: error instanceof Error ? error.message : String(error)
    })
  } finally {
    controllers.delete(job.id)
  }
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request?.target !== "youtube-offscreen") return
  switch (request.action) {
    case "start":
      runJob(request.job as StartJob)
      break
    case "cancel":
      controllers.get(request.jobId)?.abort()
      break
    case "release": {
      const url = blobUrls.get(request.jobId)
      if (url) URL.revokeObjectURL(url)
      blobUrls.delete(request.jobId)
      break
    }
  }
  sendResponse({ ok: true, busy: controllers.size + blobUrls.size })
})

export default function YouTubeOffscreen() {
  return null
}
