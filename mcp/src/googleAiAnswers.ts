// Saves Google AI Mode answers to files exactly as Google shows them. The
// extension reads each answer from a Google tab; this writes it to disk and
// returns only the file paths and sizes, so the answer text itself never has to
// pass through Claude.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, resolve } from "node:path"

import type { Bridge } from "./bridge.js"

export type AnswerItem = { query?: string; tabId?: number; file: string }

type SaveParams = {
  items?: AnswerItem[]
  itemsFile?: string
  format?: "markdown" | "text"
  header?: boolean
  overwrite?: boolean
  saveHtml?: boolean
  selector?: string
  timeoutMs?: number
}

type Answer = {
  matched: string | null
  markdown: string
  text: string
  sources: { title: string; url: string }[]
  html?: string
  url?: string
  title?: string
  complete: boolean
}

function resolvePath(input: string, base?: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith("~/")) return resolve(homedir(), trimmed.slice(2))
  if (isAbsolute(trimmed)) return trimmed
  if (base) return resolve(base, trimmed)
  throw new Error(`"${input}" isn't an absolute path.`)
}

const exists = (path: string) => stat(path).then(() => true, () => false)

async function loadItems(params: SaveParams): Promise<AnswerItem[]> {
  const items = [...(params.items ?? [])]
  if (params.itemsFile) {
    const file = resolvePath(params.itemsFile)
    const data = JSON.parse(await readFile(file, "utf8"))
    const list: AnswerItem[] = Array.isArray(data) ? data : data.items
    if (!Array.isArray(list)) throw new Error(`${file} needs an array of items, or { items: [...] }.`)
    for (const item of list) items.push({ ...item, file: resolvePath(item.file, dirname(file)) })
  }
  if (!items.length) throw new Error("Give items or an itemsFile.")
  return items.map((item) => ({ ...item, file: resolvePath(item.file) }))
}

function render(item: AnswerItem, answer: Answer, params: SaveParams) {
  const body = params.format === "text" ? answer.text : answer.markdown
  const parts: string[] = []
  if (params.header !== false) {
    parts.push(
      `# ${item.query || answer.title || "Google AI Mode answer"}`,
      "",
      `_Google AI Mode, saved ${new Date().toISOString().slice(0, 10)} from ${answer.url}_`,
      ""
    )
  }
  parts.push(body.trim(), "")
  if (params.header !== false && answer.sources.length) {
    parts.push("## Sources", "")
    for (const source of answer.sources) parts.push(`- [${source.title || source.url}](${source.url})`)
    parts.push("")
  }
  return parts.join("\n")
}

export async function saveGoogleAiAnswers(bridge: Bridge, params: SaveParams) {
  const items = await loadItems(params)
  const timeoutMs = params.timeoutMs ?? 120_000
  const results = []
  // One at a time: Google rate-limits a burst of searches with a captcha.
  for (const item of items) {
    try {
      if (!params.overwrite && (await exists(item.file))) {
        results.push({ file: item.file, ok: true, skipped: "File already exists (pass overwrite: true to replace it)." })
        continue
      }
      const answer = (await bridge.call(
        "google.aiAnswer",
        { query: item.query, tabId: item.tabId, selector: params.selector, includeHtml: params.saveHtml, timeoutMs },
        timeoutMs + 30_000
      )) as Answer
      await mkdir(dirname(item.file), { recursive: true })
      await writeFile(item.file, render(item, answer, params), "utf8")
      if (params.saveHtml && answer.html) await writeFile(item.file.replace(/\.[^./]*$/, "") + ".html", answer.html, "utf8")
      results.push({
        file: item.file,
        ok: true,
        characters: (params.format === "text" ? answer.text : answer.markdown).length,
        sources: answer.sources.length,
        matchedSelector: answer.matched,
        finishedStreaming: answer.complete
      })
    } catch (error) {
      results.push({ file: item.file, ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    saved: results.filter((r) => r.ok && !("skipped" in r)).length,
    failed: results.filter((r) => !r.ok).length,
    results
  }
}
