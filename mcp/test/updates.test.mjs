// Tests for src/updates.ts (self-updates of the MCP and the extension) and
// src/archive.ts, run against the built files: npm test (builds first).
// Each test gets a fake home folder with MediaMake's install in it, a fake
// MediaMake catalog and a fake GitHub API on a local HTTP server, and a fake
// extension bridge.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { deflateRawSync } from "node:zlib"
import { afterEach, beforeEach, describe, test } from "node:test"

import { readTarGz, readZip, safePath } from "../dist/archive.js"
import { MCP_ITEM, Updater, isNewer, unpackedExtensionId } from "../dist/updates.js"

const TOKEN = "mmu_test-token"
const MCP_CONFIG = { command: "node", args: ["${__dirname}/server/index.js"], env: { BROWSE_HACK_PORT: "${user_config.port}" } }

let home, server, base, requests, catalog, github

const sha256 = (data) => createHash("sha256").update(data).digest("hex")

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return path
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"))

// A zip like the .mcpb and the extension zip: deflated (or stored) entries.
function makeZip(files, { deflate = true, modes = {} } = {}) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const body = deflate ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(deflate ? 8 : 0, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(deflate ? 8 : 0, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(((modes[name] ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, body)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + body.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const mcpManifest = (version, mcp_config = MCP_CONFIG) => ({
  manifest_version: "0.3",
  name: "browse-hack",
  version,
  server: { type: "node", entry_point: "server/index.js", mcp_config }
})

// A catalog package the way `npm run catalog -- release x.mcpb` packs it: tar -czf of a folder.
function makePackage(version, { manifest = mcpManifest(version) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "browse-hack-package-"))
  write(
    join(dir, "browse-hack.mcpb"),
    makeZip({
      "manifest.json": JSON.stringify(manifest),
      "server/index.js": `// server ${version}`,
      "icon.png": "png"
    })
  )
  write(join(dir, "catalog.json"), "{}")
  write(join(dir, "INSTALL.md"), "# setup")
  const file = join(dir, "..", `${version}-${process.pid}-${Math.random()}.tar.gz`)
  execFileSync("tar", ["-czf", file, "-C", dir, "."])
  const bytes = readFileSync(file)
  rmSync(dir, { recursive: true, force: true })
  rmSync(file, { force: true })
  return bytes
}

const extensionZip = (version, extra = {}) =>
  makeZip({
    "manifest.json": JSON.stringify({ manifest_version: 3, name: "Browse Hack", version }),
    "background.js": `// background ${version}`,
    ...extra
  })

function githubRelease(version, { asset = true, digest, zip = extensionZip(version), draft = false, prerelease = false, tag = `v${version}` } = {}) {
  return {
    tag,
    draft,
    prerelease,
    zip,
    body: `## Install\n\n1. Download it.\n\n## What's Changed\n* Changes in ${version}`,
    asset,
    digest: digest ?? `sha256:${sha256(zip)}`
  }
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "browse-hack-updates-"))
  requests = []
  catalog = {
    version: "0.8.0",
    package: makePackage("0.8.0"),
    sha256: undefined,
    releases: [
      { version: "0.8.0", publishedAt: "2026-11-02T00:00:00Z", notes: "Updates itself" },
      { version: "0.7.1", publishedAt: "2026-11-01T00:00:00Z", notes: "A fix" },
      { version: "0.7.0", publishedAt: "2026-10-30T00:00:00Z", notes: "YouTube uploads" }
    ]
  }
  github = [githubRelease("0.10.0"), githubRelease("0.9.0")]
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x")
    requests.push({ path: url.pathname, query: url.search, auth: req.headers.authorization })
    const json = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify(body))
    }
    const authed = req.headers.authorization === `Bearer ${TOKEN}`
    if (url.pathname === "/api/catalog/versions") {
      if (!authed) return json(401, { error: "lapsed" })
      return json(200, {
        items: [{ id: MCP_ITEM, title: "Browse Hack", version: catalog.version, releases: catalog.releases }],
        missing: []
      })
    }
    if (url.pathname === "/api/catalog/install") {
      if (!authed) return json(401, { error: "lapsed" })
      return json(200, {
        ok: true,
        itemId: MCP_ITEM,
        steps: [
          { type: "github-release", repo: "microfox-ai/extensions", asset: "browse-hack-chrome.zip" },
          {
            type: "item",
            id: MCP_ITEM,
            slug: "browse-hack",
            title: "Browse Hack",
            version: catalog.version,
            method: "mcpb",
            entry: "browse-hack.mcpb",
            downloadUrl: `${base}/package/browse-hack-${catalog.version}.tar.gz`,
            sha256: catalog.sha256 ?? sha256(catalog.package)
          }
        ]
      })
    }
    if (url.pathname.startsWith("/package/")) {
      res.writeHead(200, { "content-type": "application/gzip" })
      return res.end(catalog.package)
    }
    if (url.pathname === "/gh/repos/microfox-ai/extensions/releases") {
      return json(
        200,
        github.map((r) => ({
          tag_name: r.tag,
          draft: r.draft,
          prerelease: r.prerelease,
          published_at: "2026-11-02T00:00:00Z",
          body: r.body,
          assets: r.asset
            ? [{ name: "browse-hack-chrome.zip", digest: r.digest, browser_download_url: `${base}/gh/assets/${r.tag}` }]
            : []
        }))
      )
    }
    // GitHub's asset links redirect to its storage.
    if (url.pathname.startsWith("/gh/assets/")) {
      res.writeHead(302, { location: `${base}/storage/${url.pathname.split("/").pop()}` })
      return res.end()
    }
    if (url.pathname.startsWith("/storage/")) {
      const release = github.find((r) => r.tag === url.pathname.split("/").pop())
      res.writeHead(200, { "content-type": "application/zip" })
      return res.end(release.zip)
    }
    json(404, { error: "not found" })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${server.address().port}`
})

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(home, { recursive: true, force: true })
})

const mcpFolder = () => join(home, ".mediamake", "mcp", "browse-hack")
const extensionFolder = () => join(home, "Extensions", "browse-hack-chrome")

function installMcp(version = "0.7.0", manifest = mcpManifest(version)) {
  write(join(mcpFolder(), "manifest.json"), JSON.stringify(manifest))
  write(join(mcpFolder(), "server", "index.js"), `// server ${version}`)
}

