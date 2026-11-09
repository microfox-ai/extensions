// Tests for keeping Pinterest bulk sessions small in chrome.storage.session: npm test.
// On 9 Nov 2026, 18 finished sessions left in open tabs filled its 10 MB (each kept its list of the media
// library's ~6,700 pin refs) and no new session could start.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  bulkSessionKey,
  bulkSkipKey,
  isQuotaError,
  pagesVisited,
  prunableKeys,
  retireSession
} from "./pinterestBulk.ts"

// chrome.storage.session.QUOTA_BYTES, counted the way Chrome does: each key plus its value as JSON.
const QUOTA_BYTES = 10 * 1024 * 1024
const bytes = (items) =>
  Object.entries(items).reduce((sum, [key, value]) => sum + key.length + JSON.stringify(value).length, 0)

const hash = (n) => n.toString(16).padStart(32, "0")
const LIBRARY_PINS = Array.from({ length: 6700 }, (_, n) => hash(n))
const LIBRARY_VIDEOS = LIBRARY_PINS.slice(0, 400)

// A session as it looks after a long research run: 12 pages, 1,500 pins seen, 600 saved, 900 the library had.
// With its skip list that is about 600 KB, so 17 of them fill the 10 MB, as 18 did on 9 Nov.
function finishedSession(tabId) {
  const pageUrl = (p) => `https://www.pinterest.com/search/pins/?q=kinetic%20type%20poster%20${p}&rs=typed`
  const pages = Object.fromEntries(
    Array.from({ length: 12 }, (_, p) => [`/search/pins/?q=kinetic${p}`, { images: 25, videos: 3, url: pageUrl(p), at: 1 }])
  )
  const id = (n) => `ab/cd/ef/${hash(100_000 + tabId * 1000 + n)}.jpg`
  return {
    tabId,
    active: true,
    destination: "browser",
    folder: `Users/x/Downloads/_INBOX/pinterest/2026-11-09-kinetic-type-${tabId}`,
    includeVideos: true,
    videoFolder: `Users/x/Downloads/_INBOX/pinterest/2026-11-09-kinetic-type-${tabId}/videos`,
    tags: ["pinterest"],
    perPageLimit: 25,
    startedAt: 1,
    pages,
    currentPage: "/search/pins/?q=kinetic11",
    currentPageRevisited: false,
    seen: Array.from({ length: 1500 }, (_, n) => `image:${id(n)}`),
    pending: [],
    saved: 600,
    savedVideos: 6,
    failed: 2,
    manifest: true,
    saves: Array.from({ length: 600 }, (_, n) => ({
      file: `_INBOX/pinterest/2026-11-09-kinetic-type-${tabId}/${hash(n)}.jpg`,
      downloadId: n,
      url: `https://i.pinimg.com/originals/${id(n)}`,
      id: hash(n),
      pageUrl: pageUrl(n % 12),
      at: 1
    })),
    skipped: Array.from({ length: 900 }, (_, n) => ({ id: hash(n), pageUrl: pageUrl(n % 12), at: 1 })),
    skipping: LIBRARY_PINS.length
  }
}

describe("retireSession", () => {
  test("keeps the counts the popup and pinterest_bulk_status show, and drops the lists", () => {
    const session = retireSession(finishedSession(7), 123)
    assert.equal(session.active, false)
    assert.equal(session.stoppedAt, 123)
    assert.deepEqual(
      [session.saved, session.savedVideos, session.failed, session.pagesVisited, session.skippedInLibrary],
      [600, 6, 2, 12, 900]
    )
    assert.equal(pagesVisited(session), 12)
    assert.deepEqual([session.seen, session.pending, session.pages, session.currentPage], [[], [], {}, null])
    assert.equal("saves" in session, false)
    assert.equal("skipped" in session, false)
    assert.equal("skipping" in session, false)
  })

  test("a retired session takes under 1 KB, its running self over 100 KB", () => {
    assert.ok(bytes({ [bulkSessionKey(7)]: finishedSession(7) }) > 100_000)
    assert.ok(bytes({ [bulkSessionKey(7)]: retireSession(finishedSession(7)) }) < 1024)
  })

  test("retiring twice keeps the counts", () => {
    const session = retireSession(retireSession(finishedSession(7), 1), 2)
    assert.deepEqual([session.pagesVisited, session.skippedInLibrary, session.stoppedAt], [12, 900, 1])
  })
})

