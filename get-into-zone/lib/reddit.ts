// Reddit's public JSON (any listing or thread with ".json" on the end) read
// from inside a reddit.com tab, so each request carries the user's own Reddit
// session (cookies, consent) and Reddit answers it as it answers their
// browser. From a script or curl Reddit answers its bot wall instead.
//
// Politely: one request at a time per Chrome profile, a pause between them,
// and Reddit's own rate-limit headers respected (when few requests are left,
// the next one waits for Reddit's window to reset). When Reddit answers a page
// instead of JSON (its block page, a login wall, "whoa there, pardner"), the
// error says which, so Claude can tell the user what to clear in Chrome.
//
// The MCP server (mcp/src/reddit.ts) builds the requests and shapes what comes
// back: posts, comment trees without usernames, saved raw JSON.

import { openTabForClaude } from "./tabs"

const HOSTS = ["www.reddit.com", "old.reddit.com"]
const HOME = "https://www.reddit.com/"
// The pause between two requests.
const GAP_MS = 1500
// With fewer requests than this left in Reddit's window, wait for it to reset…
const LOW_REMAINING = 3
// …unless that's longer than this.
const MAX_WAIT_MS = 90_000

export interface RedditRateLimit {
  remaining?: number
  used?: number
  resetSeconds?: number
}

export type RedditAnswer =
  | { ok: true; status: number; url: string; data: unknown; rateLimit: RedditRateLimit }
  | {
      ok: false
      status: number
      url: string
      // blocked: a page instead of JSON; login: sent to the login page;
      // rate-limited: 429; refused: JSON with an error (private, banned, not found).
      reason: "blocked" | "login" | "rate-limited" | "refused" | "network"
      title?: string
      message?: string
      retryAfter?: number
      rateLimit: RedditRateLimit
    }

// Runs in the reddit.com tab, so it can't use anything outside itself.
async function fetchInPage(path: string, query: Record<string, string>): Promise<RedditAnswer> {
  const url = new URL(path, location.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  let resp: Response
  try {
    resp = await fetch(url.href, { credentials: "include", headers: { Accept: "application/json" } })
  } catch (error) {
    return { ok: false, status: 0, url: url.href, reason: "network", message: String(error), rateLimit: {} }
  }
  const number = (name: string) => {
    const value = resp.headers.get(name)
    return value === null || value === "" || !Number.isFinite(Number(value)) ? undefined : Number(value)
  }
  const rateLimit = {
    remaining: number("x-ratelimit-remaining"),
    used: number("x-ratelimit-used"),
    resetSeconds: number("x-ratelimit-reset")
  }
  const text = await resp.text()
  let data: any
  if (/json/i.test(resp.headers.get("content-type") || "") || /^\s*[[{]/.test(text)) {
    try {
      data = JSON.parse(text)
    } catch {
      data = undefined
    }
  }
  if (resp.ok && data !== undefined) return { ok: true, status: resp.status, url: resp.url || url.href, data, rateLimit }

  const finalUrl = resp.url || url.href
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.replace(/\s+/g, " ").trim()
  const words = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  const login = /\/(?:account\/)?login\b/i.test(new URL(finalUrl).pathname)
  const reason =
    resp.status === 429 || /whoa there/i.test(words)
      ? "rate-limited"
      : login
        ? "login"
        : data !== undefined
          ? "refused"
          : "blocked"
  const message =
    data !== undefined
      ? [data.reason, data.message, data.explanation].filter((part) => typeof part === "string" && part).join(": ")
      : words.replace(/\s+/g, " ").trim().slice(0, 200)
  return {
    ok: false,
    status: resp.status,
    url: finalUrl,
    reason,
    title: title || undefined,
    message: message || undefined,
    retryAfter: number("retry-after"),
    rateLimit
  }
}

// Runs in the reddit.com tab: where a share link (/r/<sub>/s/<code>) leads.
async function resolveInPage(href: string): Promise<{ url?: string; error?: string }> {
  try {
    const url = new URL(href, location.origin)
    const resp = await fetch(url.href, { credentials: "include" })
    return { url: resp.url }
  } catch (error) {
    return { error: String(error) }
  }
}

const isRedditTab = (tab?: chrome.tabs.Tab) => {
  try {
    return !!tab?.url && HOSTS.includes(new URL(tab.url).hostname)
  } catch {
    return false
  }
}

// The tab the requests run in: the one asked for, else an open reddit.com tab
// (www first), else a new one opened in the background, which close_tabs can
// close later.
async function redditTab(tabId?: number): Promise<{ tab: chrome.tabs.Tab; opened: boolean }> {
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (isRedditTab(tab)) return { tab: tab!, opened: false }
    throw new Error(`Tab ${tabId} isn't on www.reddit.com or old.reddit.com.`)
  }
  const tabs = (
    await chrome.tabs.query({ url: HOSTS.map((host) => `https://${host}/*`), discarded: false })
  ).filter((tab) => tab.status === "complete")
  const open = tabs.find((tab) => new URL(tab.url!).hostname === HOSTS[0]) ?? tabs[0]
  if (open) return { tab: open, opened: false }
  return { tab: await openTabForClaude(HOME, false), opened: true }
}

async function inTab<A extends any[], R>(tabId: number | undefined, func: (...args: A) => Promise<R>, args: A) {
  const { tab, opened } = await redditTab(tabId)
  let injection: { result?: unknown } | undefined
  try {
    ;[injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id! }, func: func as any, args })
  } catch (error) {
    throw new Error(
      `Couldn't run in the reddit.com tab ${tab.id} (${error instanceof Error ? error.message : String(error)}). ` +
        "Reload it, or close it so a new one opens, and try again."
    )
  }
  if (!injection?.result) throw new Error(`The reddit.com tab ${tab.id} didn't answer. Reload it and try again.`)
  return { result: injection.result as R, tabId: tab.id!, openedTab: opened }
}

