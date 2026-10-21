import {
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  Globe,
  MonitorPlay,
  Power,
  Sparkles,
  X
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import {
  SAVER_RULES_KEY,
  SCOPE_ORDER,
  isAnySaverActive,
  isPinterestHost,
  isSaverActive,
  isYouTubeHost,
  loadSaverRules,
  readSaverRules,
  resolveSaverFeature,
  ruleMatches,
  scopeKey,
  setSaverRule,
  storeSaverRules,
  type SaverContext,
  type SaverFeature,
  type SaverRule,
  type SaverScope
} from "../lib/saverRules"

const ACCENT = "#4285F4"
const SCOPE_STORAGE_KEY = "saverScope"

const SCOPE_LABELS: Record<SaverScope, string> = {
  page: "This page",
  site: "This site",
  window: "This window",
  all: "Everywhere"
}

const FEATURES: {
  id: SaverFeature
  label: string
  hint: string
  icon: ReactNode
}[] = [
  {
    id: "all",
    label: "All savers",
    hint: "Every overlay, including the Suno upload panel",
    icon: <Power size={16} />
  },
  {
    id: "save",
    label: "Save button",
    hint: "The Save button on images and videos",
    icon: <Download size={16} />
  },
  {
    id: "ai",
    label: "AI analyse",
    hint: "Save + AI, AI Only and View AI buttons",
    icon: <Sparkles size={16} />
  },
  {
    id: "youtube",
    label: "YouTube download",
    hint: "Download buttons on YouTube thumbnails and under the video title",
    icon: <MonitorPlay size={16} />
  }
]

const FEATURE_LABELS = Object.fromEntries(
  FEATURES.map((f) => [f.id, f.label])
) as Record<SaverFeature, string>

interface TabInfo {
  ctx: SaverContext
  favIconUrl?: string
}

const ruleId = (r: SaverRule) => `${r.feature}|${r.scope}|${r.key}`

const scopePhrase = (scope: SaverScope) =>
  scope === "all" ? "everywhere" : `this ${scope}`

const ruleLocation = (rule: SaverRule, ctx: SaverContext) => {
  if (rule.scope === "all") return "Everywhere"
  if (rule.scope === "window") {
    return rule.key === String(ctx.windowId) ? "This window" : "Another window"
  }
  return rule.key
}

function Switch({
  on,
  dimmed,
  label,
  onToggle
}: {
  on: boolean
  dimmed?: boolean
  label: string
  onToggle: () => void
}) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      style={{
        position: "relative",
        width: 38,
        height: 22,
        flexShrink: 0,
        border: "none",
        borderRadius: 11,
        padding: 0,
        cursor: "pointer",
        backgroundColor: on ? ACCENT : "#ccc",
        opacity: dimmed ? 0.6 : 1,
        transition: "background-color 0.2s"
      }}>
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 19 : 3,
          width: 16,
          height: 16,
          borderRadius: "50%",
          backgroundColor: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
          transition: "left 0.2s"
        }}
      />
    </button>
  )
}

function RuleChip({
  rule,
  ctx,
  onRemove
}: {
  rule: SaverRule
  ctx: SaverContext
  onRemove: () => void
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        marginTop: 6,
        borderRadius: 6,
        background: "#f5f5f5",
        fontSize: 12
      }}>
      {rule.enabled ? (
        <Eye size={13} color="#1e8e3e" />
      ) : (
        <EyeOff size={13} color="#666" />
      )}
      <span style={{ whiteSpace: "nowrap" }}>
        {FEATURE_LABELS[rule.feature]} {rule.enabled ? "on" : "off"}
      </span>
      <span
        title={ruleLocation(rule, ctx)}
        style={{
          color: "#888",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          minWidth: 0,
          flex: 1
        }}>
        · {ruleLocation(rule, ctx)}
      </span>
      <button
        onClick={onRemove}
        aria-label="Remove rule"
        title="Remove rule"
        style={{
          display: "flex",
          border: "none",
          background: "transparent",
          padding: 2,
          cursor: "pointer",
          color: "#888"
        }}>
        <X size={13} />
      </button>
    </div>
  )
}

