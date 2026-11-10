// Tests for src/reddit.ts, run against the built files: npm test.
// The listings below have the shape Reddit's search.json and
// comments/<id>.json answer (Nov 2026); ids, names and text are made up.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, test } from "node:test"

import {
  anonymous,
  forgetSearchBlock,
  pagePostOf,
  parsePostRef,
  redditSearch,
  redditThread,
  resolveFolder,
  subredditPath,
  threadOf,
  trimText
} from "../dist/reddit.js"

const listing = (children, after = null) => ({ kind: "Listing", data: { after, before: null, children } })

const post = (overrides = {}) => ({
  kind: "t3",
  data: {
    id: "1abc2de",
    name: "t3_1abc2de",
    title: "Chip maker CEO caught in a tabloid storm",
    subreddit: "technology",
    author: "SomeRealPerson",
    score: 4210,
    upvote_ratio: 0.93,
    num_comments: 812,
    created_utc: 1762790400,
    permalink: "/r/technology/comments/1abc2de/chip_maker_ceo_caught_in_a_tabloid_storm/",
    url: "https://example.com/story",
    domain: "example.com",
    selftext: "",
    link_flair_text: "Business",
    over_18: false,
    ...overrides
  }
})

const comment = (id, author, body, overrides = {}, replies = "") => ({
  kind: "t1",
  data: {
    id,
    author,
    body,
    score: 100,
    depth: 0,
    created_utc: 1762794000,
    permalink: `/r/technology/comments/1abc2de/x/${id}/`,
    is_submitter: false,
    stickied: false,
    distinguished: null,
    controversiality: 0,
    edited: false,
    replies,
    ...overrides
  }
})

const more = (count, depth = 0) => ({ kind: "more", data: { count, depth, children: ["zz1", "zz2"] } })

const thread = () => [
  listing([post({ selftext: "The post's own text. ".repeat(10) })]),
  listing([
    comment("mod1", "AutoModerator", "Please keep it civil.", { stickied: true, distinguished: "moderator" }),
    comment(
      "c1",
      "alice_real",
      "He spent the GPU budget on something else.",
      { score: 900 },
      listing([
        comment("c1r1", "bob_real", "Leather jacket stays on though.", { depth: 1, score: 300 }),
        comment("c1r2", "SomeRealPerson", "OP here, sources in the post.", { depth: 1, is_submitter: true, score: 50 }),
        comment("c1r3", "carol_real", "Third reply.", { depth: 1, score: 10 }),
        more(7, 1)
      ])
    ),
    comment("c2", "[deleted]", "[removed]"),
    comment("c3", "alice_real", "Same person again, later.", { score: 400, controversiality: 1 }),
    comment("c4", "dave_real", "Fourth top-level take.", { score: 5 }),
    more(120)
  ])
]

const pagePostRow = (overrides = {}) => ({
  id: "1abc2de",
  title: "Chip maker CEO caught in a tabloid storm",
  permalink: "/r/technology/comments/1abc2de/chip_maker_ceo_caught_in_a_tabloid_storm/",
  subreddit: "technology",
  score: 17020,
  numComments: 1071,
  createdAt: "2026-11-10T00:43:25+00:00",
  url: "https://www.example.com/story",
  ...overrides
})

const NAMES = /alice_real|bob_real|carol_real|dave_real|SomeRealPerson|AutoModerator/

