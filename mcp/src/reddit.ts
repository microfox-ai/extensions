// Reddit from Claude: search posts and read comment threads through Reddit's
// public JSON, fetched by the extension inside a reddit.com tab of the user's
// Chrome (get-into-zone/lib/reddit.ts), since from a script Reddit answers its
// bot wall. The extension sends one request at a time with a pause between
// them; this file builds the requests, shapes the answers and saves them.
//
// Usernames never leave this file: posts carry no author, and each comment's
// author is a short label hashed from the thread and the name, the same for
// one person all through a thread (so replies from the original poster or a
// back-and-forth can be followed) but meaningless outside it. The raw JSON,
// saved only when asked, is Reddit's answer as it came, for citing later.

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import type { Bridge } from "./bridge.js"
import { localDate } from "./library.js"

const SITE = "https://www.reddit.com"
const NEEDS_EXTENSION = "0.19.0"
const SCHEMA = "browse-hack.reddit/v1"
// Each extension call can wait behind others (one request at a time) and for
// Reddit's rate-limit window.
const CALL_MS = 150_000

export const SEARCH_SORTS = ["relevance", "top", "new", "comments", "hot"] as const
export const TIMES = ["hour", "day", "week", "month", "year", "all"] as const
export const THREAD_SORTS = ["top", "best", "controversial", "new", "old", "qa"] as const

type Fetched = { url: string; status: number; data: any; rateLimit?: Record<string, number>; tabId?: number; openedTab?: boolean }

/** The extension's error for a method it doesn't have, as an update to ask for. */
async function call<T>(bridge: Bridge, method: string, params: Record<string, unknown>) {
  try {
    return (await bridge.call(method, params, CALL_MS)) as T
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Unknown method/i.test(message)) {
      throw new Error(`This needs Browse Hack ${NEEDS_EXTENSION} or later in Chrome. Call update_browse_hack, then try again.`)
    }
    throw error
  }
}

// --- Shaping -------------------------------------------------------------------

const str = (value: unknown) => (typeof value === "string" ? value : "")
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const iso = (seconds: unknown) => {
  const s = num(seconds)
  return s === undefined ? undefined : new Date(s * 1000).toISOString()
}
const full = (permalink: unknown) => {
  const path = str(permalink)
  return path.startsWith("http") ? path : path ? `${SITE}${path}` : undefined
}

/** Text cut to `chars` (on a word when it can), with whether it was cut. */
export function trimText(value: unknown, chars: number): { text: string; cut: boolean } {
  const text = str(value).replace(/\r\n/g, "\n").trim()
  if (chars <= 0 || text.length <= chars) return { text, cut: false }
  const head = text.slice(0, chars)
  const space = head.lastIndexOf(" ")
  return { text: `${(space > chars * 0.6 ? head.slice(0, space) : head).trimEnd()}…`, cut: true }
}

export interface RedditPost {
  id: string
  title: string
  subreddit: string
  score?: number
  upvoteRatio?: number
  numComments?: number
  createdAt?: string
  permalink?: string
  /** Where a link post points (the post itself for text posts). */
  url?: string
  domain?: string
  selftext?: string
  selftextCut?: boolean
  flair?: string
  nsfw?: boolean
  locked?: boolean
  removed?: string
}

export function postOf(data: any, selftextChars: number): RedditPost | undefined {
  const id = str(data?.id)
  if (!id) return undefined
  const selftext = trimText(data.selftext, selftextChars)
  const url = str(data.url_overridden_by_dest) || str(data.url)
  return {
    id,
    title: str(data.title),
    subreddit: str(data.subreddit),
    score: num(data.score),
    upvoteRatio: num(data.upvote_ratio),
    numComments: num(data.num_comments),
    createdAt: iso(data.created_utc),
    permalink: full(data.permalink),
    url: url ? full(url) : undefined,
    domain: str(data.domain) || undefined,
    ...(selftext.text ? { selftext: selftext.text, ...(selftext.cut ? { selftextCut: true } : {}) } : {}),
    flair: str(data.link_flair_text) || undefined,
    ...(data.over_18 ? { nsfw: true } : {}),
    ...(data.locked ? { locked: true } : {}),
    removed: str(data.removed_by_category) || undefined
  }
}

const GONE = new Set(["[deleted]", "[removed]"])

