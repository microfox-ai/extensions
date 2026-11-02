import { useEffect, useState, type CSSProperties } from "react"

import type { SunoAccount, SunoWorkspace } from "../lib/suno/clip"
import {
  DEFAULT_SUNO_PREFS,
  SUNO_PREFS_KEY,
  loadSunoPrefs,
  readSunoPrefs,
  saveSunoPrefs,
  suggestFor,
  type SunoChannel,
  type SunoPrefs
} from "../lib/sunoPrefs"

// The popup's Suno tab: links each MediaMake channel to the Suno workspace its
// songs are made in and the MediaMake project they're recorded under (one
// channel at a time, with the names that fit suggested, and a new project made
// on the spot when the channel has none), and holds the download settings.
// The upload-terms switch lives only here: Claude can't turn it on.

type Project = { id: string; name: string; viewOnly?: boolean }

const ask = (op: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve, reject) => {
    chrome.runtime.sendMessage({ action: "suno-ui", op, ...params }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message))
      else if (!response?.ok) reject(new Error(response?.error || "Browse Hack didn't answer."))
      else resolve(response.result)
    })
  })

const ORANGE = "#F97316"
const box: CSSProperties = { border: "1px solid #ddd", borderRadius: 6, padding: 10, marginBottom: 12 }
const small: CSSProperties = { fontSize: 12, color: "#555", lineHeight: 1.4 }
const select: CSSProperties = { width: "100%", padding: 4, fontSize: 12 }
const label: CSSProperties = { display: "block", fontSize: 11, color: "#555", margin: "8px 0 3px" }
const button: CSSProperties = { padding: "3px 10px", fontSize: 12, border: "1px solid #ccc", borderRadius: 5, background: "#fff", cursor: "pointer" }
const primary: CSSProperties = { ...button, background: ORANGE, borderColor: ORANGE, color: "#fff" }
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: "1px solid #eee" }
const warn: CSSProperties = { color: "#b45309" }

const NEW_PROJECT = "new"
const byName = <T extends { name: string }>(list: T[]) => [...list].sort((a, b) => a.name.localeCompare(b.name))

/** A channel as people know it: its Downloads folder (AMZ), then its id. */
function ChannelName({ channel }: { channel: SunoChannel }) {
  const folder = channel.folder && channel.folder !== channel.id ? channel.folder : undefined
  return (
    <div style={{ minWidth: 0 }}>
      <b>{folder ?? channel.id}</b>
      {folder ? <span style={{ color: "#888", fontSize: 11 }}> {channel.id}</span> : null}
    </div>
  )
}

