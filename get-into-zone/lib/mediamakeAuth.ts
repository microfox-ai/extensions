// Signs the extension in to Mediamake. Every feature needs it (the popup, the
// on-page buttons and Claude's MCP tools wait until it's done).
//
// "Sign in to Mediamake" runs Mediamake's OAuth flow, the same one its Claude
// connector uses: the extension registers itself as an OAuth client once,
// named after its Chrome profile (Mediamake's Signed-in Devices page lists
// sign-ins by that name), opens Mediamake's sign-in and Allow page in a
// Chrome window, and trades the code for an access token (1 hour) and a
// refresh token (30 days). Every refresh brings a new 30-day refresh token,
// so the extension stays signed in for as long as it's used. A Mediamake API
// key saved instead works too.
//
// Tokens are refreshed only in the background worker. The popup, tab pages
// and content scripts get headers from it through mediamakeHeaders().

import { MCP_PROFILE_NAME_KEY, chromeProfileEmail } from "./mcp"

export const DEFAULT_ENDPOINT =
  process.env.NODE_ENV === "production"
    ? "https://mediamake.microfox.app"
    : "http://localhost:3000"

export const ENDPOINT_KEY = "apiEndpoint"
export const API_KEY_KEY = "apiKey"
export const SESSION_KEY = "mediamakeSession"
// The Mediamake client id (account) the extension is signed in as.
export const ACCOUNT_KEY = "mediamakeAccount"
const CLIENT_KEY = "mediamakeOAuthClient"

// The storage keys that decide whether the extension is signed in.
export const SIGNED_IN_KEYS = [SESSION_KEY, API_KEY_KEY]

export const NOT_SIGNED_IN =
  "Browse Hack isn't signed in to Mediamake. Open the Browse Hack popup and click Sign in to Mediamake."

interface Session {
  endpoint: string
  /** The extension's OAuth client id on that Mediamake. */
  clientId: string
  accessToken: string
  accessExpiresAt: number
  refreshToken: string
  signedInAt: number
}

interface OAuthClient {
  endpoint: string
  clientId: string
  redirectUri: string
  /** The client_name it was registered with. Missing on clients saved before 0.4.1. */
  name?: string
}

export interface AuthState {
  signedIn: boolean
  via?: "sign-in" | "api-key"
  account?: string
  endpoint: string
  signedInAt?: number
}

const inWorker = typeof window === "undefined"

const trimEndpoint = (url: string) => url.trim().replace(/\/+$/, "")

const apiKeyOf = (values: Record<string, any>) =>
  typeof values[API_KEY_KEY] === "string" ? values[API_KEY_KEY].trim() : ""

export const isSignedIn = (values: Record<string, any>) =>
  Boolean(values[SESSION_KEY]?.refreshToken || apiKeyOf(values))

export async function mediamakeEndpoint() {
  const { [ENDPOINT_KEY]: endpoint } = await chrome.storage.local.get(ENDPOINT_KEY)
  return typeof endpoint === "string" && endpoint.trim()
    ? trimEndpoint(endpoint)
    : DEFAULT_ENDPOINT
}

export async function authState(): Promise<AuthState> {
  const values = await chrome.storage.local.get([SESSION_KEY, API_KEY_KEY, ACCOUNT_KEY])
  const endpoint = await mediamakeEndpoint()
  const account = typeof values[ACCOUNT_KEY] === "string" ? values[ACCOUNT_KEY] : undefined
  const session = values[SESSION_KEY] as Session | undefined
  if (session?.refreshToken) {
    return { signedIn: true, via: "sign-in", account, endpoint, signedInAt: session.signedInAt }
  }
  if (apiKeyOf(values)) return { signedIn: true, via: "api-key", account, endpoint }
  return { signedIn: false, endpoint }
}

// --- OAuth (background worker) ---------------------------------------------

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const randomToken = () => base64url(crypto.getRandomValues(new Uint8Array(32)))

const sha256 = async (text: string) =>
  base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))
  )

async function reach(endpoint: string, url: string, init: RequestInit) {
  try {
    return await fetch(url, init)
  } catch {
    throw new Error(`Couldn't reach Mediamake at ${endpoint}. Check your connection and try again.`)
  }
}