// --- One request at a time ---------------------------------------------------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let chain: Promise<unknown> = Promise.resolve()
let nextAt = 0

function politely<T>(work: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const wait = nextAt - Date.now()
    if (wait > MAX_WAIT_MS) {
      throw new Error(
        `Reddit's rate limit for this browser resets in ${Math.ceil(wait / 1000)} s. Try again then.`
      )
    }
    if (wait > 0) await sleep(wait)
    try {
      return await work()
    } finally {
      nextAt = Math.max(nextAt, Date.now() + GAP_MS)
    }
  })
  chain = next.catch(() => undefined)
  return next
}

function noteRateLimit(answer: RedditAnswer) {
  const { remaining, resetSeconds } = answer.rateLimit
  if (typeof remaining === "number" && remaining < LOW_REMAINING && typeof resetSeconds === "number") {
    nextAt = Math.max(nextAt, Date.now() + resetSeconds * 1000 + 500)
  }
  if (!answer.ok && answer.reason === "rate-limited") {
    const seconds = answer.retryAfter ?? answer.rateLimit.resetSeconds ?? 60
    nextAt = Math.max(nextAt, Date.now() + seconds * 1000)
  }
}

function failure(answer: Extract<RedditAnswer, { ok: false }>) {
  const where = `(${answer.status || "no answer"}${answer.title ? `, "${answer.title}"` : ""}) for ${answer.url}`
  switch (answer.reason) {
    case "rate-limited":
      return new Error(
        `Reddit is rate-limiting this browser ${where}. Wait ${answer.retryAfter ?? answer.rateLimit.resetSeconds ?? 60} s and try again.`
      )
    case "login":
      return new Error(
        `Reddit sent this request to its login page ${where}. Ask the user to sign in to reddit.com in this Chrome profile, then try again.`
      )
    case "blocked":
      return new Error(
        `Reddit answered a page instead of JSON ${where}: ${answer.message || "no text"}. Ask the user to open ` +
          "https://www.reddit.com in this Chrome profile and clear whatever it shows (a check, a consent banner, a " +
          "sign-in), then try again. Never solve a captcha for them."
      )
    case "refused":
      return new Error(`Reddit refused this request ${where}: ${answer.message || "no reason given"}.`)
    default:
      return new Error(`Couldn't reach Reddit ${where}: ${answer.message || "network error"}.`)
  }
}

// --- Methods for the MCP bridge ----------------------------------------------

const JSON_PATH = /^\/[\w\-+/.]*\.json$/

/** GETs one of Reddit's .json paths (e.g. /search.json, /r/a+b/search.json, /comments/<id>.json). */
export async function redditJson(params: { path?: string; query?: Record<string, unknown>; tabId?: number }) {
  const path = String(params.path ?? "")
  if (!JSON_PATH.test(path) || path.includes("..")) {
    throw new Error(`"${path}" isn't one of Reddit's .json paths (like /search.json or /comments/<id>.json).`)
  }
  const query = Object.fromEntries(
    Object.entries(params.query ?? {})
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => [key, String(value)])
  )
  return politely(async () => {
    const { result, tabId, openedTab } = await inTab(params.tabId, fetchInPage, [path, query])
    noteRateLimit(result)
    if (!result.ok) throw failure(result)
    return { url: result.url, status: result.status, data: result.data, rateLimit: result.rateLimit, tabId, openedTab }
  })
}

/** Where a Reddit share link (reddit.com/r/<sub>/s/<code>) leads. */
export async function redditResolve(params: { url?: string; tabId?: number }) {
  const href = String(params.url ?? "")
  let url: URL
  try {
    url = new URL(href)
  } catch {
    throw new Error(`"${href}" isn't a link.`)
  }
  if (!/(?:^|\.)reddit\.com$/i.test(url.hostname)) throw new Error(`"${href}" isn't a reddit.com link.`)
  return politely(async () => {
    const { result } = await inTab(params.tabId, resolveInPage, [url.pathname + url.search])
    if (!result.url) throw new Error(`Couldn't follow ${href}: ${result.error || "no answer"}.`)
    return { url: result.url }
  })
}
