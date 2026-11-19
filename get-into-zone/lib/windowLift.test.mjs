// Tests for lifting Chrome's window through the MCP server (Windows): npm test.
// The Studio tab's document and the server are faked.

import assert from "node:assert/strict"
import { beforeEach, describe, test } from "node:test"

import { windowLifter } from "./windowLift.ts"

const TITLE = "Channel dashboard - YouTube Studio"
let calls

beforeEach(() => {
  globalThis.document = { title: TITLE }
  globalThis.chrome = {
    scripting: { executeScript: async ({ func, args }) => [{ result: func(...args) }] }
  }
  calls = []
})

const serving = (answer) => ({
  call: async (method, params) => {
    calls.push({ method, params, title: document.title })
    return typeof answer === "function" ? answer() : answer
  },
  serves: (method) => method === "window.lift" || method === "window.lower"
})

describe("windowLifter", () => {
  test("with no server that lifts windows (a Mac), does nothing", async () => {
    const lifter = windowLifter(async () => assert.fail("no call"), () => false)
    assert.equal(await lifter.lift(2), null)
    assert.equal(document.title, TITLE)
    await lifter.lower({ hwnd: "1", below: "2", minimized: false })
  })

  test("marks the tab's title while the server looks for its window, then puts the title back", async () => {
    const { call, serves } = serving({ found: true, hwnd: 100, below: 200, minimized: true })
    const lifted = await windowLifter(call, serves).lift(2)
    assert.deepEqual(lifted, { hwnd: "100", below: "200", minimized: true })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, "window.lift")
    const token = calls[0].params.titleToken
    assert.match(token, /^bh-[0-9a-f-]{36}$/)
    assert.equal(calls[0].title, `${token} ${TITLE}`, "Chrome names the window after the tab, token first")
    assert.equal(document.title, TITLE)
  })

  test("a window the server can't find, or a server error, leaves the title as it was", async () => {
    const notFound = serving({ found: false })
    assert.equal(await windowLifter(notFound.call, notFound.serves).lift(2), null)
    assert.equal(document.title, TITLE)
    const failing = serving(() => {
      throw new Error("PowerShell failed")
    })
    await assert.rejects(windowLifter(failing.call, failing.serves).lift(2), /PowerShell/)
    assert.equal(document.title, TITLE)
  })

  test("a tab it can't script isn't lifted", async () => {
    chrome.scripting.executeScript = async () => {
      throw new Error("Cannot access contents of the page")
    }
    const { call, serves } = serving({ found: true, hwnd: 1, below: 2, minimized: false })
    assert.equal(await windowLifter(call, serves).lift(2), null)
    assert.equal(calls.length, 0)
  })

  test("lower hands the server back what lift gave", async () => {
    const { call, serves } = serving({ lowered: true })
    await windowLifter(call, serves).lower({ hwnd: "100", below: "200", minimized: false })
    assert.deepEqual(calls, [
      { method: "window.lower", params: { hwnd: "100", below: "200", minimized: false }, title: TITLE }
    ])
  })
})