function ChannelEditor({
  channel,
  workspaces,
  projects,
  onCreated,
  onDone
}: {
  channel: SunoChannel
  workspaces: SunoWorkspace[] | null
  projects: Project[] | null
  onCreated: (project: Project) => void
  onDone: (saved: boolean) => void
}) {
  const writable = (projects ?? []).filter((p) => !p.viewOnly)
  const suggestedWorkspace = suggestFor(channel, workspaces ?? [])
  const suggestedProject = suggestFor(channel, writable)
  const [workspaceId, setWorkspaceId] = useState(channel.workspaceId ?? suggestedWorkspace?.id ?? "")
  const [projectId, setProjectId] = useState(channel.projectId ?? suggestedProject?.id ?? "")
  const [newName, setNewName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // The lists may arrive after the editor opens: fill in what fits then.
  useEffect(() => {
    if (!workspaceId && suggestedWorkspace) setWorkspaceId(suggestedWorkspace.id)
  }, [suggestedWorkspace?.id])
  useEffect(() => {
    if (!projectId && suggestedProject) setProjectId(suggestedProject.id)
  }, [suggestedProject?.id])

  const workspace = workspaces?.find((w) => w.id === workspaceId)
  const defaultName = workspace?.name ?? channel.folder ?? channel.id
  const projectMissing = !!channel.projectId && projectId === channel.projectId && !!projects && !projects.some((p) => p.id === projectId)

  const save = async () => {
    setBusy(true)
    setError("")
    try {
      let project = projects?.find((p) => p.id === projectId)
      if (projectId === NEW_PROJECT) {
        project = (await ask("createProject", { name: (newName || defaultName).trim() })) as Project
        onCreated(project)
      }
      const current = await loadSunoPrefs()
      await saveSunoPrefs({
        channels: current.channels.map((c) =>
          c.id === channel.id
            ? {
                ...c,
                workspaceId: workspaceId || undefined,
                workspaceName: workspaceId ? (workspace?.name ?? c.workspaceName) : undefined,
                projectId: project?.id ?? (projectMissing ? c.projectId : undefined),
                projectName: project?.name ?? (projectMissing ? c.projectName : undefined)
              }
            : c
        )
      })
      onDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const unlink = async () => {
    const current = await loadSunoPrefs()
    await saveSunoPrefs({
      channels: current.channels.map((c) =>
        c.id === channel.id ? { id: c.id, folder: c.folder } : c
      )
    })
    onDone(true)
  }

  const linked = !!(channel.workspaceId || channel.projectId)
  return (
    <div style={{ padding: "8px 10px", margin: "6px -4px", background: "#fafafa", border: `1px solid ${ORANGE}`, borderRadius: 6 }}>
      <ChannelName channel={channel} />

      <label style={label}>Suno workspace its songs are made in</label>
      <select style={select} value={workspaceId} disabled={!workspaces} onChange={(e) => setWorkspaceId(e.target.value)}>
        <option value="">{workspaces ? "None (Suno's current one)" : "Loading Suno workspaces…"}</option>
        {byName(workspaces ?? []).map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
            {w.id === suggestedWorkspace?.id ? " (suggested)" : ""}
          </option>
        ))}
      </select>

      <label style={label}>MediaMake project its takes are recorded under</label>
      <select style={select} value={projectId} disabled={!projects} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">{projects ? "None (not recorded)" : "Loading MediaMake projects…"}</option>
        {projectMissing ? <option value={channel.projectId}>{channel.projectName ?? channel.projectId} (not found)</option> : null}
        {byName(projects ?? []).map((p) => (
          <option key={p.id} value={p.id} disabled={p.viewOnly}>
            {p.name}
            {p.viewOnly ? " (view only)" : p.id === suggestedProject?.id ? " (suggested)" : ""}
          </option>
        ))}
        <option value={NEW_PROJECT}>+ New project…</option>
      </select>
      {projectMissing ? (
        <div style={{ ...small, ...warn, marginTop: 4 }}>
          MediaMake doesn't have this project any more (or it isn't shared with you): pick another or make a new one.
        </div>
      ) : null}
      {projectId === NEW_PROJECT ? (
        <div style={{ marginTop: 6 }}>
          <input
            autoFocus
            value={newName}
            placeholder={defaultName}
            onChange={(e) => setNewName(e.target.value)}
            style={{ width: "100%", padding: 4, fontSize: 12, boxSizing: "border-box" }}
          />
          <div style={{ ...small, marginTop: 3 }}>Saving makes this project in MediaMake, owned by you.</div>
        </div>
      ) : null}

      {error ? <div style={{ ...small, color: "#dc2626", marginTop: 6 }}>{error}</div> : null}
      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 10 }}>
        {linked ? (
          <button style={{ ...button, marginRight: "auto" }} disabled={busy} onClick={unlink}>
            Unlink
          </button>
        ) : null}
        <button style={button} disabled={busy} onClick={() => onDone(false)}>
          Cancel
        </button>
        <button style={primary} disabled={busy || (!workspaceId && !projectId)} onClick={save}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  )
}

