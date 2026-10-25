import {
  SAVER_RULES_KEY,
  SAVER_FEATURES,
  isAnySaverActive,
  loadSaverRules,
  readSaverRules,
  setSaverRule,
  storeSaverRules,
  type SaverContext,
  type SaverRule,
  type SaverScope
} from "./saverRules"

const MENU_ID = "saver-toggle"
const MENU_SCOPES: [SaverScope, string][] = [
  ["page", "On this page"],
  ["site", "On this site"],
  ["window", "In this window"],
  ["all", "Everywhere"]
]
const MENU_CONTEXTS: chrome.contextMenus.ContextType[] = [
  "page",
  "image",
  "video",
  "link",
  "selection",
  "frame"
]
const MENU_URL_PATTERNS = ["http://*/*", "https://*/*"]

const tabContext = (tab: chrome.tabs.Tab): SaverContext => ({
  url: tab.url,
  windowId: tab.windowId
})

const updateBadge = (tab: chrome.tabs.Tab, rules: SaverRule[]) => {
  if (tab.id === undefined) return
  const ctx = tabContext(tab)
  // Only flag http(s) pages; savers never run on chrome:// and similar.
  const off = /^https?:/.test(tab.url ?? "") && !isAnySaverActive(rules, ctx)
  chrome.action.setBadgeText({ tabId: tab.id, text: off ? "OFF" : "" })
  if (off) {
    chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#6b7280" })
  }
}

// The context menu title is global, so it follows the focused tab.
const refreshMenuTitle = async (rules?: SaverRule[]) => {
  const current = rules ?? (await loadSaverRules())
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  })
  const active = tab ? isAnySaverActive(current, tabContext(tab)) : true
  chrome.contextMenus.update(
    MENU_ID,
    { title: active ? "Hide savers" : "Show savers" },
    () => void chrome.runtime.lastError
  )
}

const refreshTab = async (tab: chrome.tabs.Tab) => {
  const rules = await loadSaverRules()
  updateBadge(tab, rules)
  if (tab.active) refreshMenuTitle(rules)
}

const refreshAllTabs = async (rules?: SaverRule[]) => {
  const current = rules ?? (await loadSaverRules())
  const tabs = await chrome.tabs.query({})
  tabs.forEach((tab) => updateBadge(tab, current))
  refreshMenuTitle(current)
}

const createContextMenu = () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Hide savers",
      contexts: MENU_CONTEXTS,
      documentUrlPatterns: MENU_URL_PATTERNS
    })
    MENU_SCOPES.forEach(([scope, title]) => {
      chrome.contextMenus.create({
        id: `${MENU_ID}:${scope}`,
        parentId: MENU_ID,
        title,
        contexts: MENU_CONTEXTS,
        documentUrlPatterns: MENU_URL_PATTERNS
      })
    })
    refreshAllTabs()
  })
}

// Window ids are only valid for the window's lifetime, so window rules go away
// when their window closes and when the browser restarts.
const removeWindowRules = async (windowId?: number) => {
  const rules = await loadSaverRules()
  const next = rules.filter(
    (r) =>
      r.scope !== "window" ||
      (windowId !== undefined && r.key !== String(windowId))
  )
  if (next.length !== rules.length) await storeSaverRules(next)
}

// The old Settings toggle ("Save overlay on images") becomes an "all savers
// off everywhere" rule.
const migrateLegacyToggle = () => {
  chrome.storage.local.get([SAVER_RULES_KEY, "isButtonEnabled"], (result) => {
    if (result.isButtonEnabled === undefined) return
    if (result.isButtonEnabled === false && !result[SAVER_RULES_KEY]) {
      chrome.storage.local.set({
        [SAVER_RULES_KEY]: [
          { feature: "all", scope: "all", key: "*", enabled: false }
        ]
      })
    }
    chrome.storage.local.remove("isButtonEnabled")
  })
}

export function initSaverBackground() {
  chrome.runtime.onInstalled.addListener(() => {
    migrateLegacyToggle()
    createContextMenu()
  })

  chrome.runtime.onStartup.addListener(() => {
    removeWindowRules().then(() => refreshAllTabs())
  })

  chrome.windows.onRemoved.addListener((windowId) => {
    removeWindowRules(windowId)
  })

  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "local" && changes[SAVER_RULES_KEY]) {
      refreshAllTabs(readSaverRules(changes[SAVER_RULES_KEY].newValue))
    }
  })

  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.url || changeInfo.status === "complete") refreshTab(tab)
  })

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab) refreshTab(tab)
    })
  })

  chrome.windows.onFocusChanged.addListener(() => {
    refreshMenuTitle()
  })

  // A tab dragged into another window has a new window id; tell its content
  // script so window rules keep matching.
  chrome.tabs.onAttached.addListener((tabId, { newWindowId }) => {
    chrome.tabs.sendMessage(
      tabId,
      { action: "saverWindowChanged", windowId: newWindowId },
      () => void chrome.runtime.lastError
    )
    chrome.tabs.get(tabId, (tab) => {
      if (!chrome.runtime.lastError && tab) refreshTab(tab)
    })
  })

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request?.action !== "getSaverContext") return
    sendResponse({ windowId: sender.tab?.windowId })
  })

  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const id = String(info.menuItemId)
    if (!id.startsWith(`${MENU_ID}:`) || !tab) return
    const scope = id.slice(MENU_ID.length + 1) as SaverScope
    const ctx: SaverContext = {
      url: info.pageUrl || tab.url,
      windowId: tab.windowId
    }
    const rules = await loadSaverRules()
    const next = isAnySaverActive(rules, ctx)
      ? setSaverRule(rules, "all", scope, ctx, false)
      : SAVER_FEATURES.reduce(
          (acc, feature) => setSaverRule(acc, feature, scope, ctx, true),
          rules
        )
    await storeSaverRules(next)
  })
}
