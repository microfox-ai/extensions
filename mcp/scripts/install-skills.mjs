// Links the skills in ../skills into ~/.claude/skills so Claude Code can use
// them in every project. Pass --copy to copy instead of symlinking.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const source = join(dirname(fileURLToPath(import.meta.url)), "..", "skills")
const target = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "skills")
const copy = process.argv.includes("--copy")

mkdirSync(target, { recursive: true })
for (const name of readdirSync(source)) {
  const from = join(source, name)
  const to = join(target, name)
  if (!existsSync(join(from, "SKILL.md"))) continue

  const current = lstatSync(to, { throwIfNoEntry: false })
  if (current?.isSymbolicLink() && readlinkSync(to) === from && !copy) {
    console.log(`${name}: already linked`)
    continue
  }
  if (current && !current.isSymbolicLink()) {
    console.log(`${name}: skipped, ${to} already exists and isn't one of ours`)
    continue
  }
  if (current) rmSync(to)
  if (copy) cpSync(from, to, { recursive: true })
  else symlinkSync(from, to, "dir")
  console.log(`${name}: ${copy ? "copied" : "linked"} → ${to}`)
}
