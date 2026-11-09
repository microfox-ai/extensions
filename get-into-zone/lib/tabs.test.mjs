// Tests for close_tabs closing only the tabs open_tab opened: npm test.
// Chrome's tabs and chrome.storage.session are faked.

import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"

let tabs
let storage
let nextId

globalThis.chrome = {
  tabs: {
    create: async ({ url, active }) => {
      const tab = { id: nextId++, url, active, status: "complete" }
      tabs.set(tab.id, tab)
      return { ...tab }
    },
    get: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`)
      return { ...tabs.get(id) }
    },
    remove: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`)
      tabs.delete(id)
    },
    onUpdated: { addListener() {}, removeListener() {} }
  },
  storage: {
    session: {
      get: async (key) => (key in storage ? { [key]: structuredClone(storage[key]) } : {}),
      set: async (items) => Object.assign(storage, structuredClone(items))
    }
  }
}

const { OPENED_TABS_KEY, closeOpenedTabs, forgetOpenedTab, openTabForClaude, openedTabIds } = await import("./tabs.ts")

beforeEach(() => {
  tabs = new Map([
    [1, { id: 1, url: "https://mail.google.com/", status: "complete" }],
    [2, { id: 2, url: "https://www.pinterest.com/", status: "complete" }]
  ])
  storage = {}
  nextId = 100
})

describe("close_tabs", () => {
  test("closes the tabs open_tab opened and keeps the user's own", async () => {
    const research = await openTabForClaude("https://www.pinterest.com/search/pins/?q=type", false)
    const stopped = []
    const result = await closeOpenedTabs([research.id, 1, 2], async (id) => stopped.push(id))
    assert.deepEqual(result.closed, [research.id])
    assert.deepEqual(
      result.notClosed.map((tab) => tab.tabId),
      [1, 2]
    )
    assert.match(result.notClosed[0].reason, /never closed/)
    assert.deepEqual(stopped, [research.id])
    assert.deepEqual([...tabs.keys()], [1, 2])
    assert.deepEqual(await openedTabIds(), [])
  })

  test("says when a tab is already closed", async () => {
    const research = await openTabForClaude("https://www.pinterest.com/", false)
    tabs.delete(research.id)
    const result = await closeOpenedTabs([research.id])
    assert.deepEqual(result.closed, [])
    assert.match(result.notClosed[0].reason, /No tab/)
  })

  test("remembers every tab when several open at once, and forgets closed ones", async () => {
    const opened = await Promise.all(
      ["a", "b", "c"].map((q) => openTabForClaude(`https://www.pinterest.com/search/pins/?q=${q}`, false))
    )
    assert.deepEqual(storage[OPENED_TABS_KEY].sort(), opened.map((tab) => tab.id).sort())
    await forgetOpenedTab(opened[1].id)
    assert.deepEqual((await openedTabIds()).sort(), [opened[0].id, opened[2].id].sort())
  })

  test("still closes the tab when stopping its session fails", async () => {
    const research = await openTabForClaude("https://www.pinterest.com/", false)
    const result = await closeOpenedTabs([research.id], async () => {
      throw new Error("stop failed")
    })
    // A failed stop still closes the tab: closing it stops the session and writes _session.json too.
    assert.deepEqual(result.closed, [research.id])
  })
})
