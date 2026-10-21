// Shared rules engine for toggling the on-page saver overlays.
// Used by the content script (to decide what to render), the background
// worker (badge + context menu) and the popup Saver tab.

export const SAVER_RULES_KEY = "saverRules"

// "all" is the master switch: it covers every overlay (Save button, AI
// buttons, the YouTube download buttons and the Suno upload panel). "save",
// "ai" and "youtube" are individual savers.
export type SaverFeature = "all" | "save" | "ai" | "youtube"
export type SaverScope = "page" | "site" | "window" | "all"

export interface SaverRule {
  feature: SaverFeature
  scope: SaverScope
  key: string
  enabled: boolean
}

export interface SaverContext {
  url?: string
  windowId?: number
}

// Narrowest first: a page rule beats a site rule, which beats a window rule,
// which beats an "everywhere" rule. With no matching rule a saver is on.
export const SCOPE_ORDER: SaverScope[] = ["page", "site", "window", "all"]

export const SAVER_FEATURES: SaverFeature[] = ["all", "save", "ai", "youtube"]

const parseHttpUrl = (url?: string): URL | null => {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed
      : null
  } catch {
    return null
  }
}

const siteOf = (url: URL) => url.host.replace(/^www\./, "").toLowerCase()

export const isPinterestHost = (hostname: string) =>
  /(^|\.)pinterest\./i.test(hostname) ||
  hostname === "pin.it" ||
  hostname.endsWith(".pin.it")

export const isSunoHost = (hostname: string) => hostname === "suno.com"

export const isYouTubeHost = (hostname: string) =>
  hostname === "youtube.com" || hostname.endsWith(".youtube.com")

// The key a rule at `scope` would have for this context, or null when the
// scope doesn't apply (e.g. no window id yet, or a chrome:// page).
export function scopeKey(scope: SaverScope, ctx: SaverContext): string | null {
  if (scope === "all") return "*"
  if (scope === "window") {
    return typeof ctx.windowId === "number" && ctx.windowId >= 0
      ? String(ctx.windowId)
      : null
  }
  const url = parseHttpUrl(ctx.url)
  if (!url) return null
  if (scope === "site") return siteOf(url)
  // A "page" is the site plus path; query strings and hashes are ignored so
  // tracking params and in-page anchors don't create separate pages.
  const path = url.pathname.replace(/\/+$/, "") || "/"
  return siteOf(url) + path
}

export const ruleMatches = (rule: SaverRule, ctx: SaverContext) =>
  rule.key === scopeKey(rule.scope, ctx)

export function resolveSaverFeature(
  rules: SaverRule[],
  feature: SaverFeature,
  ctx: SaverContext
): { enabled: boolean; rule: SaverRule | null } {
  for (const scope of SCOPE_ORDER) {
    const key = scopeKey(scope, ctx)
    if (key === null) continue
    const rule = rules.find(
      (r) => r.feature === feature && r.scope === scope && r.key === key
    )
    if (rule) return { enabled: rule.enabled, rule }
  }
  return { enabled: true, rule: null }
}

export function isSaverActive(
  rules: SaverRule[],
  feature: SaverFeature,
  ctx: SaverContext
): boolean {
  if (!resolveSaverFeature(rules, "all", ctx).enabled) return false
  return feature === "all" || resolveSaverFeature(rules, feature, ctx).enabled
}

// Whether the page shows any overlay at all, given which overlays the
// content script renders on that site.
export function isAnySaverActive(rules: SaverRule[], ctx: SaverContext) {
  const url = parseHttpUrl(ctx.url)
  if (!url || !isSaverActive(rules, "all", ctx)) return false
  if (isSunoHost(url.hostname)) return true
  if (isSaverActive(rules, "save", ctx)) return true
  if (isYouTubeHost(url.hostname) && isSaverActive(rules, "youtube", ctx)) {
    return true
  }
  return isPinterestHost(url.hostname) && isSaverActive(rules, "ai", ctx)
}

// Turn a saver on or off at `scope` for the given context. Rules for the same
// saver at this scope or narrower that match the context are dropped, so the
// change always takes effect on the current tab. No rule is stored when the
// inherited value already matches, which keeps the rule list minimal.
export function setSaverRule(
  rules: SaverRule[],
  feature: SaverFeature,
  scope: SaverScope,
  ctx: SaverContext,
  enabled: boolean
): SaverRule[] {
  const key = scopeKey(scope, ctx)
  if (key === null) return rules

  const maxIndex = SCOPE_ORDER.indexOf(scope)
  let next = rules.filter(
    (r) =>
      !(
        r.feature === feature &&
        SCOPE_ORDER.indexOf(r.scope) <= maxIndex &&
        ruleMatches(r, ctx)
      )
  )
  if (resolveSaverFeature(next, feature, ctx).enabled !== enabled) {
    next = [...next, { feature, scope, key, enabled }]
  }

  // Turning a saver on while "all savers" is off would leave it hidden.
  if (
    feature !== "all" &&
    enabled &&
    !resolveSaverFeature(next, "all", ctx).enabled
  ) {
    next = setSaverRule(next, "all", scope, ctx, true)
  }
  return next
}

export const readSaverRules = (value: unknown): SaverRule[] =>
  Array.isArray(value)
    ? value.filter(
        (r): r is SaverRule =>
          r &&
          SAVER_FEATURES.includes(r.feature) &&
          SCOPE_ORDER.includes(r.scope) &&
          typeof r.key === "string" &&
          typeof r.enabled === "boolean"
      )
    : []

export const loadSaverRules = () =>
  new Promise<SaverRule[]>((resolve) => {
    chrome.storage.local.get(SAVER_RULES_KEY, (result) => {
      resolve(readSaverRules(result[SAVER_RULES_KEY]))
    })
  })

export const storeSaverRules = (rules: SaverRule[]) =>
  new Promise<void>((resolve) => {
    chrome.storage.local.set({ [SAVER_RULES_KEY]: rules }, () => resolve())
  })
