import type { PlasmoCSConfig } from "plasmo"

import { pinUrlFromHash } from "../lib/pinSavePro"

// Fills PinSavePro's form with the pin the Pinterest toast sent here, then
// clicks its download link. A security check is left for the user.
export const config: PlasmoCSConfig = {
  matches: ["https://pinsavepro.com/*", "https://www.pinsavepro.com/*"],
  run_at: "document_idle"
}

const STEP_TIMEOUT_MS = 30_000
const POLL_MS = 250

const BANNER_STYLE =
  "position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483000;max-width:min(560px,calc(100vw - 32px));" +
  "padding:12px 16px;border-radius:12px;background:#111;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.3);" +
  "font:500 14px/1.4 -apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;"

let banner: HTMLDivElement | null = null

function say(text: string, tone: "info" | "done" | "error" = "info") {
  if (!banner) {
    banner = document.createElement("div")
    banner.setAttribute("style", BANNER_STYLE)
    document.body.append(banner)
  }
  banner.style.borderLeft = `4px solid ${tone === "done" ? "#81c995" : tone === "error" ? "#ff8a80" : "#e60023"}`
  banner.textContent = `Browse Hack: ${text}`
}

async function waitFor<T>(find: () => T | null | undefined): Promise<T | null> {
  for (let waited = 0; waited < STEP_TIMEOUT_MS; waited += POLL_MS) {
    const found = find()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  return null
}

const alertText = () =>
  document.querySelector("[role='alert']")?.textContent?.trim() || ""

async function run() {
  const pinUrl = pinUrlFromHash(location.hash)
  if (!pinUrl) return
  // A reload shouldn't download the pin again.
  history.replaceState(null, "", location.pathname + location.search)
  say("filling in the pin…")

  const input = await waitFor(() =>
    document.querySelector<HTMLInputElement>("form input[type='url']")
  )
  if (!input?.form) {
    say("couldn't find PinSavePro's link box. Paste the pin link yourself.", "error")
    return
  }
  // Set from this isolated world, the value skips React's tracker, so the
  // input event below reaches its onChange.
  input.focus()
  input.value = pinUrl
  input.dispatchEvent(new Event("input", { bubbles: true }))

  const submit = await waitFor(() => {
    const button = input.form!.querySelector<HTMLButtonElement>("button[type='submit']")
    return button && !button.disabled ? button : null
  })
  if (!submit) {
    say("PinSavePro's Download button stayed disabled. Click it yourself.", "error")
    return
  }
  submit.click()
  say("PinSavePro is finding the video…")

  // The result's links proxy files from Pinterest's CDN, videos first and
  // best quality first; an image-only pin has just the image link.
  const outcome = await waitFor(
    () => document.querySelector("a[href*='/api/public/download']") || alertText()
  )
  if (typeof outcome === "string") {
    say(`PinSavePro says: ${outcome}`, "error")
  } else if (!outcome) {
    say("PinSavePro didn't answer in time. Try its Download button again.", "error")
  } else {
    const video = document.querySelector<HTMLAnchorElement>(
      "a[href*='/api/public/download'][href*='ext=mp4']"
    )
    if (video) {
      video.click()
      say("download started. It saves to your Downloads folder.", "done")
    } else {
      say("PinSavePro found no video in this pin.", "error")
    }
  }
}

run()