/** A per-thread label for an author: "user-3fa2c1". Deleted accounts stay "[deleted]". */
export function anonymous(threadId: string, author: unknown) {
  const name = str(author)
  if (!name || GONE.has(name)) return "[deleted]"
  return `user-${createHash("sha256").update(`${threadId}:${name.toLowerCase()}`).digest("hex").slice(0, 6)}`
}

export interface RedditComment {
  id: string
  author: string
  /** Written by the post's author. */
  op?: boolean
  body: string
  bodyCut?: boolean
  score?: number
  depth: number
  createdAt?: string
  permalink?: string
  /** Direct replies Reddit knows of (loaded and collapsed), whether shown or not. */
  replies: number
  edited?: boolean
  controversial?: boolean
  /** Its top replies, up to `replies` of them, to `depth` levels. */
  children?: RedditComment[]
}

interface TreeOptions {
  threadId: string
  bodyChars: number
  limit: number
  replies: number
  depth: number
}

interface Tally {
  shown: number
  skipped: { stickied: number; removed: number }
}

const childrenOf = (listing: any): any[] => (Array.isArray(listing?.data?.children) ? listing.data.children : [])

/** Direct replies Reddit knows of under a listing: loaded comments plus the count of collapsed ones. */
function replyCount(listing: any) {
  let count = 0
  for (const child of childrenOf(listing)) {
    if (child?.kind === "t1") count++
    else if (child?.kind === "more") count += num(child.data?.count) ?? 0
  }
  return count
}

/** Up to `perLevel` comments of a listing, in Reddit's order (the sort asked for), with their top replies. */
function commentsOf(listing: any, options: TreeOptions, perLevel: number, levelsLeft: number, tally: Tally) {
  const comments: RedditComment[] = []
  let notShown = 0
  for (const child of childrenOf(listing)) {
    if (child?.kind === "more") {
      notShown += num(child.data?.count) ?? 0
      continue
    }
    if (child?.kind !== "t1") continue
    const data = child.data ?? {}
    const body = str(data.body)
    const repliesKnown = replyCount(data.replies)
    // Moderators' pinned notes (rules, AutoModerator) aren't anyone's take.
    if (data.stickied && (data.distinguished === "moderator" || data.author === "AutoModerator")) {
      tally.skipped.stickied++
      continue
    }
    if (GONE.has(body.trim()) && !repliesKnown) {
      tally.skipped.removed++
      continue
    }
    if (comments.length >= perLevel) {
      notShown++
      continue
    }
    const text = trimText(body, options.bodyChars)
    const comment: RedditComment = {
      id: str(data.id),
      author: anonymous(options.threadId, data.author),
      ...(data.is_submitter ? { op: true } : {}),
      body: text.text,
      ...(text.cut ? { bodyCut: true } : {}),
      score: data.score_hidden ? undefined : num(data.score),
      depth: num(data.depth) ?? 0,
      createdAt: iso(data.created_utc),
      permalink: full(data.permalink),
      replies: repliesKnown,
      ...(data.edited ? { edited: true } : {}),
      ...(num(data.controversiality) ? { controversial: true } : {})
    }
    tally.shown++
    if (levelsLeft > 0 && options.replies > 0 && repliesKnown) {
      const below = commentsOf(data.replies, options, options.replies, levelsLeft - 1, tally)
      if (below.comments.length) comment.children = below.comments
    }
    comments.push(comment)
  }
  return { comments, notShown }
}

/** A thread's JSON ([post listing, comment listing]) as its post and its top comments. */
export function threadOf(raw: any, options: Omit<TreeOptions, "threadId"> & { selftextChars: number }) {
  const [postListing, commentListing] = Array.isArray(raw) ? raw : []
  const post = postOf(childrenOf(postListing)[0]?.data, options.selftextChars)
  if (!post) throw new Error("Reddit's answer had no post in it.")
  const tally: Tally = { shown: 0, skipped: { stickied: 0, removed: 0 } }
  const { comments, notShown } = commentsOf(
    commentListing,
    { ...options, threadId: post.id },
    options.limit,
    options.depth,
    tally
  )
  return {
    post,
    commentsInThread: post.numComments,
    commentsShown: tally.shown,
    topLevelNotShown: notShown,
    ...(tally.skipped.stickied || tally.skipped.removed ? { skipped: tally.skipped } : {}),
    comments
  }
}

