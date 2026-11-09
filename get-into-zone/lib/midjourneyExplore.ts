// Midjourney's Explore: what the community publishes, read through the same
// endpoints midjourney.com's own Explore page calls (read from its bundle, Nov
// 2026), inside a midjourney.com tab so the user's session applies.
//
//   /api/explore?feed=<feed>&page=<0..>          a feed (Top, Hot, New, Videos…)
//   /api/explore-vector-search?prompt=<q>&page=<1..>   the search box
//   /api/explore-srefs?feed=<styles feed>&page=<0..>   the Styles tab
//   /api/styles-vector-search?prompt=<q or 0_<code>>&page=<1..>   searching styles
//
// Each answers a page of up to 50 jobs (or styles); an empty page is the end.
// Signed out, /api/explore answers Top month whatever feed is asked for, and
// the searches and the Styles tab answer 401, so those need a signed-in tab.
// The MCP server turns the jobs into results (prompts, sref codes, links).

import { runInPage } from "./midjourneyApi"

export const EXPLORE_FEEDS = [
  "top",
  "top_week",
  "top_month",
  "hot",
  "new",
  "random",
  "for_you",
  "videos",
  "video_top",
  "video_top_week",
  "video_top_month",
  "video_hot",
  "for_you_video"
] as const

export const STYLE_FEEDS = [
  "styles_top",
  "styles_top_week",
  "styles_top_month",
  "styles_hot",
  "styles_random"
] as const

const MAX_PAGES = 5

type PageAnswer =
  | { ok: true; status: number; data: unknown; signedIn: boolean }
  | { ok: false; status: number; error: string; signedIn: boolean }

// Runs in the midjourney.com tab, so it can't use anything outside itself.
async function exploreInPage(path: string, query: Record<string, string>): Promise<PageAnswer> {
  const headers = { "X-CSRF-Protection": "1" }
  const account = await fetch("/api/user-account", { credentials: "include", headers }).catch(() => null)
  const signedIn = Boolean(account?.ok)
  const url = new URL(path, location.origin)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  const resp = await fetch(url.href, { credentials: "include", headers })
  const text = await resp.text()
  let data: any = null
  try {
    data = JSON.parse(text)
  } catch {
    // Keep the text for the error.
  }
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: String(data?.error ?? text.slice(0, 200)), signedIn }
  }
  return { ok: true, status: resp.status, data, signedIn }
}

function failure(answer: Extract<PageAnswer, { ok: false }>, what: string) {
  if (answer.status === 401 || !answer.signedIn) {
    return new Error(
      `${what} needs you signed in to midjourney.com in this Chrome profile (Midjourney answered ${answer.status}). ` +
        "Sign in there, then try again."
    )
  }
  return new Error(`Midjourney's ${what} answered ${answer.status}: ${answer.error || "no reason given"}`)
}

const pageCount = (pages: unknown) => Math.min(MAX_PAGES, Math.max(1, Math.floor(Number(pages) || 1)))
const firstPage = (page: unknown) => Math.max(1, Math.floor(Number(page) || 1))

// Fetches `pages` pages from `page` on (1 is the first), stopping at an empty one.
async function fetchPages(
  what: string,
  path: string,
  query: Record<string, string>,
  { page, pages, zeroBased }: { page: unknown; pages: unknown; zeroBased: boolean }
) {
  const items: any[] = []
  const seen = new Set<string>()
  const start = firstPage(page)
  const count = pageCount(pages)
  let signedIn = false
  let nextPage: number | null = start
  for (let n = start; n < start + count; n++) {
    const answer = await runInPage(exploreInPage, [path, { ...query, page: String(zeroBased ? n - 1 : n) }])
    if (!answer) throw new Error("Couldn't run in the midjourney.com tab. Reload it and try again.")
    signedIn = answer.signedIn
    if (!answer.ok) throw failure(answer, what)
    const list = Array.isArray(answer.data) ? answer.data : []
    if (!list.length) {
      nextPage = null
      break
    }
    for (const item of list) {
      const id = typeof item?.id === "string" && item.id ? item.id : String(item?.formatted_sref ?? "")
      if (!id || seen.has(id)) continue
      seen.add(id)
      items.push(item)
    }
    nextPage = n + 1
  }
  return { items, signedIn, page: start, nextPage }
}

/** Explore's jobs: a search when `query` is given, else a feed (default Top month). */
export async function explore(params: { query?: string; feed?: string; page?: number; pages?: number }) {
  const query = typeof params.query === "string" ? params.query.trim() : ""
  if (query) {
    const { items, ...rest } = await fetchPages(
      "Explore search",
      "/api/explore-vector-search",
      { prompt: query, _ql: "explore" },
      { page: params.page, pages: params.pages, zeroBased: false }
    )
    return { query, jobs: items, ...rest }
  }
  const feed = params.feed ?? "top_month"
  if (!(EXPLORE_FEEDS as readonly string[]).includes(feed)) {
    throw new Error(`Unknown Explore feed "${feed}". Use one of: ${EXPLORE_FEEDS.join(", ")}.`)
  }
  const { items, ...rest } = await fetchPages(
    "Explore",
    "/api/explore",
    { feed, _ql: "explore" },
    { page: params.page, pages: params.pages, zeroBased: true }
  )
  return { feed, jobs: items, ...rest }
}

/** Explore's Styles: style codes (srefs) by search (words or a code) or by feed. */
export async function exploreStyles(params: { query?: string; feed?: string; page?: number; pages?: number }) {
  const raw = typeof params.query === "string" ? params.query.trim().replace(/^--sref\s+/, "") : ""
  if (raw) {
    // The site searches a code as "0_<code>", and words as they are.
    const prompt = /^(?:0_)?\d+$/.test(raw) ? (raw.startsWith("0_") ? raw : `0_${raw}`) : raw
    const { items, ...rest } = await fetchPages(
      "Styles search",
      "/api/styles-vector-search",
      { prompt, _ql: "explore" },
      { page: params.page, pages: params.pages, zeroBased: false }
    )
    return { query: raw, styles: items, ...rest }
  }
  const feed = params.feed ?? "styles_top"
  if (!(STYLE_FEEDS as readonly string[]).includes(feed)) {
    throw new Error(`Unknown Styles feed "${feed}". Use one of: ${STYLE_FEEDS.join(", ")}.`)
  }
  const { items, ...rest } = await fetchPages(
    "Explore Styles",
    "/api/explore-srefs",
    { feed, _ql: "explore" },
    { page: params.page, pages: params.pages, zeroBased: true }
  )
  return { feed, styles: items, ...rest }
}