function installExtension(version = "0.9.0") {
  write(join(extensionFolder(), "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Browse Hack", version }))
  write(join(extensionFolder(), "background.js"), `// background ${version}`)
  write(join(extensionFolder(), "old-only.js"), "gone after an update")
}

function writeConfig(config = { url: base, updateToken: TOKEN }) {
  write(join(home, ".mediamake", "config.json"), JSON.stringify(config))
}

// Profiles the bridge reports; `fromFolder` ones load the extension from ~/Extensions/browse-hack-chrome.
function fakeBridge(profiles, { busy = [], old = false } = {}) {
  const calls = []
  const state = profiles.map((p) => ({
    id: p.id,
    label: p.email,
    email: p.email,
    version: p.version,
    extensionId:
      p.fromFolder && existsSync(extensionFolder())
        ? unpackedExtensionId(realpathSync(extensionFolder()))
        : "otherfolderidaaaaaaaaaaaaaaaaaaaa",
    connectedAt: "2026-11-02T00:00:00Z"
  }))
  return {
    calls,
    profiles: state,
    status: async () => ({ profiles: state.map((p) => ({ ...p })) }),
    callIn: async (id, method) => {
      calls.push({ id, method })
      if (old) throw new Error(`Unknown method: ${method}`)
      const profile = state.find((p) => p.id === id)
      if (method === "extension.status") return { version: profile.version, busy }
      if (method === "extension.reload") {
        // Chrome reads the folder again.
        setTimeout(() => (profile.version = readJson(join(extensionFolder(), "manifest.json")).version), 50)
        return { reloading: true }
      }
      throw new Error(`unexpected call: ${method}`)
    }
  }
}

