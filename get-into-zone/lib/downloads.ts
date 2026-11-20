// Chrome ignores the filename chrome.downloads.download is given once the
// extension listens to onDeterminingFilename (sunoBridge does, to file Suno's
// own downloads) and saves the file loose in Downloads under its default name.
// So every download that names its file starts here, and that listener hands
// the name back (askedName).
//
// The name is tied to the download's id as soon as Chrome gives one, not only
// to its URL: Chrome asks again for the same download when it resumes one that
// was interrupted before its name was settled (a network timeout), and the
// second answer has to be the first one. Answered from the URL alone, the
// second ask found nothing and the file landed in Downloads under the
// server's name (7 of 107 DistroKid covers on 2026-11-20).

import { withMimeExtension } from "./googleImages"

type Asked = chrome.downloads.DownloadFilenameSuggestion & {
  // Give the file the extension its type calls for (known once the server answers).
  extensionFromMime?: boolean
}

// URL -> the names its downloads asked for and not yet tied to a download, oldest first.
const asked = new Map<string, Asked[]>()

// Download id -> the name it asked for. Kept for the latest downloads only.
const byId = new Map<number, Asked>()
const KEEP_IDS = 500

// Chrome reports a download's URL parsed, so both sides compare parsed URLs.
const urlKey = (url: string) => {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

function forget(key: string, entry: Asked) {
  const rest = (asked.get(key) ?? []).filter((other) => other !== entry)
  if (rest.length) asked.set(key, rest)
  else asked.delete(key)
}

function tie(id: number, entry: Asked) {
  byId.delete(id)
  byId.set(id, entry)
  for (const oldest of byId.keys()) {
    if (byId.size <= KEEP_IDS) break
    byId.delete(oldest)
  }
}

export async function downloadFile(
  options: chrome.downloads.DownloadOptions,
  { extensionFromMime = false }: { extensionFromMime?: boolean } = {}
) {
  if (!options.filename) return chrome.downloads.download(options)
  const key = urlKey(options.url)
  const entry: Asked = {
    filename: options.filename,
    conflictAction: options.conflictAction,
    ...(extensionFromMime ? { extensionFromMime } : {})
  }
  asked.set(key, [...(asked.get(key) ?? []), entry])
  let id: number
  try {
    id = await chrome.downloads.download(options)
  } catch (error) {
    forget(key, entry)
    throw error
  }
  // Still waiting for Chrome's first ask: from now on it is found by id. (When
  // Chrome already asked for this id, it took another name for this URL, and
  // this one stays for the download that has it.)
  if (asked.get(key)?.includes(entry) && !byId.has(id)) {
    forget(key, entry)
    tie(id, entry)
  }
  return id
}

// The name one of our downloads asked for, if this is one.
export function askedName(
  item: chrome.downloads.DownloadItem
): chrome.downloads.DownloadFilenameSuggestion | undefined {
  if (item.byExtensionId !== chrome.runtime.id) return undefined
  let entry = byId.get(item.id)
  if (!entry) {
    // Chrome asked before download() gave us the id.
    const key = urlKey(item.url)
    entry = asked.get(key)?.[0]
    if (!entry) return undefined
    forget(key, entry)
    tie(item.id, entry)
  }
  const { extensionFromMime, ...suggestion } = entry
  return extensionFromMime
    ? { ...suggestion, filename: withMimeExtension(suggestion.filename, item.mime) }
    : suggestion
}

// Other features file downloads the page starts (Tripo's Export) as Chrome
// saves them. Chrome gives an extension one say in a download's name, so the
// one onDeterminingFilename listener (sunoBridge's) asks these first; a router
// that takes the download calls suggest and returns true.
type DownloadRouter = (
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void
) => boolean

const routers: DownloadRouter[] = []

export function addDownloadRouter(router: DownloadRouter) {
  if (!routers.includes(router)) routers.push(router)
}

export function routeDownload(
  item: chrome.downloads.DownloadItem,
  suggest: (suggestion?: chrome.downloads.DownloadFilenameSuggestion) => void
) {
  return routers.some((router) => {
    try {
      return router(item, suggest)
    } catch {
      return false
    }
  })
}