describe("prunableKeys", () => {
  const stored = (sessions) =>
    Object.fromEntries(
      sessions.flatMap((session) => [
        [bulkSessionKey(session.tabId), session],
        [bulkSkipKey(session.tabId), { pins: ["a"] }]
      ])
    )

  test("drops the stopped sessions of other tabs and their skip lists, keeps running ones", () => {
    const running = finishedSession(1)
    const stopped = { ...finishedSession(2), active: false }
    const all = { ...stored([running, stopped]), pinterestBulkPrefs: { folder: "x" }, mcpOpenedTabs: [1, 2] }
    const { keys, tabs } = prunableKeys(all, { openTabs: new Set([1, 2]) })
    assert.deepEqual(keys.sort(), [bulkSessionKey(2), bulkSkipKey(2)].sort())
    assert.deepEqual(tabs, [2])
  })

  test("drops a session whose tab is gone, even one still marked running", () => {
    const { keys } = prunableKeys(stored([finishedSession(3)]), { openTabs: new Set() })
    assert.deepEqual(keys.sort(), [bulkSessionKey(3), bulkSkipKey(3)].sort())
  })

  test("drops a skip list no running session uses", () => {
    const all = { ...stored([finishedSession(1)]), [bulkSkipKey(9)]: { pins: ["a"] } }
    assert.deepEqual(prunableKeys(all, { openTabs: new Set([1]) }).keys, [bulkSkipKey(9)])
  })

  test("keeps the tab being started, and stopped sessions still saving", () => {
    const all = stored([{ ...finishedSession(4), active: false }, { ...finishedSession(5), active: false }])
    const { keys } = prunableKeys(all, { keepTabId: 4, openTabs: new Set([4, 5]), busyTabs: new Set([5]) })
    assert.deepEqual(keys, [])
  })
})

describe("chrome.storage.session over 25 research runs", () => {
  // Each run starts a session in a new tab (skip list + session), collects, and stops; every tab stays open.
  function runs(count, stop) {
    const storage = {}
    for (let tabId = 1; tabId <= count; tabId++) {
      const next = {
        ...storage,
        [bulkSkipKey(tabId)]: { pins: LIBRARY_PINS, videos: LIBRARY_VIDEOS },
        [bulkSessionKey(tabId)]: finishedSession(tabId)
      }
      if (bytes(next) > QUOTA_BYTES) return { failedAt: tabId, bytes: bytes(storage) }
      Object.assign(storage, next)
      stop(storage, tabId)
    }
    return { bytes: bytes(storage) }
  }

  test("before: stopping only marked a session inactive, so the 10 MB filled up", () => {
    const { failedAt } = runs(25, (storage, tabId) => {
      storage[bulkSessionKey(tabId)].active = false
    })
    assert.ok(failedAt >= 15 && failedAt <= 20, `expected a quota error near run 18, got ${failedAt}`)
  })

  test("now: a stop retires the session and drops its skip list, so 100 runs take under 100 KB", () => {
    const { failedAt, bytes: used } = runs(100, (storage, tabId) => {
      retireSession(storage[bulkSessionKey(tabId)])
      delete storage[bulkSkipKey(tabId)]
    })
    assert.equal(failedAt, undefined)
    assert.ok(used < 100_000, `${used} bytes`)
  })
})

test("isQuotaError knows Chrome's message", () => {
  assert.ok(isQuotaError(new Error("Session storage quota bytes exceeded. Values were not stored.")))
  assert.ok(!isQuotaError(new Error("No tab with id: 5.")))
})