async function postForm(endpoint: string, path: string, params: Record<string, string>) {
  const resp = await reach(endpoint, `${endpoint}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  })
  return { ok: resp.ok, status: resp.status, data: await resp.json().catch(() => ({})) }
}

/**
 * What Mediamake calls this install, e.g. "Browse Hack (you@gmail.com)": the
 * Chrome profile's Google account, after its name in the popup if it has one.
 */
async function clientName() {
  const { [MCP_PROFILE_NAME_KEY]: name } = await chrome.storage.local.get(MCP_PROFILE_NAME_KEY)
  const profile = [String(name ?? "").trim(), await chromeProfileEmail()].filter(Boolean).join(" · ")
  return profile ? `Browse Hack (${profile})` : "Browse Hack (Chrome extension)"
}

/**
 * The extension's OAuth client on this Mediamake, registered on first use. A
 * client saved under another name is registered again (at sign-in only, so
 * nobody is signed out for it).
 */
async function oauthClient(endpoint: string): Promise<OAuthClient> {
  const redirectUri = chrome.identity.getRedirectURL()
  const name = await clientName()
  const { [CLIENT_KEY]: saved } = await chrome.storage.local.get(CLIENT_KEY)
  if (saved?.endpoint === endpoint && saved.redirectUri === redirectUri && saved.name === name) {
    return saved
  }
  const resp = await reach(endpoint, `${endpoint}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"]
    })
  })
  const data = await resp.json().catch(() => ({}))
  if (!resp.ok || typeof data.client_id !== "string") {
    throw new Error(
      `Mediamake at ${endpoint} didn't accept the sign-in (${data.error_description || resp.status}).`
    )
  }
  const client = { endpoint, clientId: data.client_id, redirectUri, name }
  await chrome.storage.local.set({ [CLIENT_KEY]: client })
  return client
}

const toSession = (endpoint: string, clientId: string, data: any, signedInAt = Date.now()): Session => ({
  endpoint,
  clientId,
  accessToken: data.access_token,
  accessExpiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  refreshToken: data.refresh_token,
  signedInAt
})

/** The Mediamake account a token or API key belongs to. */
async function whoAmI(endpoint: string, token: string) {
  const resp = await reach(endpoint, `${endpoint}/api/me`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (resp.status === 401) return null
  const data = await resp.json().catch(() => ({}))
  return typeof data?.clientId === "string" ? (data.clientId as string) : undefined
}

let signingIn: Promise<AuthState> | undefined

/**
 * Opens Mediamake's sign-in in a Chrome window and waits until the user signs
 * in and clicks Allow (or closes it). Background worker only.
 */
export function signIn() {
  signingIn ??= runSignIn().finally(() => {
    signingIn = undefined
  })
  return signingIn
}

async function runSignIn(): Promise<AuthState> {
  const endpoint = await mediamakeEndpoint()
  // An extension API call now and then keeps the worker alive while the user signs in.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20_000)
  try {
    const client = await oauthClient(endpoint)
    const verifier = randomToken()
    const state = randomToken()
    const url = new URL(`${endpoint}/oauth/authorize`)
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_challenge: await sha256(verifier),
      code_challenge_method: "S256",
      state,
      scope: "mediamake"
    }).toString()

    let redirect: string | undefined
    try {
      redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true })
    } catch {
      // Registered again next time, in case Mediamake no longer knew this client.
      await chrome.storage.local.remove(CLIENT_KEY)
      throw new Error("The sign-in window was closed before you clicked Allow.")
    }
    const back = new URL(redirect!)
    if (back.searchParams.get("state") !== state) {
      throw new Error("Sign-in failed: Mediamake's answer didn't match the request. Try again.")
    }
    const error = back.searchParams.get("error")
    if (error) {
      throw new Error(
        back.searchParams.get("error_description") ||
          (error === "access_denied" ? "Sign-in was cancelled." : `Sign-in failed (${error}).`)
      )
    }
    const { ok, data } = await postForm(endpoint, "/oauth/token", {
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      code_verifier: verifier
    })
    if (!ok || !data.access_token || !data.refresh_token) {
      throw new Error(`Sign-in failed: ${data.error_description || data.error || "no token"}.`)
    }
    const session = toSession(endpoint, client.clientId, data)
    const account = await whoAmI(endpoint, session.accessToken)
    const { [SESSION_KEY]: replaced } = await chrome.storage.local.get(SESSION_KEY)
    await chrome.storage.local.remove([API_KEY_KEY, ACCOUNT_KEY])
    await chrome.storage.local.set({
      [SESSION_KEY]: session,
      [ENDPOINT_KEY]: endpoint,
      ...(account ? { [ACCOUNT_KEY]: account } : {})
    })
    // Signing in again while signed in: the old sign-in leaves Mediamake's devices list.
    if (replaced?.refreshToken) await revoke(replaced)
    return authState()
  } finally {
    clearInterval(keepAlive)
  }
}

let refreshing: Promise<string> | undefined