/** One linked channel: where its songs go, and what's missing. */
function LinkedChannel({
  channel,
  workspaces,
  projects,
  justSaved,
  onEdit
}: {
  channel: SunoChannel
  workspaces: SunoWorkspace[] | null
  projects: Project[] | null
  justSaved: boolean
  onEdit: () => void
}) {
  const workspaceGone = !!channel.workspaceId && !!workspaces && !workspaces.some((w) => w.id === channel.workspaceId)
  const projectGone = !!channel.projectId && !!projects && !projects.some((p) => p.id === channel.projectId)
  const line = (what: string, name: string | undefined, gone: boolean, missing: string) => (
    <div style={small}>
      {what}:{" "}
      {name ? (
        <span style={gone ? warn : undefined}>
          {name}
          {gone ? " (not found)" : ""}
        </span>
      ) : (
        <span style={warn}>{missing}</span>
      )}
    </div>
  )
  return (
    <div style={row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <ChannelName channel={channel} />
        {line("Suno", channel.workspaceName ?? channel.workspaceId, workspaceGone, "no workspace (uses Suno's current one)")}
        {line("MediaMake", channel.projectName ?? channel.projectId, projectGone, "no project (takes aren't recorded)")}
      </div>
      {justSaved ? <span style={{ fontSize: 12, color: "#16a34a" }}>Saved ✓</span> : null}
      <button style={button} onClick={onEdit}>
        Edit
      </button>
    </div>
  )
}

export function SunoTab() {
  const [prefs, setPrefs] = useState<SunoPrefs>(DEFAULT_SUNO_PREFS)
  const [account, setAccount] = useState<SunoAccount | null>(null)
  const [workspaces, setWorkspaces] = useState<SunoWorkspace[] | null>(null)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [status, setStatus] = useState("Checking Suno…")
  const [listsError, setListsError] = useState("")
  const [editing, setEditing] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [newChannel, setNewChannel] = useState("")

  const loadLists = () => {
    setListsError("")
    const failed = (what: string) => (error: Error) =>
      setListsError((shown) => [shown, `Couldn't load ${what}: ${error.message}`].filter(Boolean).join(" "))
    ask("workspaces").then(setWorkspaces).catch(failed("Suno's workspaces"))
    ask("projects").then(setProjects).catch(failed("MediaMake's projects"))
  }

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
    loadLists()
    return () => chrome.storage.onChanged.removeListener(onChange)
  }, [])

  const update = async (patch: Partial<SunoPrefs>) => setPrefs(await saveSunoPrefs(patch))

  const addChannel = () => {
    const id = newChannel.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "")
    if (!id || prefs.channels.some((c) => c.id === id)) return
    update({ channels: [...prefs.channels, { id }] })
    setNewChannel("")
    setEditing(id)
  }

  const done = (id: string) => (didSave: boolean) => {
    setEditing(null)
    if (!didSave) return
    setSaved(id)
    setTimeout(() => setSaved((current) => (current === id ? null : current)), 2500)
  }

  const isLinked = (c: SunoChannel) => !!(c.workspaceId || c.projectId)
  const linked = prefs.channels.filter(isLinked)
  const unlinked = prefs.channels.filter((c) => !isLinked(c))
  const editor = (c: SunoChannel) => (
    <ChannelEditor
      key={c.id}
      channel={c}
      workspaces={workspaces}
      projects={projects}
      onCreated={(project) => setProjects((list) => [...(list ?? []), project])}
      onDone={done(c.id)}
    />
  )

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
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <strong>Channels</strong>
          <span style={{ ...small, flex: 1 }}>
            {prefs.channels.length ? `${linked.length} of ${prefs.channels.length} linked` : ""}
          </span>
          <button style={{ ...button, padding: "1px 8px", fontSize: 11 }} title="Reload Suno's workspaces and MediaMake's projects" onClick={loadLists}>
            Reload lists
          </button>
        </div>
        <div style={{ ...small, marginTop: 4 }}>
          Link a channel to the Suno workspace its songs are made in and the MediaMake project its takes are recorded
          under. Claude and the buttons on suno.com use these.
        </div>
        {listsError ? <div style={{ ...small, color: "#dc2626", marginTop: 4 }}>{listsError}</div> : null}
        {prefs.channels.length === 0 ? (
          <div style={{ ...small, marginTop: 8 }}>
            No channels yet. Claude adds MediaMake's channels when it uses Suno, or add one below.
          </div>
        ) : null}

        {linked.length ? <div style={{ ...label, marginTop: 10 }}>Linked</div> : null}
        {linked.map((c) =>
          editing === c.id ? (
            editor(c)
          ) : (
            <LinkedChannel
              key={c.id}
              channel={c}
              workspaces={workspaces}
              projects={projects}
              justSaved={saved === c.id}
              onEdit={() => setEditing(c.id)}
            />
          )
        )}

        {unlinked.length ? <div style={{ ...label, marginTop: 10 }}>Not linked</div> : null}
        {unlinked.map((c) => {
          if (editing === c.id) return editor(c)
          const workspace = suggestFor(c, workspaces ?? [])
          const project = suggestFor(c, (projects ?? []).filter((p) => !p.viewOnly))
          return (
            <div key={c.id} style={row}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <ChannelName channel={c} />
                {workspace || project ? (
                  <div style={small}>
                    Suggested: {[workspace && `Suno ${workspace.name}`, project && `MediaMake ${project.name}`].filter(Boolean).join(" · ")}
                  </div>
                ) : null}
              </div>
              <button style={workspace || project ? primary : button} onClick={() => setEditing(c.id)}>
                Link
              </button>
            </div>
          )
        })}

        <details style={{ marginTop: 10 }}>
          <summary style={{ ...small, cursor: "pointer" }}>Add a channel MediaMake's library doesn't have</summary>
          <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <input
              value={newChannel}
              onChange={(e) => setNewChannel(e.target.value)}
              placeholder="channel id, e.g. animemusiczone"
              style={{ flex: 1, padding: 4, fontSize: 12 }}
            />
            <button onClick={addChannel} style={button}>
              Add
            </button>
          </div>
        </details>
      </div>

      <div style={box}>
        <strong>Saving songs</strong>
        <div style={{ ...small, marginTop: 4 }}>
          Saved songs go to <code>{prefs.inboxFolder}/suno/&lt;channel&gt;/&lt;song&gt;/</code> in Downloads, with a
          .source.json beside each for MediaMake's <code>media ingest</code>. A song's first download uses one of your
          Suno downloads; it's free after that.
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