export function SaverTab() {
  const [rules, setRules] = useState<SaverRule[]>([])
  const [tab, setTab] = useState<TabInfo | null>(null)
  const [scope, setScope] = useState<SaverScope>("site")
  const [undo, setUndo] = useState<{
    previous: SaverRule[]
    cleared: SaverRule[]
  } | null>(null)
  const [showOtherRules, setShowOtherRules] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  useEffect(() => {
    loadSaverRules().then(setRules)
    chrome.storage.local.get(SCOPE_STORAGE_KEY, (result) => {
      if (SCOPE_ORDER.includes(result[SCOPE_STORAGE_KEY])) {
        setScope(result[SCOPE_STORAGE_KEY])
      }
    })
    chrome.tabs.query({ active: true, currentWindow: true }, ([active]) => {
      setTab({
        ctx: { url: active?.url, windowId: active?.windowId },
        favIconUrl: active?.favIconUrl
      })
    })

    const onChanged = (
      changes: Record<string, chrome.storage.StorageChange>,
      namespace: string
    ) => {
      if (namespace === "local" && changes[SAVER_RULES_KEY]) {
        setRules(readSaverRules(changes[SAVER_RULES_KEY].newValue))
      }
    }
    chrome.storage.onChanged.addListener(onChanged)
    return () => chrome.storage.onChanged.removeListener(onChanged)
  }, [])

  useEffect(() => {
    if (!confirmReset) return
    const timer = window.setTimeout(() => setConfirmReset(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmReset])

  if (!tab) return null

  const { ctx } = tab
  const siteKey = scopeKey("site", ctx)
  const pageKey = scopeKey("page", ctx)
  const isWebPage = siteKey !== null
  const scopeAvailable = (s: SaverScope) => scopeKey(s, ctx) !== null
  // Page and site scopes don't exist on chrome:// and similar pages.
  const activeScope = scopeAvailable(scope) ? scope : "window"
  const hostname = (() => {
    try {
      return new URL(ctx.url ?? "").hostname
    } catch {
      return ""
    }
  })()

  const allOn = resolveSaverFeature(rules, "all", ctx).enabled
  const isOn = (feature: SaverFeature) =>
    feature === "all" ? allOn : isSaverActive(rules, feature, ctx)
  const anyOn = isAnySaverActive(rules, ctx)

  const commit = (next: SaverRule[]) => {
    setRules(next)
    storeSaverRules(next)
  }

  const toggle = (feature: SaverFeature) => {
    const next = setSaverRule(rules, feature, activeScope, ctx, !isOn(feature))
    const scopeIndex = SCOPE_ORDER.indexOf(activeScope)
    const cleared = rules.filter(
      (r) => !next.includes(r) && SCOPE_ORDER.indexOf(r.scope) < scopeIndex
    )
    setUndo(cleared.length > 0 ? { previous: rules, cleared } : null)
    commit(next)
  }

  const removeRule = (rule: SaverRule) => {
    setUndo(null)
    commit(rules.filter((r) => r !== rule))
  }

  const pickScope = (s: SaverScope) => {
    setScope(s)
    chrome.storage.local.set({ [SCOPE_STORAGE_KEY]: s })
  }

  const statusLine = (feature: SaverFeature) => {
    if (feature !== "all" && !allOn) return "Paused by All savers"
    const { enabled, rule } = resolveSaverFeature(rules, feature, ctx)
    const base = rule
      ? `${enabled ? "On" : "Off"} · set for ${scopePhrase(rule.scope)}`
      : "On by default"
    if (feature === "ai" && isWebPage && !isPinterestHost(hostname)) {
      return `${base} · only appears on Pinterest`
    }
    if (feature === "youtube" && isWebPage && !isYouTubeHost(hostname)) {
      return `${base} · only appears on YouTube`
    }
    return base
  }

  const tabRules = rules.filter((r) => ruleMatches(r, ctx))
  const otherRules = rules.filter((r) => !ruleMatches(r, ctx))

  return (
    <div style={{ fontSize: 13, fontFamily: "system-ui, sans-serif" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 14
        }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 6,
            background: "#f1f3f4",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0
          }}>
          {tab.favIconUrl && isWebPage ? (
            <img src={tab.favIconUrl} alt="" width={16} height={16} />
          ) : (
            <Globe size={16} color="#666" />
          )}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}>
            {siteKey ?? "This tab"}
          </div>
          <div
            title={pageKey ?? undefined}
            style={{
              fontSize: 12,
              color: "#777",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap"
            }}>
            {isWebPage
              ? pageKey?.slice(siteKey!.length)
              : "Savers don't run on this page"}
          </div>
        </div>
        {isWebPage && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: "3px 8px",
              borderRadius: 10,
              whiteSpace: "nowrap",
              background: anyOn ? "#e6f4ea" : "#f1f3f4",
              color: anyOn ? "#1e8e3e" : "#666"
            }}>
            {anyOn ? "Active here" : "Off here"}
          </span>
        )}
      </div>

      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
        Apply changes to
      </div>
      <div
        style={{
          display: "flex",
          gap: 2,
          padding: 3,
          borderRadius: 8,
          background: "#f1f3f4"
        }}>
        {SCOPE_ORDER.map((s) => {
          const selected = s === activeScope
          const available = scopeAvailable(s)
          return (
            <button
              key={s}
              disabled={!available}
              onClick={() => pickScope(s)}
              style={{
                flex: 1,
                padding: "6px 0",
                border: "none",
                borderRadius: 6,
                fontSize: 12,
                cursor: available ? "pointer" : "not-allowed",
                background: selected ? "#fff" : "transparent",
                color: !available ? "#bbb" : selected ? "#202124" : "#555",
                fontWeight: selected ? 600 : 400,
                boxShadow: selected ? "0 1px 2px rgba(0,0,0,0.15)" : "none"
              }}>
              {SCOPE_LABELS[s]}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 10 }}>
        {FEATURES.map((feature, index) => {
          const on = isOn(feature.id)
          const dimmed = feature.id !== "all" && !allOn
          return (
            <div
              key={feature.id}
              title={feature.hint}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "10px 0",
                borderTop: index === 0 ? "none" : "1px solid #eee"
              }}>
              <span
                style={{
                  display: "flex",
                  color: dimmed ? "#aaa" : "#444"
                }}>
                {feature.icon}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: feature.id === "all" ? 600 : 400,
                    color: dimmed ? "#999" : "#202124"
                  }}>
                  {feature.label}
                </div>
                <div style={{ fontSize: 11, color: "#888" }}>
                  {statusLine(feature.id)}
                </div>
              </div>
              <Switch
                on={on}
                dimmed={dimmed}
                label={feature.label}
                onToggle={() => toggle(feature.id)}
              />
            </div>
          )
        })}
      </div>

      {undo && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            borderRadius: 6,
            background: "#e8f0fe",
            color: "#1a4fa0",
            fontSize: 12
          }}>
          <span style={{ flex: 1 }}>
            Also cleared {undo.cleared.length === 1 ? "a" : undo.cleared.length}{" "}
            narrower rule{undo.cleared.length === 1 ? "" : "s"} for{" "}
            {undo.cleared.map((r) => ruleLocation(r, ctx)).join(", ")}
          </span>
          <button
            onClick={() => {
              commit(undo.previous)
              setUndo(null)
            }}
            style={{
              border: "none",
              background: "transparent",
              color: ACCENT,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0
            }}>
            Undo
          </button>
        </div>
      )}

      <div
        style={{
          marginTop: 10,
          paddingTop: 10,
          borderTop: "1px solid #eee"
        }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "#666", flex: 1 }}>
            Rules affecting this tab
          </span>
          {rules.length > 0 && (
            <button
              onClick={() => {
                if (!confirmReset) {
                  setConfirmReset(true)
                  return
                }
                setConfirmReset(false)
                setUndo(null)
                commit([])
              }}
              style={{
                border: "1px solid #ddd",
                borderRadius: 6,
                background: confirmReset ? "#fce8e6" : "#fff",
                color: confirmReset ? "#c5221f" : "#555",
                fontSize: 11,
                padding: "3px 8px",
                cursor: "pointer"
              }}>
              {confirmReset ? "Click again to reset" : "Reset all"}
            </button>
          )}
        </div>

        {tabRules.length === 0 ? (
          <div style={{ fontSize: 12, color: "#999", marginTop: 6 }}>
            No rules here, so every saver is on.
          </div>
        ) : (
          tabRules.map((rule) => (
            <RuleChip
              key={ruleId(rule)}
              rule={rule}
              ctx={ctx}
              onRemove={() => removeRule(rule)}
            />
          ))
        )}

        {otherRules.length > 0 && (
          <>
            <button
              onClick={() => setShowOtherRules((v) => !v)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                marginTop: 10,
                border: "none",
                background: "transparent",
                padding: 0,
                fontSize: 12,
                color: ACCENT,
                cursor: "pointer"
              }}>
              {showOtherRules ? "Hide" : "Show"} {otherRules.length} rule
              {otherRules.length === 1 ? "" : "s"} for other pages
              <ChevronDown
                size={14}
                style={{
                  transform: showOtherRules ? "rotate(180deg)" : "none"
                }}
              />
            </button>
            {showOtherRules &&
              otherRules.map((rule) => (
                <RuleChip
                  key={ruleId(rule)}
                  rule={rule}
                  ctx={ctx}
                  onRemove={() => removeRule(rule)}
                />
              ))}
          </>
        )}
      </div>
    </div>
  )
}