// One refresh at a time: Mediamake rotates refresh tokens on every use.
function refreshAccess(session: Session) {
  refreshing ??= (async () => {
    const { ok, status, data } = await postForm(session.endpoint, "/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId
    })
    if (!ok) {
      if (data?.error === "invalid_grant" || data?.error === "invalid_client") {
        await chrome.storage.local.remove([SESSION_KEY, ACCOUNT_KEY])
        throw new Error(
          `Your Mediamake sign-in ended (${data.error_description || "it expired"}). ${NOT_SIGNED_IN}`
        )
      }
      throw new Error(`Couldn't renew the Mediamake sign-in (${status}). Try again in a minute.`)
    }
    const next = toSession(session.endpoint, session.clientId, data, session.signedInAt)
    await chrome.storage.local.set({ [SESSION_KEY]: next })
    return next.accessToken
  })().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

async function bearer(forceRefresh = false) {
  const values = await chrome.storage.local.get([SESSION_KEY, API_KEY_KEY])
  const session = values[SESSION_KEY] as Session | undefined
  if (session?.refreshToken) {
    if (!forceRefresh && session.accessExpiresAt - 60_000 > Date.now()) return session.accessToken
    return refreshAccess(session)
  }
  const apiKey = apiKeyOf(values)
  if (apiKey) return apiKey
  throw new Error(NOT_SIGNED_IN)
}

// --- Anywhere ------------------------------------------------------------------

/** The Authorization header for Mediamake calls. Throws NOT_SIGNED_IN when signed out. */
export async function mediamakeHeaders(
  options: { forceRefresh?: boolean } = {}
): Promise<Record<string, string>> {
  if (inWorker) return { Authorization: `Bearer ${await bearer(options.forceRefresh)}` }
  const response = await chrome.runtime.sendMessage({ action: "mediamakeHeaders", ...options })
  if (!response?.success) throw new Error(response?.message || NOT_SIGNED_IN)
  return response.headers
}

/** fetch() with the Mediamake sign-in. A 401 gets one retry with a renewed token. */
export async function authorizedFetch(url: string, init: RequestInit = {}) {
  const send = async (forceRefresh?: boolean) => {
    const headers = new Headers(init.headers)
    for (const [name, value] of Object.entries(await mediamakeHeaders({ forceRefresh }))) {
      headers.set(name, value)
    }
    return fetch(url, { ...init, headers })
  }
  const resp = await send()
  if (resp.status !== 401) return resp
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY)
  return session ? send(true) : resp
}

/** Signs in with an API key instead: checks it, then saves it. */
export async function saveApiKey(apiKey: string, endpoint?: string) {
  const key = apiKey.trim()
  const base = endpoint?.trim() ? trimEndpoint(endpoint) : await mediamakeEndpoint()
  if (!key) throw new Error("Paste a Mediamake API key.")
  const account = await whoAmI(base, key)
  if (account === null) throw new Error(`Mediamake at ${base} doesn't accept that API key.`)
  await signOut()
  await chrome.storage.local.set({
    [API_KEY_KEY]: key,
    [ENDPOINT_KEY]: base,
    ...(account ? { [ACCOUNT_KEY]: account } : {})
  })
  return authState()
}

/** Ends a sign-in on Mediamake (best effort). */
const revoke = (session: Session) =>
  fetch(`${session.endpoint}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token: session.refreshToken, client_id: session.clientId })
  }).catch(() => undefined)

/** Signs out: revokes the sign-in (best effort) and forgets it and any API key. */
export async function signOut() {
  const { [SESSION_KEY]: session } = await chrome.storage.local.get(SESSION_KEY)
  await chrome.storage.local.remove([SESSION_KEY, API_KEY_KEY, ACCOUNT_KEY])
  if (session?.refreshToken) await revoke(session)
}

/** Calls back with whether the extension is signed in, now and on every change. */
export function watchSignedIn(onChange: (signedIn: boolean) => void) {
  const read = () => chrome.storage.local.get(SIGNED_IN_KEYS, (values) => onChange(isSignedIn(values)))
  read()
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && SIGNED_IN_KEYS.some((key) => changes[key])) read()
  })
}

/** Answers the popup's and content scripts' sign-in requests. Background worker only. */
export function initMediamakeAuth() {
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    const reply = (task: () => Promise<Record<string, unknown>>) => {
      task().then(
        (result) => sendResponse({ success: true, ...result }),
        (error: Error) => sendResponse({ success: false, message: error.message })
      )
      return true
    }
    switch (request?.action) {
      case "mediamakeHeaders":
        return reply(async () => ({
          headers: await mediamakeHeaders({ forceRefresh: Boolean(request.forceRefresh) })
        }))
      case "mediamakeSignIn":
        return reply(async () => ({ state: await signIn() }))
    }
    return undefined
  })
}
