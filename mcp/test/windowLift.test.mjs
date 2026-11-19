// Tests for src/windowLift.ts and the bridge's calls from the extension, run against the built files: npm test
// (builds first). PowerShell is faked, except for one run that only happens on Windows and touches no window.

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { describe, test } from "node:test"

import { Bridge } from "../dist/bridge.js"
import { liftWindow, lowerWindow, windowMethods } from "../dist/windowLift.js"

const TOKEN = "bh-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"

/** A PowerShell that records what it was given and answers with these lines. */
function fakePowerShell(...lines) {
  const runs = []
  const run = async (script, env) => {
    runs.push({ script, env })
    return lines.join("\r\n")
  }
  return { run, runs }
}

describe("liftWindow", () => {
  test("finds the window by the token in its title and says how to put it back", async () => {
    const { run, runs } = fakePowerShell("", '{"found":true,"hwnd":"66490","below":"132322","minimized":true}')
    assert.deepEqual(await liftWindow({ titleToken: TOKEN }, run, "win32"), {
      found: true,
      hwnd: "66490",
      below: "132322",
      minimized: true
    })
    assert.deepEqual(runs[0].env, { BH_ACTION: "lift", BH_TOKEN: TOKEN })
    assert.match(runs[0].script, /SetWindowPos/)
  })

  test("no window with the token", async () => {
    const { run } = fakePowerShell('{"found":false}')
    assert.deepEqual(await liftWindow({ titleToken: TOKEN }, run, "win32"), { found: false })
  })

  test("refuses a token that isn't letters, digits and dashes, before running anything", async () => {
    const { run, runs } = fakePowerShell('{"found":false}')
    await assert.rejects(liftWindow({ titleToken: "x'; Stop-Computer; '" }, run, "win32"), /titleToken/)
    await assert.rejects(liftWindow({}, run, "win32"), /titleToken/)
    assert.equal(runs.length, 0)
  })

  test("only on Windows: a Mac's Chrome brings itself forward", async () => {
    const { run, runs } = fakePowerShell('{"found":false}')
    await assert.rejects(liftWindow({ titleToken: TOKEN }, run, "darwin"), /only for Windows/)
    assert.equal(runs.length, 0)
  })

  test("an answer that isn't JSON is an error", async () => {
    const { run } = fakePowerShell("Add-Type : Cannot add type.")
    await assert.rejects(liftWindow({ titleToken: TOKEN }, run, "win32"), /Unexpected answer/)
  })
})

describe("lowerWindow", () => {
  test("puts the window behind the one that was in front", async () => {
    const { run, runs } = fakePowerShell('{"lowered":true}')
    assert.deepEqual(await lowerWindow({ hwnd: "66490", below: "132322", minimized: false }, run, "win32"), { lowered: true })
    assert.deepEqual(runs[0].env, { BH_ACTION: "lower", BH_HWND: "66490", BH_BELOW: "132322", BH_MINIMIZE: "0" })
  })

  test("minimizes it again when it was minimized", async () => {
    const { run, runs } = fakePowerShell('{"lowered":true}')
    await lowerWindow({ hwnd: "66490", below: "0", minimized: true }, run, "win32")
    assert.equal(runs[0].env.BH_MINIMIZE, "1")
  })

  test("says why it left the window", async () => {
    const { run } = fakePowerShell('{"lowered":false,"why":"The user is in that window now."}')
    assert.deepEqual(await lowerWindow({ hwnd: "66490", below: "1" }, run, "win32"), {
      lowered: false,
      why: "The user is in that window now."
    })
  })

  test("refuses handles that aren't numbers", async () => {
    const { run, runs } = fakePowerShell('{"lowered":true}')
    await assert.rejects(lowerWindow({ hwnd: "1; calc", below: "0" }, run, "win32"), /handles/)
    await assert.rejects(lowerWindow({ hwnd: "1", below: "-2" }, run, "win32"), /handles/)
    assert.equal(runs.length, 0)
  })
})

test("the extension is offered window.lift and window.lower on Windows only", () => {
  assert.deepEqual(Object.keys(windowMethods("win32")).sort(), ["window.lift", "window.lower"])
  assert.deepEqual(windowMethods("darwin"), {})
  assert.deepEqual(windowMethods("linux"), {})
})

test("on this Windows computer, the real script runs and finds no window for an unknown token", { skip: process.platform !== "win32" }, async () => {
  assert.deepEqual(await liftWindow({ titleToken: "bh-no-window-has-this-title" }), { found: false })
  assert.deepEqual(await lowerWindow({ hwnd: "1", below: "0" }), { lowered: false, why: "The window is closed." })
})

describe("the bridge answers the extension's own calls", () => {
  /** An extension's socket, as the hub sees it: messages in, frames sent out. */
  function extensionSocket() {
    const ws = new EventEmitter()
    ws.readyState = 1
    ws.sent = []
    ws.send = (frame) => ws.sent.push(JSON.parse(frame))
    ws.close = () => {}
    ws.terminate = () => {}
    ws.say = (message) => ws.emit("message", JSON.stringify(message))
    return ws
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  test("its welcome names what the extension may call, and calls get answers", async () => {
    const bridge = new Bridge(0, undefined, {
      "window.lift": async (params) => ({ found: true, asked: params })
    })
    const ws = extensionSocket()
    bridge["onConnection"](ws)
    ws.say({ type: "hello", role: "extension", profileId: "p1", version: "0.22.2" })
    assert.deepEqual(ws.sent[0], { type: "welcome", serves: ["window.lift"] })

    ws.say({ type: "request", id: 7, method: "window.lift", params: { titleToken: TOKEN } })
    ws.say({ type: "request", id: 8, method: "tabs.list", params: {} })
    await settle()
    // Each answer goes out when its call is done, whatever the order.
    assert.deepEqual(ws.sent.slice(1).sort((a, b) => a.id - b.id), [
      { type: "response", id: 7, ok: true, result: { found: true, asked: { titleToken: TOKEN } } },
      { type: "response", id: 8, ok: false, error: "Unknown method: tabs.list" }
    ])
  })

  test("a server that lifts nothing (a Mac) welcomes the extension with nothing to call", () => {
    const bridge = new Bridge(0)
    const ws = extensionSocket()
    bridge["onConnection"](ws)
    ws.say({ type: "hello", role: "extension", profileId: "p1" })
    assert.deepEqual(ws.sent, [{ type: "welcome", serves: [] }])
  })

  test("another copy of the server connecting as a peer gets no welcome", async () => {
    const bridge = new Bridge(0, undefined, { "window.lift": async () => ({ found: true }) })
    const ws = extensionSocket()
    bridge["onConnection"](ws)
    ws.say({ type: "hello", role: "peer" })
    assert.deepEqual(ws.sent, [])
  })
})
