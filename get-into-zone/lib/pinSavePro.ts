// pinsavepro.com is the fallback when a Pinterest video download fails. The
// pin travels in the URL hash (never sent to their server); only tabs opened
// this way are filled in by contents/pinsavepro.ts.

const HASH_KEY = "browse-hack-pin"
const PIN_URL_RE = /^https:\/\/(?:[\w-]+\.)?pinterest\.[a-z.]+\/pin\/[\w-]+\/?$/i

export const pinSaveProUrl = (pinUrl: string) =>
  `https://pinsavepro.com/#${HASH_KEY}=${encodeURIComponent(pinUrl)}`

export function pinUrlFromHash(hash: string) {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get(HASH_KEY) || ""
  return PIN_URL_RE.test(value) ? value : ""
}
