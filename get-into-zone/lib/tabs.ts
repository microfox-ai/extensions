// Tab helpers shared by the MCP bridge and the Midjourney API.

export const waitForTabLoad = (tabId: number, timeoutMs = 30_000) =>
  new Promise<chrome.tabs.Tab>((resolve, reject) => {
    const done = (finish: () => void) => {
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      finish()
    }
    const listener = (
      id: number,
      info: chrome.tabs.TabChangeInfo,
      tab: chrome.tabs.Tab
    ) => {
      if (id === tabId && info.status === "complete") done(() => resolve(tab))
    }
    const timer = setTimeout(
      () => done(() => reject(new Error("The tab took too long to load."))),
      timeoutMs
    )
    chrome.tabs.onUpdated.addListener(listener)
    chrome.tabs.get(tabId).then(
      (tab) => {
        if (tab.status === "complete" && !tab.pendingUrl) done(() => resolve(tab))
      },
      (error) => done(() => reject(error))
    )
  })

export async function openTab(url: string, active = true, waitForLoad = true) {
  const tab = await chrome.tabs.create({ url, active })
  return waitForLoad ? waitForTabLoad(tab.id!) : tab
}

// The tabs Claude opened with open_tab, the only ones close_tabs (and
// pinterest_bulk_stop's closeTab) may close: never the user's own tabs, nor
// the tabs Browse Hack keeps for its own work (Suno, Studio, DistroKid,
// Midjourney), where the user may still have something to click. Kept for the
// browser session, as tab ids are.
export const OPENED_TABS_KEY = "mcpOpenedTabs"

let openedChain: Promise<unknown> = Promise.resolve()

// Read-modify-writes in turn, so two tabs opened at once are both kept.
function updateOpened(change: (ids: number[]) => number[]) {
  const next = openedChain.then(async () => {
    const stored = await chrome.storage.session.get(OPENED_TABS_KEY)
    const ids: number[] = Array.isArray(stored[OPENED_TABS_KEY]) ? stored[OPENED_TABS_KEY] : []
    const changed = change(ids)
    if (changed.length !== ids.length || changed.some((id, i) => id !== ids[i])) {
      await chrome.storage.session.set({ [OPENED_TABS_KEY]: changed })
    }
    return changed
  })
  openedChain = next.catch(() => undefined)
  return next
}

export const openedTabIds = () => updateOpened((ids) => ids)

export const forgetOpenedTab = (tabId: number) =>
  updateOpened((ids) => ids.filter((id) => id !== tabId)).catch(() => undefined)

// openTab for open_tab: the tab is remembered as soon as it exists.
export async function openTabForClaude(url: string, active = true, waitForLoad = true) {
  const tab = await chrome.tabs.create({ url, active })
  await updateOpened((ids) => [...ids.filter((id) => id !== tab.id), tab.id!]).catch(() => undefined)
  return waitForLoad ? waitForTabLoad(tab.id!) : tab
}

export interface CloseTabsResult {
  closed: number[]
  notClosed?: { tabId: number; reason: string }[]
}

// Closes those of `tabIds` that Claude opened with open_tab; `beforeClose`
// runs first for each one closed (e.g. to stop its Pinterest session).
export async function closeOpenedTabs(
  tabIds: number[],
  beforeClose?: (tabId: number) => Promise<unknown>
): Promise<CloseTabsResult> {
  const opened = new Set(await openedTabIds())
  const closed: number[] = []
  const notClosed: { tabId: number; reason: string }[] = []
  for (const tabId of new Set(tabIds)) {
    const tab = await chrome.tabs.get(tabId).catch(() => undefined)
    if (!tab) {
      notClosed.push({ tabId, reason: "No tab with this id is open." })
      continue
    }
    if (!opened.has(tabId)) {
      notClosed.push({
        tabId,
        reason: "Not opened with open_tab, so it stays open: the user's own tabs and Browse Hack's work tabs are never closed."
      })
      continue
    }
    await beforeClose?.(tabId).catch(() => undefined)
    try {
      await chrome.tabs.remove(tabId)
    } catch (error) {
      notClosed.push({ tabId, reason: error instanceof Error ? error.message : String(error) })
      continue
    }
    await forgetOpenedTab(tabId)
    closed.push(tabId)
  }
  return { closed, ...(notClosed.length ? { notClosed } : {}) }
}