describe("links and names", () => {
  test("post links, comment links, short links and ids", () => {
    assert.deepEqual(parsePostRef("https://www.reddit.com/r/nvidia/comments/1abc2de/some_title/"), { postId: "1abc2de" })
    assert.deepEqual(parsePostRef("old.reddit.com/r/nvidia/comments/1ABC2DE"), { postId: "1abc2de" })
    assert.deepEqual(parsePostRef("https://www.reddit.com/r/nvidia/comments/1abc2de/some_title/mx9k2zq/?context=3"), {
      postId: "1abc2de",
      commentId: "mx9k2zq"
    })
    assert.deepEqual(parsePostRef("https://www.reddit.com/r/nvidia/comments/1abc2de/comment/mx9k2zq/"), {
      postId: "1abc2de",
      commentId: "mx9k2zq"
    })
    assert.deepEqual(parsePostRef("https://www.reddit.com/r/SipsTea/comments/1xrjfv0/a_title/19sd12haxditf/"), {
      postId: "1xrjfv0",
      commentId: "19sd12haxditf"
    })
    assert.deepEqual(parsePostRef("https://redd.it/1abc2de"), { postId: "1abc2de" })
    assert.deepEqual(parsePostRef("t3_1abc2de"), { postId: "1abc2de" })
    assert.deepEqual(parsePostRef("1abc2de"), { postId: "1abc2de" })
    assert.deepEqual(parsePostRef("https://www.reddit.com/r/nvidia/s/AbCdEf123"), {
      share: "https://www.reddit.com/r/nvidia/s/AbCdEf123"
    })
    assert.equal(parsePostRef("https://example.com/r/x/comments/1abc2de"), undefined)
    assert.equal(parsePostRef("https://www.reddit.com/r/nvidia/"), undefined)
    assert.equal(parsePostRef("not a link at all"), undefined)
  })

  test("subreddits become one /r/a+b path", () => {
    assert.equal(subredditPath([]), "")
    assert.equal(subredditPath(["nvidia", "r/technology", "/r/nvidia/"]), "/r/nvidia+technology")
    assert.throws(() => subredditPath(["no spaces"]), /Not subreddit names: no spaces/)
  })

  test("text is cut on a word, with an ellipsis", () => {
    assert.deepEqual(trimText("short", 10), { text: "short", cut: false })
    assert.deepEqual(trimText("one two three four five", 15), { text: "one two three…", cut: true })
    // No space near the end: cut where it falls.
    assert.deepEqual(trimText("abcdefghij klm", 8), { text: "abcdefgh…", cut: true })
    assert.deepEqual(trimText("anything", 0), { text: "anything", cut: false })
  })

  test("authors become per-thread labels", () => {
    const a = anonymous("1abc2de", "alice_real")
    assert.match(a, /^user-[0-9a-f]{6}$/)
    assert.equal(anonymous("1abc2de", "Alice_Real"), a)
    assert.notEqual(anonymous("9zzz9zz", "alice_real"), a)
    assert.notEqual(anonymous("1abc2de", "bob_real"), a)
    assert.equal(anonymous("1abc2de", "[deleted]"), "[deleted]")
    assert.equal(anonymous("1abc2de", undefined), "[deleted]")
  })

  test("search page posts take the same shape as search.json's", () => {
    const post = pagePostOf(pagePostRow({ selftext: "word ".repeat(100), nsfw: true }), 20)
    assert.equal(post.permalink, "https://www.reddit.com/r/technology/comments/1abc2de/chip_maker_ceo_caught_in_a_tabloid_storm/")
    assert.equal(post.selftextCut, true)
    assert.equal(post.nsfw, true)
    assert.equal(pagePostOf({ title: "no id" }, 0), undefined)
  })

  test("saveTo must be absolute or start with ~/", () => {
    assert.equal(resolveFolder("~/research", "/Users/me"), "/Users/me/research")
    assert.equal(resolveFolder("/tmp/x/../y"), "/tmp/y")
    assert.throws(() => resolveFolder("research/reddit"), /absolute folder/)
  })
})

describe("threads", () => {
  test("the post and its top comments, trimmed, with no usernames", () => {
    const result = threadOf(thread(), { limit: 2, replies: 2, depth: 1, bodyChars: 400, selftextChars: 50 })
    assert.equal(result.post.id, "1abc2de")
    assert.equal(result.post.selftextCut, true)
    assert.ok(result.post.selftext.length <= 51)
    assert.equal(result.commentsInThread, 812)
    assert.deepEqual(result.skipped, { stickied: 1, removed: 1 })
    assert.deepEqual(result.comments.map((c) => c.id), ["c1", "c3"])
    // c4 and the 120 collapsed ones.
    assert.equal(result.topLevelNotShown, 121)
    const [first, second] = result.comments
    assert.equal(first.replies, 10)
    assert.deepEqual(first.children.map((c) => c.id), ["c1r1", "c1r2"])
    assert.equal(first.children[1].op, true)
    assert.equal(first.permalink, "https://www.reddit.com/r/technology/comments/1abc2de/x/c1/")
    assert.equal(first.author, second.author, "one person keeps one label through the thread")
    assert.equal(second.controversial, true)
    assert.equal(result.commentsShown, 4)
    assert.doesNotMatch(JSON.stringify(result), NAMES)
  })

  test("depth 0 or replies 0 leaves the replies out", () => {
    for (const options of [{ depth: 0, replies: 2 }, { depth: 3, replies: 0 }]) {
      const result = threadOf(thread(), { limit: 5, bodyChars: 400, selftextChars: 0, ...options })
      assert.equal(result.comments[0].children, undefined)
      assert.equal(result.comments[0].replies, 10)
    }
  })

  test("an answer without a post is an error", () => {
    assert.throws(() => threadOf({ error: 404 }, { limit: 5, replies: 0, depth: 0, bodyChars: 0, selftextChars: 0 }), /no post/)
  })
})

