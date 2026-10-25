// Shared by the Instagram content script, the popup tab and the background worker.
import { isInstagramHost } from "./saverRules"
import { sanitizeFileName } from "./youtube"

export { isInstagramHost }

export type IgItemKind = "image" | "video"

export interface IgItem {
  kind: IgItemKind
  // Best file to download: the widest MP4, or the widest image.
  url: string
  width: number
  height: number
  // Small image for previews (a video's cover frame).
  thumb: string
  // File names of every image size, to match the image shown on the page.
  keys: string[]
}

export interface IgPost {
  mediaId: string
  code: string
  username: string
  caption: string
  items: IgItem[]
}

export type IgTarget =
  | { kind: "post"; code: string }
  | { kind: "story"; mediaId: string; username: string }

// /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>, optionally after /<username>/,
// and /stories/<username>/<media id>. Highlights carry no item id, so they're skipped.
export function parseInstagramUrl(rawUrl?: string): IgTarget | null {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (!isInstagramHost(url.hostname)) return null
  const story = url.pathname.match(/^\/stories\/([\w.]+)\/(\d{5,25})(?:\/|$)/)
  if (story && story[1] !== "highlights") {
    return { kind: "story", username: story[1], mediaId: story[2] }
  }
  const post = url.pathname.match(
    /^(?:\/[\w.]+)?\/(?:p|reels?|tv)\/([\w-]{5,})(?:\/|$)/
  )
  return post ? { kind: "post", code: post[1] } : null
}

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

// Shortcodes are the media id in base 64. Private posts append 28 extra characters.
export function shortcodeToMediaId(code: string) {
  const core = code.length > 28 ? code.slice(0, -28) : code
  let id = BigInt(0)
  for (const char of core) {
    const digit = ALPHABET.indexOf(char)
    if (digit < 0) return ""
    id = id * BigInt(64) + BigInt(digit)
  }
  return id.toString()
}

export const mediaIdFor = (target: IgTarget) =>
  target.kind === "story" ? target.mediaId : shortcodeToMediaId(target.code)

// The CDN serves every size of an image under the same file name.
export function mediaFileKey(url?: string | null) {
  if (!url) return ""
  try {
    return (
      new URL(url, "https://www.instagram.com").pathname.split("/").pop() || ""
    )
  } catch {
    return ""
  }
}

export type IgLookup =
  | { post: IgPost; error?: undefined }
  | { post?: undefined; error: string }

// Runs inside an instagram.com page (content script or executeScript), where the
// session cookie is sent. Self-contained: executeScript serializes only this body.
// Errors come back as values because executeScript drops a rejection's message.
export async function lookupInstagramMedia(mediaId: string): Promise<IgLookup> {
  try {
    return { post: await load() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  async function load(): Promise<IgPost> {
    const token = decodeURIComponent(
      document.cookie
        .split("; ")
        .find((row) => row.startsWith("csrftoken="))
        ?.slice("csrftoken=".length) || ""
    )
    const resp = await fetch(
      `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
      {
        credentials: "include",
        headers: {
          Accept: "application/json",
          "X-IG-App-ID": "936619743392459",
          "X-Requested-With": "XMLHttpRequest",
          ...(token ? { "X-CSRFToken": token } : {})
        }
      }
    )
    if (resp.status === 401 || resp.status === 403 || resp.redirected) {
      throw new Error("Log in to Instagram in this browser to download posts.")
    }
    if (resp.status === 404)
      throw new Error("That post doesn't exist or isn't visible to you.")
    if (resp.status === 429)
      throw new Error(
        "Instagram is rate-limiting requests; try again in a minute."
      )
    if (!resp.ok) throw new Error(`Instagram returned ${resp.status}`)
    const json = await resp.json().catch(() => null)
    const media = json?.items?.[0]
    if (!media) throw new Error("Instagram didn't return that post.")

    type Version = { url?: string; width?: number; height?: number }
    const widest = (list: Version[] = []) =>
      list
        .filter((v) => typeof v?.url === "string")
        .sort((a, b) => (b.width || 0) - (a.width || 0))[0]
    const fileKey = (url: string) => {
      try {
        return new URL(url).pathname.split("/").pop() || ""
      } catch {
        return ""
      }
    }
    const toItem = (node: any): IgItem | null => {
      const images: Version[] = node?.image_versions2?.candidates || []
      const image = widest(images)
      const video = widest(node?.video_versions)
      const best = video || image
      if (!best?.url) return null
      // The smallest image at least 150px wide is plenty for a thumbnail.
      const thumb =
        [...images]
          .filter((v) => typeof v?.url === "string")
          .sort((a, b) => (a.width || 0) - (b.width || 0))
          .find((v) => (v.width || 0) >= 150)?.url ||
        image?.url ||
        ""
      return {
        kind: video ? "video" : "image",
        url: best.url,
        width: best.width || 0,
        height: best.height || 0,
        thumb,
        keys: images.map((v) => fileKey(v.url!)).filter(Boolean)
      }
    }
    const nodes: unknown[] =
      Array.isArray(media.carousel_media) && media.carousel_media.length
        ? media.carousel_media
        : [media]
    const items = nodes.map(toItem).filter((item): item is IgItem => !!item)
    if (!items.length) throw new Error("That post has no downloadable media.")
    return {
      mediaId: String(media.pk || mediaId),
      code: String(media.code || ""),
      username: String(media.user?.username || ""),
      caption: String(media.caption?.text || ""),
      items
    }
  }
}

export const extensionFor = (item: IgItem) => {
  const ext = mediaFileKey(item.url)
    .match(/\.(mp4|jpe?g|png|webp|heic)$/i)?.[1]
    ?.toLowerCase()
  return ext === "jpeg" ? "jpg" : ext || (item.kind === "video" ? "mp4" : "jpg")
}

// "natgeo - C9xYz12AbCd - 2.jpg"; the number only appears for carousel posts.
export function instagramFileName(post: IgPost, item: IgItem) {
  const index = post.items.indexOf(item)
  const parts = [post.username || "instagram", post.code || post.mediaId]
  if (post.items.length > 1) parts.push(String(index + 1))
  return `${sanitizeFileName(parts.join(" - "))}.${extensionFor(item)}`
}

export interface IgDownload {
  url: string
  filename: string
}

export const downloadsFor = (
  post: IgPost,
  items: IgItem[] = post.items
): IgDownload[] =>
  items.map((item) => ({
    url: item.url,
    filename: instagramFileName(post, item)
  }))
