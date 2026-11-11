// Runs in a Google Images tab's own page (MAIN world, through
// chrome.scripting.executeScript), where Google's script loads more results.
// Self-contained: executeScript serializes only the function's body.
//
// The first call sets the page up: it reads the results' data in the page's
// inline scripts, and listens to the answers of Google's own requests for more
// results (sent when the user scrolls, or when "More results" is clicked), as
// that data is nowhere in the page once Google has read it. No request is sent
// to Google from here: more results come only through Google's own button.
// Each call returns the results that have both a card on the page and their
// data, in page order, from `cursor` on.

export interface GiPageCard {
  id: string
  pageUrl: string
  title: string
  // RESULT_PATTERN's groups, for decodeResult (lib/googleImages.ts).
  groups: string[]
}

export interface GiPage {
  // Changes when the page reloads (its count starts again).
  token: string
  url: string
  query: string
  cards: GiPageCard[]
  // Results read so far, and cards still without their data.
  total: number
  waiting: number
  cardsOnPage: number
  // Google's "More results" button is on the page.
  more: boolean
  clicked: boolean
  // Google is showing its "unusual traffic" check instead of results.
  blocked: boolean
  isResults: boolean
}

export function collectGoogleImages(
  pattern: string,
  cursor: number,
  token: string | null,
  loadMore: boolean,
  limit: number
): GiPage {
  const w = window as any
  type State = {
    token: string
    data: Map<string, string[]>
    list: GiPageCard[]
    listed: Set<string>
    scripts: WeakSet<Element>
  }
  let state: State = w.__browseHackGoogleImages
  const take = (text: string) => {
    if (!text || text.indexOf("[0,") < 0) return
    const re = new RegExp(pattern, "g")
    let match: RegExpExecArray | null
    while ((match = re.exec(text))) {
      if (!state.data.has(match[2])) state.data.set(match[2], match.slice(1))
    }
  }
  if (!state) {
    state = w.__browseHackGoogleImages = {
      token: Math.random().toString(36).slice(2),
      data: new Map<string, string[]>(),
      list: [],
      listed: new Set<string>(),
      scripts: new WeakSet<Element>()
    }
    const isSearch = (url: unknown) => /\/search\?/.test(String(url))
    const open = XMLHttpRequest.prototype.open
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: any[]) {
      try {
        if (isSearch(args[1])) {
          this.addEventListener("load", () => {
            try {
              if (!this.responseType || this.responseType === "text") take(this.responseText)
            } catch {
              // An answer that can't be read as text has no results in it.
            }
          })
        }
      } catch {
        // Never get in the way of Google's own request.
      }
      return (open as any).apply(this, args)
    } as typeof XMLHttpRequest.prototype.open
    const fetch = window.fetch
    window.fetch = function (this: unknown, ...args: any[]) {
      const pending = (fetch as any).apply(this, args) as Promise<Response>
      try {
        const input = args[0]
        if (isSearch(typeof input === "string" ? input : input?.url)) {
          pending.then((response) => response.clone().text().then(take)).catch(() => undefined)
        }
      } catch {
        // As above.
      }
      return pending
    } as typeof window.fetch
  }

  // Inline scripts: the first results' data, and any Google adds later.
  document.querySelectorAll("script:not([src])").forEach((script) => {
    if (state.scripts.has(script)) return
    state.scripts.add(script)
    take(script.textContent || "")
  })

  const cards = document.querySelectorAll("div[data-docid][data-lpage]")
  let waiting = 0
  cards.forEach((card) => {
    const id = card.getAttribute("data-docid") || ""
    if (!id || state.listed.has(id)) return
    const groups = state.data.get(id)
    if (!groups) {
      waiting++
      return
    }
    state.listed.add(id)
    const img = card.querySelector("img[alt]")
    state.list.push({
      id,
      pageUrl: card.getAttribute("data-lpage") || "",
      title: (img?.getAttribute("alt") || "").trim(),
      groups
    })
  })

  const button = [
    ...document.querySelectorAll<HTMLElement>("a[jsname='oHxHid'], [aria-label='More results'][role='button']")
  ].find((el) => el.getAttribute("aria-hidden") !== "true" && getComputedStyle(el).display !== "none")
  let clicked = false
  if (loadMore) {
    const root = document.scrollingElement || document.documentElement
    window.scrollTo(0, root.scrollHeight)
    if (button) {
      button.click()
      clicked = true
    }
  }

  const blocked =
    location.pathname.startsWith("/sorry") ||
    Boolean(document.querySelector("form#captcha-form, #recaptcha, iframe[src*='recaptcha']"))
  const from = token === state.token ? Math.max(0, cursor) : 0
  return {
    token: state.token,
    url: location.href,
    query: new URLSearchParams(location.search).get("q") || "",
    cards: state.list.slice(from, from + Math.max(1, limit)),
    total: state.list.length,
    waiting,
    cardsOnPage: cards.length,
    more: Boolean(button),
    clicked,
    blocked,
    isResults: location.pathname === "/search"
  }
}