// Records every call; answers from `answers[method](params)`.
function fakeBridge(answers = {}) {
  const calls = []
  return {
    calls,
    call: async (method, params) => {
      calls.push({ method, params })
      const answer = answers[method]
      if (!answer) throw new Error(`Unknown method: ${method}`)
      return answer(params)
    }
  }
}

describe("reddit_search and reddit_thread", () => {
  let dir
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reddit-test-"))
    forgetSearchBlock()
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("a search asks search.json with Reddit's own parameters", async () => {
    const bridge = fakeBridge({
      "reddit.json": () => ({ url: "https://www.reddit.com/search.json?q=x", status: 200, data: listing([post()], "t3_next") })
    })
    const answer = await redditSearch(bridge, { query: "jensen huang affair", sort: "top", time: "week", limit: 1 })
    assert.equal(bridge.calls.length, 1)
    assert.deepEqual(bridge.calls[0].params, {
      path: "/search.json",
      query: { q: "jensen huang affair", sort: "top", t: "week", limit: 1, type: "link", raw_json: 1 }
    })
    assert.equal(answer.found, 1)
    assert.equal(answer.after, "t3_next")
    assert.deepEqual(answer.posts[0], {
      id: "1abc2de",
      title: "Chip maker CEO caught in a tabloid storm",
      subreddit: "technology",
      score: 4210,
      upvoteRatio: 0.93,
      numComments: 812,
      createdAt: "2025-11-10T16:00:00.000Z",
      permalink: "https://www.reddit.com/r/technology/comments/1abc2de/chip_maker_ceo_caught_in_a_tabloid_storm/",
      url: "https://example.com/story",
      domain: "example.com",
      flair: "Business",
      removed: undefined
    })
    assert.doesNotMatch(JSON.stringify(answer), NAMES)
  })

  test("subreddits restrict the search; more than 100 reads the next pages", async () => {
    let page = 0
    const bridge = fakeBridge({
      "reddit.json": (params) => {
        page++
        const posts = Array.from({ length: params.query.limit }, (_, i) => post({ id: `p${page}x${i}` }))
        return { url: `u${page}`, status: 200, data: listing(posts, page < 3 ? `t3_after${page}` : null) }
      }
    })
    const answer = await redditSearch(bridge, { query: "x", subreddits: ["nvidia", "technology"], limit: 150 })
    assert.equal(bridge.calls.length, 2)
    assert.equal(bridge.calls[0].params.path, "/r/nvidia+technology/search.json")
    assert.equal(bridge.calls[0].params.query.restrict_sr, "on")
    assert.equal(bridge.calls[0].params.query.limit, 100)
    assert.equal(bridge.calls[1].params.query.after, "t3_after1")
    assert.equal(bridge.calls[1].params.query.limit, 50)
    assert.deepEqual(answer.subreddits, ["nvidia", "technology"])
    assert.equal(answer.found, 150)
    assert.equal(answer.after, "t3_after2")
  })

  test("saveTo keeps Reddit's raw answer, the request and the result, never overwriting", async () => {
    const raw = listing([post()])
    const bridge = fakeBridge({
      "reddit.json": () => ({ url: "https://www.reddit.com/search.json?q=jensen", status: 200, data: raw })
    })
    const first = await redditSearch(bridge, { query: "Jensen Huang affair", sort: "top", time: "week", saveTo: dir })
    const second = await redditSearch(bridge, { query: "Jensen Huang affair", sort: "top", time: "week", saveTo: dir })
    assert.match(first.saved, /reddit-search-jensen-huang-affair-top-week-\d{4}-\d{2}-\d{2}\.json$/)
    assert.match(second.saved, /-2\.json$/)
    const file = JSON.parse(readFileSync(first.saved, "utf8"))
    assert.equal(file.schema, "browse-hack.reddit/v1")
    assert.equal(file.tool, "reddit_search")
    assert.deepEqual(file.requests, ["https://www.reddit.com/search.json?q=jensen"])
    assert.deepEqual(file.raw, raw)
    assert.equal(file.result.posts[0].id, "1abc2de")
    assert.equal(file.params.saveTo, undefined)
  })


  test("when Reddit blocks search.json, the search page answers, and later searches go straight there", async () => {
    const blocked = () => {
      throw new Error("Reddit answered a page instead of JSON (403) for https://www.reddit.com/search.json?q=x: You've been blocked by network security.")
    }
    const page = (params) => ({
      url: `https://old.reddit.com${params.path}?q=x`,
      status: 200,
      posts: [pagePostRow(), pagePostRow({ id: "2xyz3ab", title: "Second" })],
      after: "t3_2xyz3ab",
      html: params.keepHtml ? "<html>results</html>" : undefined
    })
    const bridge = fakeBridge({ "reddit.json": blocked, "reddit.searchPage": page })
    const answer = await redditSearch(bridge, { query: "x", subreddits: ["nvidia"], sort: "top", time: "week", limit: 2, saveTo: dir })
    assert.deepEqual(bridge.calls.map((c) => c.method), ["reddit.json", "reddit.searchPage"])
    assert.deepEqual(bridge.calls[1].params, {
      path: "/r/nvidia/search",
      query: { q: "x", sort: "top", t: "week", limit: 2, type: "link", restrict_sr: "on" },
      keepHtml: true
    })
    assert.equal(answer.source, "search page")
    assert.match(answer.sourceNote, /blocks search\.json/)
    assert.deepEqual(answer.posts.map((p) => p.id), ["1abc2de", "2xyz3ab"])
    assert.equal(answer.posts[0].domain, "example.com")
    assert.equal(answer.posts[0].createdAt, "2026-11-10T00:43:25.000Z")
    const file = JSON.parse(readFileSync(answer.saved, "utf8"))
    assert.deepEqual(file.htmlFiles, [answer.saved.replace(/\.json$/, ".html")])
    assert.equal(readFileSync(file.htmlFiles[0], "utf8"), "<html>results</html>")

    // Straight to the page; its second page repeats the first, which ends the search.
    await redditSearch(bridge, { query: "y" })
    assert.deepEqual(bridge.calls.slice(2).map((c) => c.method), ["reddit.searchPage", "reddit.searchPage"])
    assert.equal(bridge.calls[3].params.query.after, "t3_2xyz3ab")
  })

  test("other search.json errors aren't hidden by the fallback", async () => {
    const bridge = fakeBridge({
      "reddit.json": () => {
        throw new Error("Reddit is rate-limiting this browser (429). Wait 60 s and try again.")
      }
    })
    await assert.rejects(redditSearch(bridge, { query: "x" }), /rate-limiting/)
  })

  test("a thread asks comments/<id>.json in the sort asked for", async () => {
    const bridge = fakeBridge({ "reddit.json": () => ({ url: "u", status: 200, data: thread() }) })
    const answer = await redditThread(bridge, {
      post: "https://www.reddit.com/r/technology/comments/1abc2de/title/",
      sort: "best",
      limit: 3,
      saveTo: dir
    })
    assert.deepEqual(bridge.calls[0].params, {
      path: "/comments/1abc2de.json",
      query: { sort: "confidence", limit: 100, depth: 3, raw_json: 1 }
    })
    assert.equal(answer.sort, "best")
    assert.deepEqual(answer.comments.map((c) => c.id), ["c1", "c3", "c4"])
    assert.match(answer.saved, /reddit-thread-1abc2de-chip-maker-ceo-caught-in-a-tabloid-storm\.json$/)
    assert.doesNotMatch(JSON.stringify(answer), NAMES)
  })

  test("a comment's permalink reads that comment; a share link is followed first", async () => {
    const bridge = fakeBridge({
      "reddit.resolve": () => ({ url: "https://www.reddit.com/r/technology/comments/1abc2de/title/c1zz9q/?share_id=x" }),
      "reddit.json": () => ({ url: "u", status: 200, data: thread() })
    })
    const answer = await redditThread(bridge, { post: "https://www.reddit.com/r/technology/s/AbCdEf123" })
    assert.deepEqual(bridge.calls.map((c) => c.method), ["reddit.resolve", "reddit.json"])
    assert.equal(bridge.calls[1].params.path, "/comments/1abc2de/_/c1zz9q.json")
    assert.equal(answer.comment, "c1zz9q")
  })

  test("bad input and an older extension say what to do", async () => {
    await assert.rejects(redditThread(fakeBridge(), { post: "https://example.com/x" }), /isn't a Reddit post/)
    await assert.rejects(redditSearch(fakeBridge(), { query: "x" }), /Browse Hack 0\.19\.0 or later.*update_browse_hack/)
  })
})