// --- Links -------------------------------------------------------------------

/**
 * A post from a link or id: reddit.com/r/<sub>/comments/<id>/<slug>/[<comment>],
 * old./new./np. links, redd.it/<id>, "t3_<id>" or "<id>". Share links
 * (reddit.com/r/<sub>/s/<code>) come back as { share } to be followed first.
 */
export function parsePostRef(value: string): { postId: string; commentId?: string } | { share: string } | undefined {
  const input = value.trim()
  const bare = /^(?:t3_)?([a-z0-9]{4,16})$/i.exec(input)
  if (bare) return { postId: bare[1].toLowerCase() }
  let url: URL
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`)
  } catch {
    return undefined
  }
  const host = url.hostname.toLowerCase()
  if (host === "redd.it" || host.endsWith(".redd.it")) {
    const id = /^\/([a-z0-9]{4,16})\/?$/i.exec(url.pathname)?.[1]
    return id ? { postId: id.toLowerCase() } : undefined
  }
  if (!(host === "reddit.com" || host.endsWith(".reddit.com"))) return undefined
  if (/^\/r\/[^/]+\/s\/[^/]+\/?$/i.test(url.pathname)) return { share: `${SITE}${url.pathname}` }
  // Comment ids are 13 characters since 2026 ("19sd12haxditf"), post ids 7.
  const match = /\/comments\/([a-z0-9]{4,16})(?:\/[^/]*(?:\/([a-z0-9]{4,16}))?)?/i.exec(url.pathname)
  if (!match) return undefined
  return { postId: match[1].toLowerCase(), ...(match[2] ? { commentId: match[2].toLowerCase() } : {}) }
}

const SUBREDDIT = /^[A-Za-z0-9_]{2,21}$/

export function subredditPath(subreddits: string[] = []) {
  const names = subreddits.map((name) => name.trim().replace(/^\/?r\//i, "").replace(/\/$/, "")).filter(Boolean)
  const bad = names.filter((name) => !SUBREDDIT.test(name))
  if (bad.length) throw new Error(`Not subreddit names: ${bad.join(", ")}`)
  return names.length ? `/r/${[...new Set(names)].join("+")}` : ""
}

// --- Saving --------------------------------------------------------------------

const slug = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
    .slice(0, 50)
    .replace(/^-+|-+$/g, "")

export function resolveFolder(folder: string, home = homedir()) {
  const trimmed = folder.trim()
  if (trimmed === "~") return home
  if (trimmed.startsWith("~/")) return resolve(home, trimmed.slice(2))
  if (isAbsolute(trimmed)) return resolve(trimmed)
  throw new Error(`saveTo needs an absolute folder (or one starting with ~/), not "${folder}".`)
}

/**
 * Writes the raw answer and the result into `folder`/<name>.json, and any pages
 * (HTML) beside it as <name>.html (<name>.p2.html …). An existing file is kept:
 * the new one gets -2, -3 …
 */
async function save(folder: string, name: string, record: Record<string, unknown>, pages: string[] = []) {
  const dir = resolveFolder(folder)
  await mkdir(dir, { recursive: true })
  let base = join(dir, name)
  for (let n = 2; existsSync(`${base}.json`); n++) base = join(dir, `${name}-${n}`)
  const htmlFiles = pages.map((_, i) => `${base}${i ? `.p${i + 1}` : ""}.html`)
  await Promise.all(pages.map((html, i) => writeFile(htmlFiles[i], html)))
  const extra = htmlFiles.length ? { htmlFiles } : {}
  await writeFile(`${base}.json`, `${JSON.stringify({ schema: SCHEMA, ...record, ...extra }, null, 2)}\n`)
  return `${base}.json`
}

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

// --- Tools -----------------------------------------------------------------------

export interface SearchParams {
  query: string
  subreddits?: string[]
  sort?: (typeof SEARCH_SORTS)[number]
  time?: (typeof TIMES)[number]
  limit?: number
  after?: string
  includeNsfw?: boolean
  selftextChars?: number
  saveTo?: string
}

/** A post as old.reddit.com's search page shows it (get-into-zone/lib/reddit.ts reads it). */
export interface PagePost {
  id: string
  title: string
  permalink: string
  subreddit?: string
  score?: number
  numComments?: number
  createdAt?: string
  url?: string
  selftext?: string
  flair?: string
  nsfw?: boolean
}

type SearchPage = { url: string; status: number; posts: PagePost[]; after?: string; noResults?: boolean; html?: string; tabId?: number; openedTab?: boolean }

const PAGE = 100

// Reddit answers search.json with "blocked by network security" on some
// networks even when signed in, while its search page still works. Once seen,
// this server goes straight to the page for a while.
const JSON_BLOCKED_MS = 30 * 60_000
let jsonSearchBlockedUntil = 0
const isJsonBlock = (error: unknown) =>
  /answered a page instead of JSON \(403/.test(error instanceof Error ? error.message : String(error))

/** Forgets that search.json was blocked (for tests). */
export const forgetSearchBlock = () => {
  jsonSearchBlockedUntil = 0
}

const domainOf = (url?: string) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : undefined
  } catch {
    return undefined
  }
}

export function pagePostOf(post: PagePost, selftextChars: number): RedditPost | undefined {
  const id = str(post?.id)
  if (!id) return undefined
  const selftext = trimText(post.selftext, selftextChars)
  const url = post.url ? full(post.url) : undefined
  const created = post.createdAt ? Date.parse(post.createdAt) : NaN
  return {
    id,
    title: str(post.title),
    subreddit: str(post.subreddit),
    score: num(post.score),
    numComments: num(post.numComments),
    createdAt: Number.isFinite(created) ? new Date(created).toISOString() : undefined,
    permalink: full(post.permalink),
    url,
    domain: domainOf(url),
    ...(selftext.text ? { selftext: selftext.text, ...(selftext.cut ? { selftextCut: true } : {}) } : {}),
    flair: str(post.flair) || undefined,
    ...(post.nsfw ? { nsfw: true } : {})
  }
}

export async function redditSearch(bridge: Bridge, params: SearchParams) {
  const query = str(params.query).trim()
  if (!query) throw new Error("Pass a query.")
  const sort = params.sort ?? "relevance"
  const time = params.time ?? "all"
  const limit = clamp(params.limit, 1, 250, 25)
  const selftextChars = clamp(params.selftextChars, 0, 10_000, 300)
  const subs = subredditPath(params.subreddits)
  const keepHtml = Boolean(params.saveTo)
  const ask = (after: string | undefined, json: boolean) => ({
    q: query,
    sort,
    t: time,
    limit: Math.min(PAGE, limit - posts.length),
    // Posts only: old Reddit's page otherwise also lists subreddits, out of the same limit.
    type: "link",
    ...(json ? { raw_json: 1 } : {}),
    ...(subs ? { restrict_sr: "on" } : {}),
    ...(params.includeNsfw ? { include_over_18: "on" } : {}),
    ...(after ? { after } : {})
  })

  const posts: RedditPost[] = []
  const seen = new Set<string>()
  const add = (post?: RedditPost) => {
    if (post && !seen.has(post.id)) {
      seen.add(post.id)
      posts.push(post)
    }
  }
  const requests: string[] = []
  const raw: unknown[] = []
  const html: string[] = []
  let source: "search.json" | "search page" = Date.now() < jsonSearchBlockedUntil ? "search page" : "search.json"
  let after = params.after || undefined
  let last: { tabId?: number; openedTab?: boolean } = {}
  for (;;) {
    let count = 0
    const had = posts.length
    const cursor = after
    if (source === "search.json") {
      try {
        const page = await call<Fetched>(bridge, "reddit.json", { path: `${subs}/search.json`, query: ask(after, true) })
        requests.push(page.url)
        raw.push(page.data)
        last = page
        const children = childrenOf(page.data)
        for (const child of children) if (child?.kind === "t3") add(postOf(child.data, selftextChars))
        count = children.length
        after = str(page.data?.data?.after) || undefined
      } catch (error) {
        if (!isJsonBlock(error)) throw error
        jsonSearchBlockedUntil = Date.now() + JSON_BLOCKED_MS
        source = "search page"
        continue
      }
    } else {
      const page = await call<SearchPage>(bridge, "reddit.searchPage", { path: `${subs}/search`, query: ask(after, false), keepHtml })
      requests.push(page.url)
      if (page.html) html.push(page.html)
      raw.push({ url: page.url, posts: page.posts, after: page.after })
      last = page
      for (const post of page.posts ?? []) add(pagePostOf(post, selftextChars))
      count = page.posts?.length ?? 0
      after = page.after || undefined
    }
    // An empty page, one with nothing new or the same cursor again is the end.
    if (!count || posts.length === had || after === cursor) after = undefined
    if (!after || posts.length >= limit) break
  }

  const result = {
    query,
    ...(subs ? { subreddits: subs.slice(3).split("+") } : {}),
    sort,
    time,
    source,
    found: posts.length,
    // Pass as `after` for the next page.
    ...(after ? { after } : {}),
    posts: posts.slice(0, limit),
    ...(source === "search page"
      ? {
          sourceNote:
            "Reddit blocks search.json on this network, so these come from old.reddit.com's search page, in its order " +
            "(no upvote ratio, and text only for posts the page shows it for)."
        }
      : {}),
    ...(last.openedTab ? { note: `Opened a reddit.com tab in the background (tab ${last.tabId}); close_tabs closes it.` } : {})
  }
  if (!params.saveTo) return result
  const saved = await save(
    params.saveTo,
    `reddit-search-${slug(query)}-${sort}-${time}-${localDate()}`,
    {
      tool: "reddit_search",
      fetchedAt: new Date().toISOString(),
      requests,
      params: { ...params, saveTo: undefined },
      result,
      raw: raw.length === 1 ? raw[0] : raw
    },
    html
  )
  return { ...result, saved }
}

export interface ThreadParams {
  post: string
  sort?: (typeof THREAD_SORTS)[number]
  limit?: number
  replies?: number
  depth?: number
  bodyChars?: number
  selftextChars?: number
  saveTo?: string
}

const REDDIT_SORT: Record<string, string> = { best: "confidence" }

export async function redditThread(bridge: Bridge, params: ThreadParams) {
  let ref = parsePostRef(str(params.post))
  if (ref && "share" in ref) {
    const { url } = await call<{ url: string }>(bridge, "reddit.resolve", { url: ref.share })
    ref = parsePostRef(url)
    if (!ref || "share" in ref) throw new Error(`The share link led to ${url}, which isn't a Reddit post.`)
  }
  if (!ref) throw new Error(`"${params.post}" isn't a Reddit post link or id.`)

  const sort = params.sort ?? "top"
  const limit = clamp(params.limit, 1, 100, 25)
  const replies = clamp(params.replies, 0, 20, 2)
  const depth = clamp(params.depth, 0, 8, 1)
  const bodyChars = clamp(params.bodyChars, 0, 10_000, 400)
  const selftextChars = clamp(params.selftextChars, 0, 20_000, 1500)
  // Enough comments to pick the top ones from (Reddit sends up to 500), and
  // one level more than shown, so the deepest comments shown have true reply
  // counts (Reddit sends nothing below the depth asked for).
  const fetchLimit = Math.min(500, Math.max(100, limit * (1 + replies) * (depth + 2)))
  const path = ref.commentId ? `/comments/${ref.postId}/_/${ref.commentId}.json` : `/comments/${ref.postId}.json`

  const page = await call<Fetched>(bridge, "reddit.json", {
    path,
    query: { sort: REDDIT_SORT[sort] ?? sort, limit: fetchLimit, depth: depth + 2, raw_json: 1 }
  })
  const thread = threadOf(page.data, { limit, replies, depth, bodyChars, selftextChars })
  const result = {
    ...(ref.commentId ? { comment: ref.commentId } : {}),
    sort,
    ...thread,
    ...(page.openedTab ? { note: `Opened a reddit.com tab in the background (tab ${page.tabId}); close_tabs closes it.` } : {})
  }
  if (!params.saveTo) return result
  const saved = await save(
    params.saveTo,
    `reddit-thread-${thread.post.id}${ref.commentId ? `-${ref.commentId}` : ""}-${slug(thread.post.title)}`,
    {
      tool: "reddit_thread",
      fetchedAt: new Date().toISOString(),
      requests: [page.url],
      params: { ...params, saveTo: undefined },
      result,
      raw: page.data
    }
  )
  return { ...result, saved }
}
