// Tests for bringing a Studio tab forward only for a step and putting the user's tab back: npm test.
// Chrome's tabs and windows are faked: one window per array, its first tab active unless set.

import assert from "node:assert/strict"
import { afterEach, beforeEach, describe, mock, test } from "node:test"

let tabs
let windows
let paints
let calls

function fakeChrome() {
  const tab = (id) => tabs.find((item) => item.id === id)
  const activate = (item) => {
    for (const other of tabs) if (other.windowId === item.windowId) other.active = other === item
  }
  return {
    tabs: {
      get: async (id) => {
        const item = tab(id)
        if (!item) throw new Error(`No tab ${id}`)
        return { ...item }
      },
      query: async ({ windowId }) => tabs.filter((item) => item.active && item.windowId === windowId).map((item) => ({ ...item })),
      update: async (id, { active }) => {
        const item = tab(id)
        if (!item) throw new Error(`No tab ${id}`)
        if (active) {
          calls.push(`tab ${id}`)
          activate(item)
        }
        return { ...item }
      },
      remove: async (id) => {
        const item = tab(id)
        tabs = tabs.filter((other) => other !== item)
        // Like Chrome: closing the tab in front shows its neighbour.
        const left = tabs.filter((other) => other.windowId === item.windowId)
        if (item.active && left.length) activate(left[left.length - 1])
      }
    },
    windows: {
      getLastFocused: async () => windows.find((item) => item.focused) || windows[0],
      update: async (id, { focused }) => {
        if (focused) {
          calls.push(`window ${id}`)
          for (const item of windows) item.focused = item.id === id
        }
      }
    },
    scripting: {
      executeScript: async ({ target }) => [{ result: paints(target.tabId) }]
    }
  }
}

const front = await import("./studioFront.ts")
const activeIn = (windowId) => tabs.find((item) => item.active && item.windowId === windowId)?.id
const later = async (ms) => {
  mock.timers.tick(ms)
  await new Promise(setImmediate)
}

beforeEach(() => {
  // The user is on tab 1; Browse Hack opened Studio tabs 2 and 3 behind it in the same window.
  tabs = [
    { id: 1, windowId: 10, active: true },
    { id: 2, windowId: 10, active: false },
    { id: 3, windowId: 10, active: false },
    { id: 9, windowId: 20, active: true }
  ]
  windows = [
    { id: 10, focused: true },
    { id: 20, focused: false }
  ]
  // A tab is painted when it's in front in its window and Chrome is in front.
  paints = (id) => {
    const item = tabs.find((other) => other.id === id)
    return !!item?.active && windows.some((win) => win.id === item.windowId && win.focused)
  }
  calls = []
  globalThis.chrome = fakeChrome()
  mock.timers.enable({ apis: ["setTimeout"] })
})

afterEach(async () => {
  await front.putBack(true)
  mock.timers.reset()
})

describe("a Studio tab in front for one step", () => {
  test("comes forward for the step and the user's tab comes back a moment later", async () => {
    let during
    await front.inFront(2, async () => {
      during = activeIn(10)
    })
    assert.equal(during, 2)
    assert.equal(activeIn(10), 2, "stays a moment, so back-to-back steps don't flicker")
    await later(front.PUT_BACK_AFTER_MS)
    assert.equal(activeIn(10), 1)
    assert.deepEqual(calls, ["tab 2", "tab 1"], "the window is painted, so it isn't raised")
  })

  test("back-to-back steps on two Studio tabs still put the user's tab back, not the first Studio tab", async () => {
    await front.inFront(2, async () => {})
    await later(1000)
    await front.inFront(3, async () => {})
    await later(front.PUT_BACK_AFTER_MS)
    assert.equal(activeIn(10), 1)
  })

  test("puts the tab back when the step fails", async () => {
    await assert.rejects(
      front.inFront(2, async () => {
        throw new Error("Studio didn't answer.")
      }),
      /didn't answer/
    )
    await later(front.PUT_BACK_AFTER_MS)
    assert.equal(activeIn(10), 1)
  })

  test("leaves the user where they went when they picked another tab meanwhile", async () => {
    tabs.push({ id: 4, windowId: 10, active: false })
    await front.inFront(2, async () => {})
    // The user clicks tab 4 before Browse Hack puts their tab back.
    for (const item of tabs) if (item.windowId === 10) item.active = item.id === 4
    await later(front.PUT_BACK_AFTER_MS)
    assert.equal(activeIn(10), 4)
  })

  test("closing a Studio tab puts the user's tab back first, so Chrome doesn't show its neighbour", async () => {
    await front.inFront(3, async () => {})
    await front.closeStudioTab(3)
    assert.equal(activeIn(10), 1)
    assert.equal(tabs.some((item) => item.id === 3), false)
  })
})

describe("Chrome's window behind another app", () => {
  test("raises the window only when the tab isn't painted, then gives focus back to the window that had it", async () => {
    // The Studio tab's window 10 isn't focused (the user is in window 20) and is covered, so it isn't painted.
    windows = [
      { id: 10, focused: false },
      { id: 20, focused: true }
    ]
    let during
    await front.inFront(2, async () => {
      during = { tab: activeIn(10), focused: windows.find((item) => item.focused).id }
    })
    assert.deepEqual(during, { tab: 2, focused: 10 })
    await later(front.PUT_BACK_AFTER_MS)
    assert.equal(activeIn(10), 1)
    assert.equal(windows.find((item) => item.focused).id, 20)
  })

  test("doesn't raise the window when it's on screen but not focused", async () => {
    windows = [
      { id: 10, focused: false },
      { id: 20, focused: true }
    ]
    paints = (id) => !!tabs.find((item) => item.id === id)?.active
    await front.inFront(2, async () => {})
    await later(front.PUT_BACK_AFTER_MS)
    assert.deepEqual(calls, ["tab 2", "tab 1"])
    assert.equal(windows.find((item) => item.focused).id, 20)
  })
})
