// Releases the MCP server to the MediaMake catalog as mcp/browse-hack, the
// same steps as MediaMake's `npm run catalog -- release browse-hack.mcpb`:
// register the item, upload the package (the .mcpb with catalog.json and
// INSTALL.md beside it, as a .tar.gz) and publish the version with its
// release notes. Installed copies pick it up within a few hours.
//
//   node scripts/release-catalog.mjs status    prints {"version","released"}: is package.json's version out?
//   node scripts/release-catalog.mjs publish   releases browse-hack.mcpb (run npm run pack:mcpb first)
//
// Needs MEDIAMAKE_ADMIN_KEY (an API key of a MediaMake admin) and, for another
// site than mediamake.microfox.app, MEDIAMAKE_URL. Release notes come from
// the version's section of CHANGELOG.md, else RELEASE_NOTES.

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASE_URL = (process.env.MEDIAMAKE_URL || "https://mediamake.microfox.app").replace(/\/$/, "")
const ADMIN_KEY = process.env.MEDIAMAKE_ADMIN_KEY
const ITEM = "mcp/browse-hack"

const fail = (message) => {
  console.error(`✖ ${message}`)
  process.exit(1)
}

async function admin(body) {
  if (!ADMIN_KEY) fail("Set MEDIAMAKE_ADMIN_KEY to a MediaMake admin's API key.")
  const res = await fetch(`${BASE_URL}/api/admin/catalog`, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${body?.type ?? "list"}: ${json.error ?? res.statusText}`)
  return json
}

/** The lines under "## <version>" in CHANGELOG.md, up to the next "## ". */
function changelogNotes(changelog, version) {
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+\\[?v?${version.replace(/\./g, "\\.")}\\]?(\\s|$)`).test(line))
  if (start < 0) return undefined
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line))
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim() || undefined
}

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version

async function isReleased() {
  const { items } = await admin()
  return items?.find((item) => item.id === ITEM)?.version === version
}

async function publish() {
  const bundle = join(root, "browse-hack.mcpb")
  if (!existsSync(bundle)) fail("No browse-hack.mcpb; run npm run pack:mcpb first.")
  const notes =
    changelogNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version) || process.env.RELEASE_NOTES?.trim()
  if (!notes) fail(`No release notes: add a "## ${version}" section to mcp/CHANGELOG.md.`)

  // Leaving visibility out keeps the item's stage (new items start private).
  const { visibility, ...card } = JSON.parse(readFileSync(join(root, "browse-hack.catalog.json"), "utf8"))
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
  await admin({
    type: "upsert_item",
    item: {
      ...card,
      title: card.title ?? manifest.display_name,
      summary: card.summary ?? manifest.description,
      install: { method: "mcpb", ...card.install, entry: "browse-hack.mcpb" }
    }
  })

  let upload
  try {
    upload = await admin({ type: "create_upload", itemId: ITEM, version })
  } catch (error) {
    if (/already published/.test(error.message)) return console.log(`${ITEM}@${version} is already released.`)
    throw error
  }

  const work = mkdtempSync(join(tmpdir(), "browse-hack-release-"))
  try {
    const dir = join(work, "package")
    mkdirSync(dir)
    copyFileSync(bundle, join(dir, "browse-hack.mcpb"))
    copyFileSync(join(root, "browse-hack.catalog.json"), join(dir, "catalog.json"))
    copyFileSync(join(root, "browse-hack.INSTALL.md"), join(dir, "INSTALL.md"))
    const archive = join(work, `browse-hack-${version}.tar.gz`)
    // COPYFILE_DISABLE keeps macOS tar from adding ._ files.
    execFileSync("tar", ["-czf", archive, "-C", dir, "."], { env: { ...process.env, COPYFILE_DISABLE: "1" } })
    const bytes = readFileSync(archive)
    const sha256 = createHash("sha256").update(bytes).digest("hex")

    const put = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/gzip", "x-amz-acl": "private" },
      body: bytes
    })
    if (!put.ok) throw new Error(`Upload failed: ${put.status} ${await put.text()}`)

    await admin({
      type: "publish_version",
      itemId: ITEM,
      version,
      storageKey: upload.storageKey,
      sha256,
      bytes: bytes.length,
      notes
    })
    console.log(`✔ ${ITEM}@${version} released (${(bytes.length / 1024).toFixed(1)} KB, sha256 ${sha256.slice(0, 12)}…)`)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

const command = process.argv[2]
try {
  if (command === "status") console.log(JSON.stringify({ version, released: await isReleased() }))
  else if (command === "publish") await publish()
  else fail("Usage: node scripts/release-catalog.mjs status|publish")
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
