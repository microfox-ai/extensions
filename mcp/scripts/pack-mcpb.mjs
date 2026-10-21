// Builds get-into-zone.mcpb, a one-click Claude Desktop extension.
// Bundles the server into one file (no node_modules), fills the manifest's
// version and tool list from the server itself, then packs with the mcpb CLI.

import { spawn, execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "esbuild"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const stage = join(root, "build", "mcpb")
const output = join(root, "get-into-zone.mcpb")

rmSync(stage, { recursive: true, force: true })
mkdirSync(join(stage, "server"), { recursive: true })

await build({
  entryPoints: [join(root, "src", "index.ts")],
  outfile: join(stage, "server", "index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // ws loads these optional native addons with require() inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
  },
  logLevel: "warning"
})

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
manifest.version = pkg.version
manifest.tools = await listTools(join(stage, "server", "index.js"))
writeFileSync(join(stage, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
copyFileSync(join(root, "..", "get-into-zone", "assets", "icon.png"), join(stage, "icon.png"))

const mcpb = join(root, "node_modules", ".bin", "mcpb")
execFileSync(mcpb, ["validate", join(stage, "manifest.json")], { stdio: "inherit" })
execFileSync(mcpb, ["pack", stage, output], { stdio: "inherit" })

// Starts the bundled server and asks it for its tools, so the manifest
// always matches what the server registers.
function listTools(entry) {
  return new Promise((resolve, reject) => {
    // A spare port so the extension never connects to this short-lived copy.
    const port = String(40000 + Math.floor(Math.random() * 20000))
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, GET_INTO_ZONE_PORT: port },
      stdio: ["pipe", "pipe", "inherit"]
    })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("Server did not answer tools/list"))
    }, 10_000)
    let buffer = ""
    child.stdout.on("data", (chunk) => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "notifications/initialized" })
          send({ jsonrpc: "2.0", id: 2, method: "tools/list" })
        } else if (message.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolve(message.result.tools.map(({ name, description }) => ({ name, description })))
        }
      }
    })
    child.on("error", reject)
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\n")
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-mcpb", version: "0" } }
    })
  })
}