let clock
function updater(bridge = fakeBridge([]), options = {}) {
  clock = Date.parse("2026-11-02T10:00:00Z")
  return new Updater({
    bridge,
    runningVersion: "0.7.0",
    runningFrom: mcpFolder(),
    home,
    env: {},
    githubApi: `${base}/gh`,
    now: () => clock,
    reconnectWaitMs: 3000,
    ...options
  })
}

const paths = () => requests.map((r) => r.path)

describe("versions and extension ids", () => {
  test("compares versions", () => {
    assert.equal(isNewer("0.10.0", "0.9.0"), true)
    assert.equal(isNewer("v1.0.0", "0.99.99"), true)
    assert.equal(isNewer("0.8.0", "0.8.0"), false)
    assert.equal(isNewer("0.7.9", "0.8.0"), false)
    assert.equal(isNewer("0.1.0", undefined), true)
    assert.equal(isNewer("mcp-1.0", "0.1.0"), false)
  })

  test("computes the id Chrome gives an unpacked folder", () => {
    // Chrome: SHA-256 of the absolute path, first 32 hex digits written with a-p.
    const id = unpackedExtensionId("/Users/someone/Extensions/browse-hack-chrome")
    const hex = createHash("sha256").update("/Users/someone/Extensions/browse-hack-chrome").digest("hex").slice(0, 32)
    assert.equal(id, [...hex].map((c) => "abcdefghijklmnop"[parseInt(c, 16)]).join(""))
    assert.match(id, /^[a-p]{32}$/)
    // Windows hashes the UTF-16 path with an upper-case drive letter.
    assert.equal(
      unpackedExtensionId("c:\\Users\\me\\Extensions\\browse-hack-chrome", "win32"),
      unpackedExtensionId("C:\\Users\\me\\Extensions\\browse-hack-chrome", "win32")
    )
  })
})

