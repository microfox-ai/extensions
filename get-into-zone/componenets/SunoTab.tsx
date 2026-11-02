import { useEffect, useState, type CSSProperties } from "react"

import type { SunoAccount, SunoWorkspace } from "../lib/suno/clip"
import {
  DEFAULT_SUNO_PREFS,
  SUNO_PREFS_KEY,
  loadSunoPrefs,
  readSunoPrefs,
  saveSunoPrefs,
  type SunoChannel,
  type SunoPrefs
} from "../lib/sunoPrefs"

// The popup's Suno tab: links each MediaMake channel to the Suno workspace its
// songs are made in and the MediaMake project they're recorded under, and holds
// the download settings. The upload-terms switch lives only here: Claude can't
// turn it on.

type Project = { id: string; name: string }

const ask = (op: string) =>
  new Promise<any>((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "suno-ui", op }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else if (!response?.ok) reject(new Error(response?.error || "Browse Hack didn't answer."))
      else resolve(response.result)
    })
  })

const box: CSSProperties = { border: "1px solid #ddd", borderRadius: 6, padding: 10, marginBottom: 12 }
const small: CSSProperties = { fontSize: 12, color: "#555", lineHeight: 1.4 }
const select: CSSProperties = { width: "100%", padding: 4, fontSize: 12 }

export function SunoTab() {
  const [prefs, setPrefs] = useState<SunoPrefs>(DEFAULT_SUNO_PREFS)
  const [account, setAccount] = useState<SunoAccount | null>(null)
  const [workspaces, setWorkspaces] = useState<SunoWorkspace[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [status, setStatus] = useState("Checking Suno…")
  const [newChannel, setNewChannel] = useState("")

  useEffect(() => {
    loadSunoPrefs().then(setPrefs)
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[SUNO_PREFS_KEY]) setPrefs(readSunoPrefs(changes[SUNO_PREFS_KEY].newValue))
    }
    chrome.storage.onChanged.addListener(onChange)
    ask("status")
      .then((s) => {
        setAccount(s.account)
        setStatus("")
      })
      .catch((error) => setStatus(error.message))
    ask("workspaces").then(setWorkspaces).catch(() => {})
    ask("projects").then(setProjects).catch(() => {})
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [])

  const update = async (patch: Partial<SunoPrefs>) => setPrefs(await saveSunoPrefs(patch))
  const updateChannel = (id: string, patch: Partial<SunoChannel>) =>
    update({ channels: prefs.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)) })

  const addChannel = () => {
    const id = newChannel.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "")
    if (!id || prefs.channels.some((c) => c.id === id)) return
    update({ channels: [...prefs.channels, { id }] })
    setNewChannel("")
  }

  return (
    <div style={{ fontSize: 13 }}>
      <div style={box}>
        <strong>Suno</strong>
        {account ? (
          <div style={small}>
            {account.plan ?? "Signed in"} · {account.creditsLeft ?? "?"} credits left
            {account.downloads ? ` · ${account.downloads.left} of ${account.downloads.limit} downloads left this month` : ""}
          </div>
        ) : (
          <div style={small}>{status}</div>
        )}
        <div style={{ ...small, marginTop: 6 }}>
          On suno.com, hover a song for <b>Copy for Claude</b>, <b>Variations</b> and <b>Save</b>; the Create form gets a bar
          to pick the channel, save a preset or press Create several times. Claude uses the same through the suno_ tools.
        </div>
      </div>

      <div style={box}>
        <strong>Channels</strong>
        <div style={small}>Each MediaMake channel: the Suno workspace its songs are made in, and the MediaMake project they're recorded under.</div>
        {prefs.channels.length === 0 && (
          <div style={{ ...small, marginTop: 6 }}>No channels yet. Claude adds them from MediaMake's library when it uses Suno, or add one here.</div>
        )}
        {prefs.channels.map((c) => (
          <div key={c.id} style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 600 }}>
              {c.id}
              {c.folder && c.folder !== c.id ? <span style={{ fontWeight: 400, color: "#777" }}> ({c.folder})</span> : null}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 3 }}>
              <select
                style={select}
                value={c.workspaceId ?? ""}
                onChange={(e) =>
                  updateChannel(c.id, {
                    workspaceId: e.target.value || undefined,
                    workspaceName: workspaces.find((w) => w.id === e.target.value)?.name
                  })
                }>
                <option value="">Suno workspace…</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <select
                style={select}
                value={c.projectId ?? ""}
                onChange={(e) =>
                  updateChannel(c.id, {
                    projectId: e.target.value || undefined,
                    projectName: projects.find((p) => p.id === e.target.value)?.name
                  })
                }>
                <option value="">MediaMake project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input
            value={newChannel}
            onChange={(e) => setNewChannel(e.target.value)}
            placeholder="channel id, e.g. animemusiczone"
            style={{ flex: 1, padding: 4, fontSize: 12 }}
          />
          <button onClick={addChannel} style={{ padding: "4px 10px", fontSize: 12 }}>
            Add
          </button>
        </div>
      </div>

      <div style={box}>
        <strong>Saving songs</strong>
        <div style={{ ...small, marginTop: 4 }}>
          Saved songs go to <code>{prefs.inboxFolder}/suno/&lt;channel&gt;/&lt;song&gt;/</code> in Downloads, with a
          .source.json beside each for MediaMake's <code>media ingest</code>. Each one uses a Suno download.
        </div>
        <div style={{ marginTop: 6 }}>
          Format:{" "}
          {(["mp3", "wav"] as const).map((format) => (
            <label key={format} style={{ marginRight: 10 }}>
              <input type="radio" checked={prefs.downloadFormat === format} onChange={() => update({ downloadFormat: format })} />{" "}
              {format.toUpperCase()}
            </label>
          ))}
        </div>
        <label style={{ display: "block", marginTop: 6 }}>
          <input type="checkbox" checked={prefs.routeDownloads} onChange={(e) => update({ routeDownloads: e.target.checked })} /> Also file
          songs I download myself on suno.com into the library inbox
        </label>
      </div>

      <div style={box}>
        <strong>Covers of your own tracks</strong>
        <label style={{ display: "block", marginTop: 6 }}>
          <input type="checkbox" checked={prefs.allowUploadTerms} onChange={(e) => update({ allowUploadTerms: e.target.checked })} /> I own or
          license the audio I cover: let Browse Hack accept Suno's upload terms for me
        </label>
        <div style={{ ...small, marginTop: 4 }}>
          Off: Browse Hack stops at Suno's terms and you tick them in the tab. Suno also checks uploads against copyrighted music.
        </div>
      </div>
    </div>
  )
}
