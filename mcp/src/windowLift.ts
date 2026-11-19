// Lifts the Chrome window a YouTube Studio step runs in above the app the user is in, on Windows, and puts it
// back afterwards. The extension asks for it over the bridge (window.lift, window.lower).
//
// Studio draws its account menu, lists and upload form only in a tab Chrome paints, and Chrome stops painting a
// window that is minimized or covered by another app. On a Mac the extension brings Chrome forward itself
// (chrome.windows.update with focused: true). Windows doesn't let a program in the background take the
// foreground (its foreground lock), so there Chrome only flashes its taskbar button and stays behind the app the
// user is in (Claude): the account menu never shows and every upload stops at "Couldn't find Switch account".
// This server is an ordinary Windows program, so it can put the window on top without activating it (keyboard
// focus stays in the app the user is in) and, once the step is done, back behind that app (or minimized again).
//
// The extension marks the Studio tab's title with a one-off token first: Chrome names its window after the tab in
// front, so the window to lift is the one whose title has the token.

import { execFile } from "node:child_process"

import type { Served } from "./bridge.js"

export type Lifted = { found: true; hwnd: string; below: string; minimized: boolean }
export type LiftResult = Lifted | { found: false }
export type LowerResult = { lowered: boolean; why?: string }

/** Runs a PowerShell script with these environment variables and gives its output. */
export type RunPowerShell = (script: string, env: Record<string, string>) => Promise<string>

const TOKEN = /^[A-Za-z0-9-]{8,80}$/
const HANDLE = /^\d{1,20}$/

// Win32 calls PowerShell can't make by itself. Find looks through the top-level windows for the marked title.
const WINDOWS_API = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BrowseHackWindow {
  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static IntPtr Find(string token) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr hwnd, IntPtr lParam) {
      if (!IsWindowVisible(hwnd)) return true;
      StringBuilder text = new StringBuilder(1024);
      GetWindowText(hwnd, text, text.Capacity);
      if (text.ToString().IndexOf(token, StringComparison.Ordinal) < 0) return true;
      found = hwnd;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
`

// SetWindowPos flags: SWP_NOSIZE 0x1, SWP_NOMOVE 0x2, SWP_NOACTIVATE 0x10, SWP_SHOWWINDOW 0x40.
// ShowWindow: SW_SHOWNOACTIVATE 4 (restore a minimized window without focus), SW_SHOWMINNOACTIVE 7.
const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOWS_API}
'@
$zero = [IntPtr]::Zero
if ($env:BH_ACTION -eq 'lift') {
  # Chrome takes the tab's new title a moment after it changes.
  $hwnd = $zero
  for ($i = 0; $i -lt 30 -and $hwnd -eq $zero; $i++) {
    $hwnd = [BrowseHackWindow]::Find($env:BH_TOKEN)
    if ($hwnd -eq $zero) { Start-Sleep -Milliseconds 100 }
  }
  if ($hwnd -eq $zero) { '{"found":false}'; exit }
  $front = [BrowseHackWindow]::GetForegroundWindow()
  if ($front -eq $hwnd) { $front = $zero }
  $minimized = [BrowseHackWindow]::IsIconic($hwnd)
  if ($minimized) { [void][BrowseHackWindow]::ShowWindow($hwnd, 4) }
  $flags = 0x1 -bor 0x2 -bor 0x10 -bor 0x40
  # On top of every window for a moment, then back among the ordinary ones: it stays above them, unfocused.
  [void][BrowseHackWindow]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, $flags)
  [void][BrowseHackWindow]::SetWindowPos($hwnd, [IntPtr](-2), 0, 0, 0, 0, $flags)
  '{"found":true,"hwnd":"' + $hwnd.ToInt64() + '","below":"' + $front.ToInt64() + '","minimized":' + "$minimized".ToLower() + '}'
  exit
}
$hwnd = [IntPtr][long]$env:BH_HWND
if (-not [BrowseHackWindow]::IsWindow($hwnd)) { '{"lowered":false,"why":"The window is closed."}'; exit }
if ([BrowseHackWindow]::GetForegroundWindow() -eq $hwnd) { '{"lowered":false,"why":"The user is in that window now."}'; exit }
if ($env:BH_MINIMIZE -eq '1') { [void][BrowseHackWindow]::ShowWindow($hwnd, 7); '{"lowered":true}'; exit }
$below = [IntPtr][long]$env:BH_BELOW
if ($below -eq $zero -or -not [BrowseHackWindow]::IsWindow($below)) { '{"lowered":false,"why":"No window to go behind."}'; exit }
[void][BrowseHackWindow]::SetWindowPos($hwnd, $below, 0, 0, 0, 0, 0x1 -bor 0x2 -bor 0x10)
'{"lowered":true}'
`

/** Windows PowerShell, which every Windows has; the script goes encoded, so nothing in it is parsed as arguments. */
const runPowerShell: RunPowerShell = (script, env) =>
  new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")
      ],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`PowerShell failed: ${String(stderr || error.message).trim().slice(0, 500)}`))
        else resolve(String(stdout))
      }
    )
  })

/** The JSON line the script ends with. */
function lastJson(output: string): any {
  const line = output.split(/\r?\n/).map((part) => part.trim()).filter(Boolean).pop()
  try {
    return JSON.parse(line ?? "")
  } catch {
    throw new Error(`Unexpected answer from PowerShell: ${output.trim().slice(0, 200)}`)
  }
}

function onlyOnWindows(platform: NodeJS.Platform) {
  if (platform !== "win32") throw new Error("Lifting a Chrome window is only for Windows; Chrome brings itself forward elsewhere.")
}

/** Lifts the window whose title has `titleToken` above the others without focusing it. */
export async function liftWindow(
  params: { titleToken?: unknown },
  run: RunPowerShell = runPowerShell,
  platform: NodeJS.Platform = process.platform
): Promise<LiftResult> {
  onlyOnWindows(platform)
  const token = String(params?.titleToken ?? "")
  if (!TOKEN.test(token)) throw new Error("titleToken must be 8 to 80 letters, digits or dashes.")
  const answer = lastJson(await run(SCRIPT, { BH_ACTION: "lift", BH_TOKEN: token }))
  if (!answer?.found) return { found: false }
  return { found: true, hwnd: String(answer.hwnd), below: String(answer.below), minimized: answer.minimized === true }
}

/** Puts a lifted window back: minimized again if it was, else behind the window that was in front. */
export async function lowerWindow(
  params: { hwnd?: unknown; below?: unknown; minimized?: unknown },
  run: RunPowerShell = runPowerShell,
  platform: NodeJS.Platform = process.platform
): Promise<LowerResult> {
  onlyOnWindows(platform)
  const hwnd = String(params?.hwnd ?? "")
  const below = String(params?.below ?? "0")
  if (!HANDLE.test(hwnd) || !HANDLE.test(below)) throw new Error("hwnd and below must be window handles (digits).")
  const answer = lastJson(
    await run(SCRIPT, { BH_ACTION: "lower", BH_HWND: hwnd, BH_BELOW: below, BH_MINIMIZE: params?.minimized === true ? "1" : "0" })
  )
  return { lowered: answer?.lowered === true, ...(typeof answer?.why === "string" ? { why: answer.why } : {}) }
}

/** What the bridge lets the extension ask of this server: only on Windows, the one place Chrome can't come forward. */
export function windowMethods(platform: NodeJS.Platform = process.platform): Served {
  if (platform !== "win32") return {}
  return {
    "window.lift": (params: any) => liftWindow(params),
    "window.lower": (params: any) => lowerWindow(params)
  }
}
