// Lifts a Chrome window above the app the user is in through the MCP server, for Windows.
//
// Studio draws its menus and forms only in a tab Chrome paints, so studioFront.ts brings the Studio tab forward.
// On a Mac chrome.windows.update({ focused: true }) brings Chrome in front of any app. Windows doesn't let a
// program in the background take the foreground: Chrome's taskbar button flashes, the window stays minimized or
// behind the app the user is in (Claude), and Studio's account menu never shows ("Couldn't find Switch account").
// The MCP server is an ordinary program on the computer, so it can lift the window without focusing it, and put
// it back afterwards (mcp/src/windowLift.ts). Only a server that can do it offers window.lift (on Windows); with
// none, or on a Mac, lift answers null and nothing changes.

/** A window the server lifted, and how to put it back: behind `below` (the window that was in front), or minimized. */
export type Lifted = { hwnd: string; below: string; minimized: boolean }

export type WindowLifter = {
  lift(tabId: number): Promise<Lifted | null>
  lower(lifted: Lifted): Promise<void>
}

type CallServer = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<any>

/** A lifter that asks the MCP server, when it serves window.lift. */
export function windowLifter(call: CallServer, serves: (method: string) => boolean): WindowLifter {
  return {
    async lift(tabId) {
      if (!serves("window.lift")) return null
      // Chrome names its window after the tab in front, so the server finds the window by this token in its title.
      const token = `bh-${crypto.randomUUID()}`
      if (!(await retitle(tabId, token, true))) return null
      try {
        const lifted = await call("window.lift", { titleToken: token }, 15_000)
        return lifted?.found ? { hwnd: String(lifted.hwnd), below: String(lifted.below), minimized: lifted.minimized === true } : null
      } finally {
        await retitle(tabId, token, false)
      }
    },
    async lower(lifted) {
      if (serves("window.lower")) await call("window.lower", lifted, 15_000)
    }
  }
}

/** Puts the token in front of the tab's title, or takes it out again. */
async function retitle(tabId: number, token: string, mark: boolean): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (prefix: string, add: boolean) => {
        const has = document.title.startsWith(prefix)
        if (add && !has) document.title = prefix + document.title
        if (!add && has) document.title = document.title.slice(prefix.length)
      },
      args: [`${token} `, mark]
    })
    return true
  } catch {
    return false
  }
}