describe("archives", () => {
  test("reads deflated and stored zips", () => {
    for (const deflate of [true, false]) {
      const files = readZip(makeZip({ "a.txt": "hello", "dir/b.txt": "world".repeat(100) }, { deflate }))
      assert.deepEqual(
        files.map((f) => [f.path, f.data.toString()]),
        [
          ["a.txt", "hello"],
          ["dir/b.txt", "world".repeat(100)]
        ]
      )
    }
  })

  test("reads a zip made by the zip command", () => {
    const dir = mkdtempSync(join(tmpdir(), "browse-hack-zip-"))
    try {
      write(join(dir, "src", "manifest.json"), '{"name":"Browse Hack"}')
      write(join(dir, "src", "static", "popup.html"), "<html>".repeat(500))
      execFileSync("zip", ["-qr", join(dir, "out.zip"), "."], { cwd: join(dir, "src") })
      const files = readZip(readFileSync(join(dir, "out.zip")))
      assert.deepEqual(files.map((f) => f.path).sort(), ["manifest.json", "static/popup.html"])
      assert.equal(files.find((f) => f.path === "static/popup.html").data.toString(), "<html>".repeat(500))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("refuses paths outside the folder and skips links", () => {
    assert.throws(() => readZip(makeZip({ "../evil.js": "x" })), /outside its folder/)
    assert.throws(() => readZip(makeZip({ "/etc/evil": "x" })), /outside its folder/)
    assert.throws(() => safePath("C:\\evil"), /outside its folder/)
    assert.equal(safePath("./a\\b/./c"), "a/b/c")
    const files = readZip(makeZip({ link: "/etc/passwd", "ok.txt": "ok" }, { modes: { link: 0o120777 } }))
    assert.deepEqual(files.map((f) => f.path), ["ok.txt"])
  })

  test("reads a tar.gz made by the tar command", () => {
    const files = readTarGz(makePackage("1.2.3"))
    assert.deepEqual(files.map((f) => f.path).sort(), ["INSTALL.md", "browse-hack.mcpb", "catalog.json"])
    const bundle = readZip(files.find((f) => f.path === "browse-hack.mcpb").data)
    assert.equal(JSON.parse(bundle.find((f) => f.path === "manifest.json").data).version, "1.2.3")
  })
})

describe("MCP updates", () => {
  test("installs a newer version from the catalog", async () => {
    installMcp("0.7.0")
    writeConfig()
    const state = await updater().check()

    assert.equal(readJson(join(mcpFolder(), "manifest.json")).version, "0.8.0")
    assert.equal(readFileSync(join(mcpFolder(), "server", "index.js"), "utf8"), "// server 0.8.0")
    assert.equal(state.mcp.installed, "0.8.0")
    assert.equal(state.mcp.from, "0.7.0")
    assert.deepEqual(state.mcp.notes.map((n) => n.version), ["0.8.0", "0.7.1"])
    // Every catalog call carried the update token; the package link didn't.
    for (const r of requests.filter((r) => r.path.startsWith("/api/"))) assert.equal(r.auth, `Bearer ${TOKEN}`)
    assert.equal(requests.find((r) => r.path.startsWith("/package/")).auth, undefined)
    const installed = readJson(join(home, ".mediamake", "installed.json"))
    assert.equal(installed.items[MCP_ITEM].version, "0.8.0")
    assert.equal(readJson(join(home, ".mediamake", "updates", "browse-hack.json")).mcp.installed, "0.8.0")
    // Nothing is left beside the folder, and the lock is gone.
    assert.deepEqual(
      execFileSync("ls", ["-a", join(home, ".mediamake", "mcp")]).toString().split("\n").filter(Boolean),
      [".", "..", "browse-hack"]
    )
    assert.equal(existsSync(join(home, ".mediamake", "updates", "browse-hack.lock")), false)
  })

  test("asks for nothing more when it's current", async () => {
    installMcp("0.8.0")
    writeConfig()
    const state = await updater().check()
    assert.equal(state.mcp.installed, "0.8.0")
    assert.equal(state.mcp.latest, "0.8.0")
    assert.deepEqual(paths().filter((p) => p.startsWith("/api/")), ["/api/catalog/versions"])
  })

  test("refuses a package that fails its sha256 check", async () => {
    installMcp("0.7.0")
    writeConfig()
    catalog.sha256 = "0".repeat(64)
    const state = await updater().check()
    assert.match(state.mcp.error, /sha256/)
    assert.equal(readJson(join(mcpFolder(), "manifest.json")).version, "0.7.0")
  })

  test("refuses a package that isn't Browse Hack at that version", async () => {
    installMcp("0.7.0")
    writeConfig()
    catalog.package = makePackage("0.8.0", { manifest: { ...mcpManifest("0.8.0"), name: "other" } })
    const state = await updater().check()
    assert.match(state.mcp.error, /isn't Browse Hack 0.8.0/)
    assert.equal(readJson(join(mcpFolder(), "manifest.json")).version, "0.7.0")
  })

  test("leaves a version that starts differently for Claude to register", async () => {
    installMcp("0.7.0")
    writeConfig()
    catalog.package = makePackage("0.8.0", { manifest: mcpManifest("0.8.0", { ...MCP_CONFIG, args: ["${__dirname}/server/main.js"] }) })
    const state = await updater().check()
    assert.match(state.mcp.waiting, /registered again/)
    assert.equal(readJson(join(mcpFolder(), "manifest.json")).version, "0.7.0")
  })

  test("says what to do without a credential", async () => {
    installMcp("0.7.0")
    writeConfig({ url: base })
    const state = await updater().check()
    assert.match(state.mcp.skipped, /update token/)
    assert.equal(paths().filter((p) => p.startsWith("/api/")).length, 0)
  })

  test("uses a saved API key too", async () => {
    installMcp("0.7.0")
    writeConfig({ url: base, apiKey: TOKEN })
    assert.equal((await updater().check()).mcp.installed, "0.8.0")
  })

  test("skips a server that wasn't installed from MediaMake", async () => {
    writeConfig()
    const state = await updater().check()
    assert.match(state.mcp.skipped, /Not installed from MediaMake/)
    assert.equal(requests.length, 0)
  })

  test("checks every few hours, or when asked", async () => {
    installMcp("0.8.0")
    writeConfig()
    const u = updater()
    await u.check()
    const first = requests.length
    clock += 60 * 60_000
    await u.check()
    assert.equal(requests.length, first)
    await u.check({ force: true })
    assert.equal(requests.length, 2 * first)
    clock += 6 * 60 * 60_000
    await u.check()
    assert.equal(requests.length, 3 * first)
  })

  test("autoUpdate false stops the timer checks, not the asked ones", async () => {
    installMcp("0.7.0")
    writeConfig({ url: base, updateToken: TOKEN, autoUpdate: false })
    const u = updater()
    assert.equal(u.autoUpdate, false)
    await u.check()
    assert.equal(requests.length, 0)
    assert.equal((await u.check({ force: true })).mcp.installed, "0.8.0")
    u.setAutoUpdate(true)
    assert.equal(readJson(join(home, ".mediamake", "config.json")).autoUpdate, undefined)
    assert.equal(readJson(join(home, ".mediamake", "config.json")).updateToken, TOKEN)
    assert.equal(updater(fakeBridge([]), { env: { BROWSE_HACK_AUTO_UPDATE: "0" } }).autoUpdate, false)
  })

  test("only one server process updates at a time", async () => {
    installMcp("0.7.0")
    writeConfig()
    // Held by a live process (this test's parent).
    const lock = write(join(home, ".mediamake", "updates", "browse-hack.lock"), JSON.stringify({ pid: process.ppid, at: new Date().toISOString() }))
    await updater().check()
    assert.equal(requests.length, 0)
    await assert.rejects(updater().check({ force: true }), /installing an update right now/)
    // Its owner is gone: the lock is stale.
    writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }))
    assert.equal((await updater().check()).mcp.installed, "0.8.0")
  })

  test("tells the session once that a new version is installed", async () => {
    installMcp("0.7.0")
    writeConfig()
    const u = updater()
    assert.equal(u.notice(), undefined)
    await u.check()
    assert.match(u.notice(), /0\.8\.0 is installed \(this session runs 0\.7\.0\)/)
    assert.equal(u.notice(), undefined)
    const summary = u.summary()
    assert.equal(summary.mcp.runningVersion, "0.7.0")
    assert.equal(summary.mcp.installedVersion, "0.8.0")
    assert.match(summary.mcp.note, /new Claude session/)
    assert.equal(summary.mcp.lastUpdate.from, "0.7.0")
    // A copy running from a checkout says so instead.
    const elsewhere = updater(fakeBridge([]), { runningFrom: join(home, "checkout", "mcp") })
    assert.equal(elsewhere.notice(), undefined)
    assert.match(elsewhere.summary().mcp.note, /not from MediaMake's install/)
  })
})

describe("extension updates", () => {
  const profiles = () => [
    { id: "p1", email: "one@example.com", version: "0.9.0", fromFolder: true },
    { id: "p2", email: "two@example.com", version: "0.9.0", fromFolder: true },
    { id: "dev", email: "dev@example.com", version: "0.4.1", fromFolder: false }
  ]

  test("replaces the folder and reloads each profile that loads it", async () => {
    installExtension("0.9.0")
    const bridge = fakeBridge(profiles())
    const state = await updater(bridge).check()

    assert.equal(readJson(join(extensionFolder(), "manifest.json")).version, "0.10.0")
    assert.equal(existsSync(join(extensionFolder(), "old-only.js")), false)
    assert.equal(state.extension.installed, "0.10.0")
    assert.equal(state.extension.from, "0.9.0")
    assert.deepEqual(state.extension.notes.map((n) => n.version), ["0.10.0"])
    assert.match(state.extension.notes[0].notes, /^## What's Changed/)
    assert.deepEqual(
      bridge.calls.map((c) => `${c.id} ${c.method}`),
      ["p1 extension.status", "p2 extension.status", "p1 extension.reload", "p2 extension.reload"]
    )
    const byEmail = Object.fromEntries(state.extension.profiles.map((p) => [p.profile, p]))
    assert.equal(byEmail["one@example.com"].reloaded, true)
    assert.equal(byEmail["one@example.com"].version, "0.10.0")
    assert.equal(byEmail["dev@example.com"].loadedFrom, "another folder")
    assert.equal(state.extension.waiting, undefined)
    // No catalog or credential needed for the extension.
    assert.equal(paths().some((p) => p.startsWith("/api/")), false)
  })

  test("picks the newest vX.Y.Z release that has the zip", async () => {
    installExtension("0.9.0")
    github = [
      githubRelease("0.12.0", { draft: true }),
      githubRelease("0.11.0", { prerelease: true }),
      githubRelease("0.10.5", { asset: false }),
      githubRelease("9.0.0", { tag: "mcp-v9.0.0" }),
      githubRelease("0.9.0"),
      githubRelease("0.10.1")
    ]
    const state = await updater(fakeBridge([])).check()
    assert.equal(state.extension.installed, "0.10.1")
    assert.equal(readJson(join(extensionFolder(), "manifest.json")).version, "0.10.1")
  })

  test("follows a symlinked folder without replacing the link", async () => {
    const real = join(home, "elsewhere", "browse-hack-chrome")
    write(join(real, "manifest.json"), JSON.stringify({ name: "Browse Hack", version: "0.9.0" }))
    mkdirSync(join(home, "Extensions"), { recursive: true })
    symlinkSync(real, extensionFolder())
    await updater(fakeBridge([])).check()
    assert.equal(readJson(join(real, "manifest.json")).version, "0.10.0")
    assert.equal(realpathSync(extensionFolder()), realpathSync(real))
  })

  test("waits while the extension is busy, unless told to reload anyway", async () => {
    installExtension("0.9.0")
    const bridge = fakeBridge(profiles(), { busy: ["1 YouTube download"] })
    const u = updater(bridge)
    const state = await u.check()
    assert.match(state.extension.waiting, /one@example.com: 1 YouTube download/)
    assert.equal(readJson(join(extensionFolder(), "manifest.json")).version, "0.9.0")
    assert.equal(paths().some((p) => p.startsWith("/storage/")), false)
    // Busy: it tries again sooner than every few hours.
    clock += 16 * 60_000
    await u.check()
    assert.equal(paths().filter((p) => p.endsWith("/releases")).length, 2)
    const forced = await u.check({ force: true, reloadBusy: true })
    assert.equal(forced.extension.installed, "0.10.0")
    assert.equal(forced.extension.waiting, undefined)
  })

  test("asks for one click when the running copy is too old to reload itself", async () => {
    installExtension("0.9.0")
    const state = await updater(fakeBridge(profiles(), { old: true })).check()
    assert.equal(readJson(join(extensionFolder(), "manifest.json")).version, "0.10.0")
    assert.match(state.extension.waiting, /chrome:\/\/extensions in one@example.com, two@example.com/)
    assert.match(state.extension.profiles[0].note, /too old to reload itself/)
  })

  test("reloads a profile still running an older copy of the current folder", async () => {
    installExtension("0.10.0")
    const bridge = fakeBridge([
      { id: "p1", email: "one@example.com", version: "0.9.0", fromFolder: true },
      { id: "p2", email: "two@example.com", version: "0.10.0", fromFolder: true }
    ])
    const state = await updater(bridge).check()
    assert.deepEqual(bridge.calls.map((c) => `${c.id} ${c.method}`), ["p1 extension.status", "p1 extension.reload"])
    assert.equal(state.extension.profiles[0].reloaded, true)
    assert.equal(paths().some((p) => p.startsWith("/storage/")), false)
  })

  test("refuses a zip that fails its digest", async () => {
    installExtension("0.9.0")
    github = [githubRelease("0.10.0", { digest: `sha256:${"0".repeat(64)}` })]
    const state = await updater(fakeBridge([])).check()
    assert.match(state.extension.error, /sha256/)
    assert.equal(readJson(join(extensionFolder(), "manifest.json")).version, "0.9.0")
    assert.equal(existsSync(join(extensionFolder(), "old-only.js")), true)
  })

  test("leaves an extension that wasn't installed from MediaMake alone", async () => {
    const state = await updater(fakeBridge(profiles())).check()
    assert.match(state.extension.skipped, /Not installed from MediaMake/)
    assert.equal(paths().some((p) => p.startsWith("/gh/")), false)
  })
})
