// Chrome ignores the filename chrome.downloads.download is given once the
// extension listens to onDeterminingFilename (sunoBridge does, to file Suno's
// own downloads) and saves the file loose in Downloads under its default name.
// So every download that names its file starts here, and that listener hands
// the name back (askedName).

type Asked = chrome.downloads.DownloadFilenameSuggestion

// URL -> the names its downloads asked for, oldest first.
const asked = new Map<string, Asked[]>()

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

export async function downloadFile(options: chrome.downloads.DownloadOptions) {
  if (!options.filename) return chrome.downloads.download(options)
  const key = urlKey(options.url)
  const entry: Asked = { filename: options.filename, conflictAction: options.conflictAction }
  asked.set(key, [...(asked.get(key) ?? []), entry])
  try {
    return await chrome.downloads.download(options)
  } catch (error) {
    forget(key, entry)
    throw error
  }
}

// The name one of our downloads asked for, if this is one.
export function askedName(item: chrome.downloads.DownloadItem): Asked | undefined {
  if (item.byExtensionId !== chrome.runtime.id) return undefined
  const key = urlKey(item.url)
  const entry = asked.get(key)?.[0]
  if (entry) forget(key, entry)
  return entry
}
