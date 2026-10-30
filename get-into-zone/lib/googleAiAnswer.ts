// Reads Google's AI Mode answer for a query, as it appears on the page, so the
// MCP server can save it to a file word for word. Opens google.com/search?udm=50
// in a background tab (or reads a tab the user already has open), waits for the
// answer to stop streaming, then returns it as Markdown with its source links.

import { openTab } from "./tabs"

export type AiAnswerPage = {
  matched: string | null
  markdown: string
  text: string
  sources: { title: string; url: string }[]
  html?: string
}

// Runs inside the Google tab. Self-contained: executeScript serializes only this body.
function readAiAnswer(selector: string | null, includeHtml: boolean): AiAnswerPage {
  const candidates = selector
    ? [selector]
    : [
        // AI Mode: the answer column, without the source cards beside it.
        '[data-container-id="main-col"]',
        '[data-subtree="aimc"]',
        '[data-attrid="AIOverview"]',
        "#m-x-content",
        'div[role="main"]',
        "#rcnt",
        "main"
      ]
  let root: HTMLElement | null = null
  let matched: string | null = null
  for (const candidate of candidates) {
    const el = document.querySelector<HTMLElement>(candidate)
    if (el && el.innerText.trim().length > 200) {
      root = el
      matched = candidate
      break
    }
  }
  if (!root) return { matched: null, markdown: "", text: "", sources: [] }

  // Copy-excluded bits (citation chips, toolbar, image carousel), inline
  // citation markers and the toolbar at the end of the answer.
  const EXCLUDED = '[data-ignore-copy], span.DHPVt, [data-xid="Gd7Hsc"]'
  const skipped = (el: HTMLElement) =>
    SKIP.has(el.tagName) ||
    el.getAttribute("aria-hidden") === "true" ||
    el.getAttribute("role") === "button" ||
    el.matches(EXCLUDED) ||
    !visible(el)
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "BUTTON", "INPUT", "TEXTAREA", "IMG", "VIDEO", "IFRAME", "TEMPLATE"])
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|HEADER|FOOTER|BLOCKQUOTE|FIGURE|UL|OL|TABLE|HR|H[1-6])$/

  // Only display: none counts as hidden. Google fades the answer in with
  // opacity, which stays at 0 in a background tab, and checkVisibility() or a
  // visibility check would drop the whole answer.
  const visible = (el: Element) => !(el as HTMLElement).hidden && getComputedStyle(el).display !== "none"
  const realUrl = (href: string) => {
    try {
      const url = new URL(href, location.href)
      if (/google\./.test(url.hostname) && url.pathname === "/url") return url.searchParams.get("q") || url.searchParams.get("url") || href
      return url.href
    } catch {
      return href
    }
  }

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "").replace(/\s+/g, " ")
    if (node.nodeType !== Node.ELEMENT_NODE) return ""
    const el = node as HTMLElement
    if (skipped(el)) return ""
    if (el.tagName === "BR") return "\n"
    const inner = Array.from(el.childNodes).map(inline).join("")
    if (!inner.trim()) return inner
    if (el.tagName === "STRONG" || el.tagName === "B") return `**${inner.trim()}** `
    if (el.tagName === "EM" || el.tagName === "I") return `*${inner.trim()}* `
    if (el.tagName === "CODE") return `\`${inner.trim()}\``
    if (el.tagName === "A") {
      const href = el.getAttribute("href")
      return href && /^https?:|^\//.test(href) ? `[${inner.trim()}](${realUrl(href)})` : inner
    }
    return inner
  }

  const lines: string[] = []
  const block = (el: HTMLElement, depth: number) => {
    if (skipped(el)) return
    const tag = el.tagName
    // Google draws section titles as <div role="heading" aria-level="3">.
    // h1-h6 move down one level, below the file's own title.
    const hLevel = /^H([1-6])$/.exec(tag)?.[1]
    const level = hLevel
      ? Number(hLevel) + 1
      : el.getAttribute("role") === "heading"
        ? Number(el.getAttribute("aria-level")) || 2
        : 0
    if (level) {
      const title = inline(el).replace(/\s+/g, " ").trim()
      if (title) lines.push("", `${"#".repeat(Math.min(level, 6))} ${title}`, "")
      return
    }
    if (tag === "HR") {
      lines.push("---", "")
      return
    }
    if (tag === "UL" || tag === "OL") {
      let n = 0
      for (const li of Array.from(el.children) as HTMLElement[]) {
        if (li.tagName !== "LI" || skipped(li) || !li.innerText.trim()) continue
        n++
        const nested = Array.from(li.children).filter((c) => c.tagName === "UL" || c.tagName === "OL") as HTMLElement[]
        const own = Array.from(li.childNodes)
          .filter((c) => !nested.includes(c as HTMLElement))
          .map(inline)
          .join("")
          .replace(/[ \t]+/g, " ")
          .trim()
        lines.push(`${"  ".repeat(depth)}${tag === "OL" ? `${n}.` : "-"} ${own}`)
        for (const list of nested) block(list, depth + 1)
      }
      if (depth === 0) lines.push("")
      return
    }
    if (tag === "TABLE") {
      const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
        Array.from(tr.children).map((cell) => inline(cell).replace(/\|/g, "\\|").trim())
      )
      if (rows.length) {
        lines.push(`| ${rows[0].join(" | ")} |`, `|${rows[0].map(() => " --- ").join("|")}|`)
        for (const row of rows.slice(1)) lines.push(`| ${row.join(" | ")} |`)
        lines.push("")
      }
      return
    }
    // A block whose children are all inline is one paragraph; otherwise recurse.
    const hasBlockChild = Array.from(el.children).some(
      (c) => BLOCK.test(c.tagName) || getComputedStyle(c).display.startsWith("block") || getComputedStyle(c).display === "flex"
    )
    if (!hasBlockChild) {
      const text = inline(el).replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim()
      if (text) lines.push(text, "")
      return
    }
    for (const child of Array.from(el.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) block(child as HTMLElement, depth)
      else if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent || "").replace(/\s+/g, " ").trim()
        if (text) lines.push(text, "")
      }
    }
  }
  block(root, 0)

  const markdown = lines
    .join("\n")
    .replace(/\*\* ([.,;:!?)])/g, "**$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim()

  const seen = new Set<string>()
  const sources: { title: string; url: string }[] = []
  // The source cards sit next to the answer column, so look at the whole answer.
  const sourceRoot = root.closest('[data-subtree="aimc"]') || root
  for (const a of Array.from(sourceRoot.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const url = realUrl(a.getAttribute("href") || "")
    if (!/^https?:/.test(url) || /^https?:\/\/([a-z]+\.)?google\.[a-z.]+\//.test(url) || seen.has(url)) continue
    seen.add(url)
    sources.push({ title: (a.innerText || a.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(), url })
  }

  return {
    matched,
    markdown,
    text: root.innerText.trim(),
    sources,
    html: includeHtml ? root.outerHTML : undefined
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function googleAiAnswer(params: {
  query?: string
  tabId?: number
  selector?: string
  includeHtml?: boolean
  timeoutMs?: number
  keepTab?: boolean
}) {
  const query = typeof params.query === "string" ? params.query.trim() : ""
  if (!query && params.tabId === undefined) throw new Error("Give a query, or the tabId of a Google AI Mode tab.")

  const opened = params.tabId === undefined
  const tab = opened
    ? await openTab(`https://www.google.com/search?udm=50&q=${encodeURIComponent(query)}`, false)
    : await chrome.tabs.get(Number(params.tabId))
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 120_000, 10_000), 300_000)
  const deadline = Date.now() + timeoutMs

  try {
    // The answer streams in; take it once it has stopped growing for a few reads.
    let last: AiAnswerPage | undefined
    let stableReads = 0
    while (Date.now() < deadline) {
      await sleep(1500)
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: readAiAnswer,
        args: [params.selector || null, false]
      })
      const page = injection?.result as AiAnswerPage | undefined
      if (!page?.markdown) continue
      stableReads = last && last.markdown === page.markdown ? stableReads + 1 : 0
      last = page
      if (stableReads >= 3) break
    }
    if (!last?.markdown)
      throw new Error(
        "Couldn't find an AI Mode answer on the page. Google may be showing a sign-in, consent or captcha page in that tab."
      )
    if (params.includeHtml) {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: readAiAnswer,
        args: [params.selector || null, true]
      })
      last = (injection?.result as AiAnswerPage) || last
    }
    const current = await chrome.tabs.get(tab.id!)
    return {
      ...last,
      url: current.url,
      title: current.title,
      complete: stableReads >= 3
    }
  } finally {
    if (opened && !params.keepTab) await chrome.tabs.remove(tab.id!).catch(() => {})
  }
}
