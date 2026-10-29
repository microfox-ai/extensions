import { useEffect, useState } from "react"

import {
  ACCOUNT_KEY,
  ENDPOINT_KEY,
  SIGNED_IN_KEYS,
  authState,
  saveApiKey,
  type AuthState
} from "../lib/mediamakeAuth"

/** The extension's Mediamake sign-in, kept up to date. Undefined while loading. */
export function useAuthState() {
  const [state, setState] = useState<AuthState>()
  useEffect(() => {
    const keys = [...SIGNED_IN_KEYS, ACCOUNT_KEY, ENDPOINT_KEY]
    const read = () => authState().then(setState)
    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      namespace: string
    ) => {
      if (namespace === "local" && keys.some((key) => changes[key])) read()
    }
    read()
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])
  return state
}

const inputStyle = {
  width: "100%",
  padding: "8px",
  boxSizing: "border-box" as const,
  marginTop: "4px"
}

// Shown instead of the tabs until the extension is signed in to Mediamake.
export function SignInScreen({ endpoint }: { endpoint: string }) {
  const [url, setUrl] = useState(endpoint)
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [savingKey, setSavingKey] = useState(false)

  useEffect(() => setUrl(endpoint), [endpoint])

  const saveEndpoint = () => {
    const next = url.trim().replace(/\/+$/, "")
    if (next && next !== endpoint) chrome.storage.local.set({ [ENDPOINT_KEY]: next })
  }

  // The worker runs the sign-in: Chrome closes this popup when the sign-in
  // window takes focus, and the result lands in storage either way.
  const signIn = async () => {
    saveEndpoint()
    setError("")
    setWaiting(true)
    const response = await chrome.runtime.sendMessage({ action: "mediamakeSignIn" })
    setWaiting(false)
    if (!response?.success) setError(response?.message || "Sign-in failed.")
  }

  const useKey = async () => {
    setError("")
    setSavingKey(true)
    try {
      await saveApiKey(apiKey, url)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSavingKey(false)
    }
  }

  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Sign in to Mediamake</h2>
      <p style={{ fontSize: 13, color: "#374151" }}>
        Browse Hack works once it's connected to your Mediamake account. A Mediamake window opens: sign
        in there and click <b>Allow</b>, then open Browse Hack again.
      </p>
      <p style={{ fontSize: 12, color: "#6b7280" }}>
        You stay signed in while you use the extension. You'll only be asked again after 30 days without
        using it, or if you sign out.
      </p>
      <button
        onClick={signIn}
        disabled={waiting}
        style={{
          width: "100%",
          padding: "10px",
          backgroundColor: "#4285F4",
          color: "white",
          border: "none",
          cursor: "pointer",
          fontSize: 14
        }}>
        {waiting ? "Waiting for you to click Allow…" : "Sign in to Mediamake"}
      </button>
      {error && <p style={{ color: "#b91c1c", fontSize: 12 }}>{error}</p>}

      <div style={{ marginTop: 16, fontSize: 12 }}>
        <a href="#" onClick={(e) => (e.preventDefault(), setShowKey(!showKey))}>
          {showKey ? "Hide" : "Use a Mediamake API key instead"}
        </a>
      </div>
      {showKey && (
        <div style={{ marginTop: 8 }}>
          <label style={{ fontSize: 12 }}>
            API key (make one on Mediamake's API keys page):
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Paste your API key"
            style={inputStyle}
          />
          <button
            onClick={useKey}
            disabled={savingKey || !apiKey.trim()}
            style={{ marginTop: 8, width: "100%", padding: "8px" }}>
            {savingKey ? "Checking…" : "Use this key"}
          </button>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <label style={{ fontSize: 12 }}>Mediamake URL:</label>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={saveEndpoint}
          style={inputStyle}
        />
      </div>
    </div>
  )
}
