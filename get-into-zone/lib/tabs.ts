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
