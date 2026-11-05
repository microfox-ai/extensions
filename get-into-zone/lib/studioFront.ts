// Brings a YouTube Studio tab to the front only while Browse Hack works in Studio's page, and puts the
// user's own tab back afterwards.
//
// Studio draws its menus, dialogs and lists only in a tab Chrome is painting. Measured in Chrome with
// the Studio tab behind another tab: the account menu's "Switch account" is on the page but never
// shows (PR #28's "Couldn't find Switch account"), the Content list shows no rows until the tab comes
// forward, and 100 ms timers run once a second. Opening Studio, its reload after a channel switch and
// the files streaming in all work behind the user's tab, so only the steps that use Studio's page (the
// account menu, reading the Shorts list or a video's details, filling the form) come forward.

/** How long a Studio tab stays in front after its step, so back-to-back steps don't flicker. */
export const PUT_BACK_AFTER_MS = 3000

type Behind = {
  /** The Studio tab's window, and the tab that was in front in it. */
  windowId: number
  tabId?: number
  /** Browse Hack focused that window (it wasn't being painted), and the Chrome window that had focus then. */
  raised: boolean
  focusedWindowId?: number
}

let behind: Behind | null = null
/** The Studio tabs brought forward since `behind` was noted. */
const brought = new Set<number>()
let steps = 0
let timer: ReturnType<typeof setTimeout> | undefined
let restoring: Promise<void> = Promise.resolve()

/** Runs `step` with the Studio tab in front, then puts the user's tab back a moment later. */
export async function inFront<T>(tabId: number, step: () => Promise<T>): Promise<T> {
  clearTimeout(timer)
  timer = undefined
  steps++
  try {
    await bringForward(tabId)
    return await step()
  } finally {
    steps--
    if (!steps) timer = setTimeout(() => void putBack(), PUT_BACK_AFTER_MS)
  }
}

/** Closes a Studio tab. The user's tab comes back first, so Chrome doesn't show the closed tab's neighbour. */
export async function closeStudioTab(tabId: number) {
  await putBack()
  await chrome.tabs.remove(tabId).catch(() => {})
}

/** Puts back the tab (and window) that was in front before, unless the user has moved to another tab since. */
export function putBack(force = false): Promise<void> {
  clearTimeout(timer)
  timer = undefined
  if ((steps && !force) || !behind) return restoring
  const was = behind
  const ours = new Set(brought)
  behind = null
  brought.clear()
  restoring = restoring.then(async () => {
    const [active] = await chrome.tabs.query({ active: true, windowId: was.windowId }).catch(() => [] as chrome.tabs.Tab[])
    if (active?.id === undefined || !ours.has(active.id)) return
    if (was.tabId !== undefined && was.tabId !== active.id) {
      await chrome.tabs.update(was.tabId, { active: true }).catch(() => {})
    }
    if (was.raised && was.focusedWindowId !== undefined && was.focusedWindowId !== was.windowId) {
      await chrome.windows.update(was.focusedWindowId, { focused: true }).catch(() => {})
    }
  })
  return restoring
}

async function bringForward(tabId: number) {
  try {
    await restoring
    const tab = await chrome.tabs.get(tabId)
    if (behind && behind.windowId !== tab.windowId) await putBack(true)
    if (!behind) {
      const [active] = await chrome.tabs.query({ active: true, windowId: tab.windowId })
      behind = { windowId: tab.windowId, tabId: active?.id, raised: false }
    }
    brought.add(tabId)
    if (!tab.active) await chrome.tabs.update(tabId, { active: true })
    if (await painting(tabId)) return
    // Chrome's window is minimized or covered by another app, so it isn't painted until it has focus.
    if (!behind.raised) {
      const focused = await chrome.windows.getLastFocused().catch(() => undefined)
      behind.raised = true
      behind.focusedWindowId = focused?.focused ? focused.id : undefined
    }
    await chrome.windows.update(tab.windowId, { focused: true })
    await painting(tabId, 3000)
  } catch {
    // The tab is gone or Chrome refused; the step itself reports what went wrong.
  }
}

/** Whether Chrome paints the tab: an animation frame only comes in a tab that is on screen. */
async function painting(tabId: number, waitMs = 1000): Promise<boolean> {
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (wait: number) =>
        new Promise<boolean>((resolve) => {
          const timeout = setTimeout(() => resolve(false), wait)
          requestAnimationFrame(() => {
            clearTimeout(timeout)
            resolve(true)
          })
        }),
      args: [waitMs]
    })
    return frame?.result === true
  } catch {
    return false
  }
}
