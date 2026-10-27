import { useEffect, useRef, useState } from "react"

import "./midjourney-edit.css"

type Phase = "loading" | "ready" | "submitting" | "done" | "error"

const sessionId = new URLSearchParams(location.search).get("session") ?? ""

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Couldn't show the image."))
    image.src = src
  })
}

function canvasPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Couldn't export the image."))),
      "image/png"
    )
  })
}

function maskHasPaint(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")
  if (!ctx || !canvas.width) return false
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] > 20) return true
  }
  return false
}

export default function MidjourneyEdit() {
  const imageRef = useRef<HTMLCanvasElement>(null)
  const maskRef = useRef<HTMLCanvasElement>(null)
  const undoRef = useRef<ImageData[]>([])
  const brushRef = useRef(48)
  const restoreRef = useRef(false)
  const [prompt, setPrompt] = useState("")
  const [brush, setBrush] = useState(48)
  const [restore, setRestore] = useState(false)
  const [hasPaint, setHasPaint] = useState(false)
  const [phase, setPhase] = useState<Phase>(sessionId ? "loading" : "error")
  const [message, setMessage] = useState(sessionId ? "" : "This edit tab is missing its session.")
  const [error, setError] = useState("")
  const [cursor, setCursor] = useState({ x: 0, y: 0, d: 0, on: false })
  brushRef.current = brush
  restoreRef.current = restore

  useEffect(() => {
    document.title = "Repaint — Browse Hack"
  }, [])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    chrome.runtime
      .sendMessage({ action: "midjourneyEdit.get", sessionId })
      .then(async (response) => {
        if (cancelled) return
        if (!response?.ok) throw new Error(response?.error || "Couldn't open this edit.")
        const image = await loadImage(`data:image/png;base64,${response.imageBase64}`)
        const base = imageRef.current
        const mask = maskRef.current
        if (!base || !mask) return
        base.width = image.width
        base.height = image.height
        mask.width = image.width
        mask.height = image.height
        base.getContext("2d")!.drawImage(image, 0, 0)
        setPrompt(String(response.prompt || ""))
        setPhase("ready")
      })
      .catch((reason) => {
        if (cancelled) return
        setMessage(reason instanceof Error ? reason.message : String(reason))
        setPhase("error")
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const mask = maskRef.current
    if (phase !== "ready" || !mask) return
    const ctx = mask.getContext("2d")
    if (!ctx) return
    ctx.lineCap = "round"
    ctx.lineJoin = "round"

    let drawing = false
    let lastX = 0
    let lastY = 0

    const point = (event: PointerEvent) => {
      const rect = mask.getBoundingClientRect()
      return {
        x: ((event.clientX - rect.left) / rect.width) * mask.width,
        y: ((event.clientY - rect.top) / rect.height) * mask.height,
        css: (brushRef.current * rect.width) / mask.width
      }
    }

    const stamp = (x: number, y: number) => {
      ctx.globalCompositeOperation = restoreRef.current ? "destination-out" : "source-over"
      ctx.fillStyle = "#ff3b30"
      ctx.beginPath()
      ctx.arc(x, y, brushRef.current / 2, 0, Math.PI * 2)
      ctx.fill()
    }

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      event.preventDefault()
      const snapshot = ctx.getImageData(0, 0, mask.width, mask.height)
      undoRef.current.push(snapshot)
      if (undoRef.current.length > 8) undoRef.current.shift()
      drawing = true
      mask.setPointerCapture(event.pointerId)
      const p = point(event)
      lastX = p.x
      lastY = p.y
      stamp(p.x, p.y)
      setCursor({ x: event.clientX, y: event.clientY, d: p.css, on: true })
    }

    const onMove = (event: PointerEvent) => {
      const p = point(event)
      setCursor({ x: event.clientX, y: event.clientY, d: p.css, on: true })
      if (!drawing) return
      ctx.globalCompositeOperation = restoreRef.current ? "destination-out" : "source-over"
      ctx.strokeStyle = "#ff3b30"
      ctx.lineWidth = brushRef.current
      ctx.beginPath()
      ctx.moveTo(lastX, lastY)
      ctx.lineTo(p.x, p.y)
      ctx.stroke()
      lastX = p.x
      lastY = p.y
    }

    const onUp = () => {
      if (!drawing) return
      drawing = false
      setHasPaint(maskHasPaint(mask))
    }

    const onLeave = () => setCursor((current) => ({ ...current, on: false }))

    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault()
        const previous = undoRef.current.pop()
        if (!previous) return
        ctx.putImageData(previous, 0, 0)
        setHasPaint(maskHasPaint(mask))
      } else if (event.key === "[") {
        setBrush((size) => Math.max(8, size - 8))
      } else if (event.key === "]") {
        setBrush((size) => Math.min(240, size + 8))
      } else if (event.key.toLowerCase() === "e") {
        setRestore(true)
      } else if (event.key.toLowerCase() === "b") {
        setRestore(false)
      }
    }

    mask.addEventListener("pointerdown", onDown)
    mask.addEventListener("pointermove", onMove)
    mask.addEventListener("pointerup", onUp)
    mask.addEventListener("pointercancel", onUp)
    mask.addEventListener("pointerleave", onLeave)
    window.addEventListener("keydown", onKey)
    return () => {
      mask.removeEventListener("pointerdown", onDown)
      mask.removeEventListener("pointermove", onMove)
      mask.removeEventListener("pointerup", onUp)
      mask.removeEventListener("pointercancel", onUp)
      mask.removeEventListener("pointerleave", onLeave)
      window.removeEventListener("keydown", onKey)
    }
  }, [phase])

  const undo = () => {
    const mask = maskRef.current
    const ctx = mask?.getContext("2d")
    const previous = undoRef.current.pop()
    if (!mask || !ctx || !previous) return
    ctx.putImageData(previous, 0, 0)
    setHasPaint(maskHasPaint(mask))
  }

  const clear = () => {
    const mask = maskRef.current
    const ctx = mask?.getContext("2d")
    if (!mask || !ctx || !maskHasPaint(mask)) return
    undoRef.current.push(ctx.getImageData(0, 0, mask.width, mask.height))
    if (undoRef.current.length > 8) undoRef.current.shift()
    ctx.clearRect(0, 0, mask.width, mask.height)
    setHasPaint(false)
  }

  const submit = async () => {
    const image = imageRef.current
    const mask = maskRef.current
    if (!image || !mask || phase !== "ready") return
    if (!prompt.trim()) {
      setError("Describe what the finished image should show.")
      return
    }
    if (!maskHasPaint(mask)) {
      setError("Brush the parts to change before clicking Repaint.")
      return
    }
    setError("")
    setPhase("submitting")
    try {
      const out = document.createElement("canvas")
      out.width = image.width
      out.height = image.height
      const ctx = out.getContext("2d")!
      ctx.drawImage(image, 0, 0)
      ctx.globalCompositeOperation = "destination-out"
      ctx.drawImage(mask, 0, 0)
      const png = await canvasPng(out)
      const response = await chrome.runtime.sendMessage({
        action: "midjourneyEdit.submit",
        sessionId,
        prompt: prompt.trim(),
        pngBase64: await blobToBase64(png)
      })
      if (!response?.ok) {
        if (response?.retryable) {
          setError(response.error || "Midjourney didn't start the edit.")
          setPhase("ready")
          return
        }
        setMessage(response?.error || "Midjourney didn't start the edit.")
        setPhase("error")
        return
      }
      setPhase("done")
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase("ready")
    }
  }

  const cancel = () => {
    void chrome.runtime.sendMessage({ action: "midjourneyEdit.cancel", sessionId })
    window.close()
  }

  const editing = phase === "ready" || phase === "submitting"

  return (
    <div className="page">
      {phase === "loading" && (
        <div className="message">
          <h1>Opening the image</h1>
          <p>The brush will be ready in a moment.</p>
        </div>
      )}
      {phase === "error" && (
        <div className="message">
          <h1>Couldn't edit this image</h1>
          <p>{message}</p>
        </div>
      )}
      {phase === "done" && (
        <div className="message">
          <h1>Sent to Midjourney</h1>
          <p>It's repainting the brushed parts. You can close this tab. The results show up in the chat.</p>
        </div>
      )}
      <div className="stage" hidden={!editing}>
        <div className="frame">
          <canvas ref={imageRef} className="base" />
          <canvas
            ref={maskRef}
            className="mask"
            onContextMenu={(event) => event.preventDefault()}
          />
        </div>
      </div>
      {cursor.on && phase === "ready" && (
        <div
          className="cursor"
          style={{
            left: cursor.x - cursor.d / 2,
            top: cursor.y - cursor.d / 2,
            width: cursor.d,
            height: cursor.d
          }}
        />
      )}
      <div className="bar" hidden={!editing}>
        <p className="hint">
          Brush what should change. Red is repainted; everything else stays. Restore paints the original back.
        </p>
        <textarea
          value={prompt}
          disabled={phase === "submitting"}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What the finished image should show"
          aria-label="Prompt"
        />
        {error && <p className="error">{error}</p>}
        <div className="row">
          <button
            type="button"
            className={restore ? "" : "active"}
            disabled={phase === "submitting"}
            onClick={() => setRestore(false)}>
            Brush
          </button>
          <button
            type="button"
            className={restore ? "active" : ""}
            disabled={phase === "submitting"}
            onClick={() => setRestore(true)}>
            Restore
          </button>
          <label className="brush">
            Size
            <input
              type="range"
              min={8}
              max={240}
              value={brush}
              disabled={phase === "submitting"}
              onChange={(event) => setBrush(Number(event.target.value))}
            />
          </label>
          <button type="button" disabled={phase === "submitting"} onClick={undo}>
            Undo
          </button>
          <button type="button" disabled={phase === "submitting"} onClick={clear}>
            Clear
          </button>
          <button type="button" disabled={phase === "submitting"} onClick={cancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            disabled={phase === "submitting" || !hasPaint}
            onClick={() => void submit()}>
            {phase === "submitting" ? "Sending…" : "Repaint"}
          </button>
        </div>
      </div>
    </div>
  )
}
