import { useEffect, useState, type CSSProperties } from "react"

// The popup's Phrasly tab: what Browse Hack's humanizer runs with (Phrasly's
// own settings, read off its page on the first run), today's runs and Ultra
// documents, and whether Phrasly is asking for a captcha. Claude humanizes
// only when asked (phrasly_humanize); nothing here runs one.

const ask = (op: string) =>
  new Promise<any>((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "phrasly-ui", op }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else if (!response?.ok) reject(new Error(response?.error || "Browse Hack didn't answer."))
      else resolve(response.result)
    })
  })

const GREEN = "#16A34A"
const box: CSSProperties = { border: "1px solid #ddd", borderRadius: 6, padding: 10, marginBottom: 12 }
const small: CSSProperties = { fontSize: 12, color: "#555", lineHeight: 1.4 }
const button: CSSProperties = { padding: "3px 10px", fontSize: 12, border: "1px solid #ccc", borderRadius: 5, background: "#fff", cursor: "pointer" }
const primary: CSSProperties = { ...button, background: GREEN, borderColor: GREEN, color: "#fff" }
const row: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0", fontSize: 12, borderTop: "1px solid #eee" }
const warn: CSSProperties = { color: "#b45309", fontSize: 12, lineHeight: 1.4 }

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "")

export function PhraslyTab() {
  const [status, setStatus] = useState<any>(null)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  const load = () => ask("status").then(setStatus, (e) => setError(e.message))
  useEffect(() => {
    load()
  }, [])

  const act = async (op: string) => {
    setBusy(op)
    setError("")
    try {
      await ask(op)
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy("")
    }
  }

  const d = status?.defaults
  return (
    <div>
      <div style={box}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Phrasly humanizer</div>
        <div style={small}>
          Claude humanizes text with Phrasly only when you ask, in Browse Hack's own Phrasly tab (signed in as you), one job a
          minute. If Phrasly shows a captcha, that tab comes forward: complete it there and ask Claude to carry on.
        </div>
      </div>

      {status?.captcha ? (
        <div style={{ ...box, borderColor: "#f59e0b" }}>
          <div style={warn}>Phrasly is asking for a captcha: {status.captcha}</div>
          <button style={{ ...primary, marginTop: 6 }} disabled={!!busy} onClick={() => act("show")}>
            Show the Phrasly tab
          </button>
        </div>
      ) : null}

      <div style={box}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Settings every run uses</div>
        {d ? (
          <>
            <div style={row}>
              <span>Model</span>
              <b>{d.model ?? "?"}</b>
            </div>
            <div style={row}>
              <span>Mode</span>
              <b>{d.mode ?? "?"}</b>
            </div>
            <div style={row}>
              <span>Sentences</span>
              <b>{d.sentences ?? "?"}</b>
            </div>
            {d.other
              ? Object.entries(d.other as Record<string, boolean>).map(([name, on]) => (
                  <div style={row} key={name}>
                    <span>{name}</span>
                    <span>{on ? "on" : "off"}</span>
                  </div>
                ))
              : null}
            <div style={{ ...small, marginTop: 6 }}>Read off Phrasly's page {when(d.readAt)}. A run may override one for itself; the page's own settings are put back after it.</div>
          </>
        ) : (
          <div style={small}>Not read yet: the first run reads them off Phrasly's page.</div>
        )}
        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button style={primary} disabled={!!busy} onClick={() => act("refresh")}>
            {busy === "refresh" ? "Reading…" : "Read from Phrasly's page"}
          </button>
          <button style={button} disabled={!!busy} onClick={() => act("show")}>
            Show the tab
          </button>
        </div>
      </div>

      <div style={box}>
        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>Today</div>
        <div style={row}>
          <span>Runs (each draft counts)</span>
          <b>{status?.runsToday ?? "…"}</b>
        </div>
        <div style={row}>
          <span>Ultra documents</span>
          <b>
            {status?.ultraToday ?? "…"} / ~50
          </b>
        </div>
        {status?.warning ? <div style={{ ...warn, marginTop: 6 }}>{status.warning}</div> : null}
        {status?.job ? (
          <div style={{ ...small, marginTop: 6 }}>
            Running: {status.job.step} ({status.job.draftsDone}/{status.job.draftsWanted} drafts)
          </div>
        ) : status?.lastJob ? (
          <div style={{ ...small, marginTop: 6 }}>
            Last run {when(status.lastJob.at)}: {status.lastJob.draftsDone}/{status.lastJob.draftsWanted} drafts of {status.lastJob.words} words
            {status.lastJob.stoppedBy ? ` (stopped by ${status.lastJob.stoppedBy})` : ""}
          </div>
        ) : null}
      </div>

      {error ? <div style={{ ...warn, color: "#b91c1c" }}>{error}</div> : null}
    </div>
  )
}
