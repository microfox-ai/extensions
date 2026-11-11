// Tests for reading Google Images results: npm test.
// The data below is how google.com/search?...&udm=2 carried it on 11 Nov 2026: inline in the page's
// scripts for the first 100 results, and inside a JSON string (quotes escaped once more) in the
// answer to "More results" for the rest.

import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  decodeResult,
  imageFileName,
  imageKey,
  isGoogleImagesUrl,
  isImageDownload,
  parseResults,
  RESULT_PATTERN,
  retireGiSession,
  withMimeExtension
} from "./googleImages.ts"

const INLINE =
  '"vS70au2tIYfC4-EPu6PasQ828":[1,[0,"iw1054JDZ24bxM",["https://encrypted-tbn0.gstatic.com/images?q\\u003dtbn:ANd9GcSIxsdpc1zaNUwzIghKjZYOChY3q09IzMxQEAtmLF7r0g\\u0026s\\u003d10",413,736],' +
  '["https://i.pinimg.com/736x/6c/48/d9/6c48d9f998eb37ac15ff55754cc75223.jpg",414,736],null,0,"rgb(71,132,103)",null,0,' +
  '{"2003":[null,"i-0UD8l41RqCgM","https://www.pinterest.com/pin/689754499202302991/","HD wallpaper"]}]],' +
  '"vS70au2tIYfC4-EPu6PasQ812":[0,"iw1054JDZ24bxM",["https://encrypted-tbn0.gstatic.com/images?q\\u003dtbn:ANd9GcSIxsdpc1zaNUwzIghKjZYOChY3q09IzMxQEAtmLF7r0g\\u0026s\\u003d10",413,736],' +
  '["https://i.pinimg.com/736x/6c/48/d9/6c48d9f998eb37ac15ff55754cc75223.jpg",414,736],null,0]'

const MORE =
  '[["JC_0arC_E5CQ4-EP-5PJoAo72","[0,\\"HRDvECPet6RneM\\",[\\"https://encrypted-tbn0.gstatic.com/images?q\\\\u003dtbn:ANd9GcSvbJSX4EYG3lWWIA4ZKGzTieiNwdN5AKgmL3engGnO4g\\\\u0026s\\\\u003d10\\",480,638],' +
  '[\\"https://www.micechat.com/wp-content/uploads/2022/01/ghibli-park-Dondoko-ForestStudio-Ghibli-1.jpg\\",1080,1440],null,0,\\"rgb(216,155,146)\\",null]"],' +
  '["JC_0arC_E5CQ4-EP-5PJoAo73","[0,\\"DaDTL0aIS5rSnM\\",[\\"https://encrypted-tbn0.gstatic.com/images?q\\\\u003dtbn:ANd9GcRMMGooddcGVEAfAWKX5iLrsNK59ABA03rMtQgqlEwdig\\\\u0026s\\\\u003d10\\",300,168],' +
  '[\\"https://preview.redd.it/perfumes-ghibli-forest-v0-exgx0vmqgvhh1.jpg?width\\\\u003d429\\\\u0026format\\\\u003dpjpg\\\\u0026auto\\\\u003dwebp\\",766,429],null]"]]'

describe("parseResults", () => {
  test("reads the first results from the page's inline data, once per result", () => {
    assert.deepEqual(parseResults(INLINE), [
      {
        id: "iw1054JDZ24bxM",
        url: "https://i.pinimg.com/736x/6c/48/d9/6c48d9f998eb37ac15ff55754cc75223.jpg",
        width: 736,
        height: 414,
        thumbnail: "https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcSIxsdpc1zaNUwzIghKjZYOChY3q09IzMxQEAtmLF7r0g&s=10"
      }
    ])
  })

  test("reads the More results answer, where the data sits inside a JSON string", () => {
    const results = parseResults(MORE)
    assert.deepEqual(
      results.map(({ id, url, width, height }) => ({ id, url, width, height })),
      [
        {
          id: "HRDvECPet6RneM",
          url: "https://www.micechat.com/wp-content/uploads/2022/01/ghibli-park-Dondoko-ForestStudio-Ghibli-1.jpg",
          width: 1440,
          height: 1080
        },
        {
          id: "DaDTL0aIS5rSnM",
          url: "https://preview.redd.it/perfumes-ghibli-forest-v0-exgx0vmqgvhh1.jpg?width=429&format=pjpg&auto=webp",
          width: 429,
          height: 766
        }
      ]
    )
  })

  test("decodeResult takes the groups the page script hands back", () => {
    const match = new RegExp(RESULT_PATTERN).exec(MORE)
    assert.equal(decodeResult(match.slice(1)).id, "HRDvECPet6RneM")
    assert.equal(decodeResult(["", "x", "t", "1", "1", "data:image/png;base64,AAA", "1", "1"]), null)
    assert.equal(decodeResult(null), null)
  })
})

describe("isGoogleImagesUrl", () => {
  test("Google's image searches, old and new", () => {
    assert.ok(isGoogleImagesUrl("https://www.google.com/search?q=cats&udm=2"))
    assert.ok(isGoogleImagesUrl("https://www.google.co.in/search?q=cats&tbm=isch&hl=en"))
    assert.ok(isGoogleImagesUrl("https://www.google.com/search?q=cats&udm=2#vhid=abc&vssid=mosaic"))
  })

  test("not web searches, other Google sites or other hosts", () => {
    assert.ok(!isGoogleImagesUrl("https://www.google.com/search?q=cats"))
    assert.ok(!isGoogleImagesUrl("https://www.google.com/search?q=cats&udm=50"))
    assert.ok(!isGoogleImagesUrl("https://images.google.com.evil.com/search?q=cats&udm=2"))
    assert.ok(!isGoogleImagesUrl("https://docs.google.com/search?udm=2"))
    assert.ok(!isGoogleImagesUrl(undefined))
  })
})

describe("files", () => {
  test("a file name from the image's address, else its title, else its id", () => {
    assert.equal(
      imageFileName("https://www.micechat.com/uploads/ghibli-park-Dondoko-ForestStudio-Ghibli-1.jpg", "t", "id1"),
      "ghibli-park-Dondoko-ForestStudio-Ghibli-1.jpg"
    )
    assert.equal(
      imageFileName("https://lookaside.instagram.com/seo/google_widget/crawler/?media_id=1", "Totoro's forest walk", "id2"),
      "Totoro-s-forest-walk.jpg"
    )
    assert.equal(imageFileName("https://i.pinimg.com/736x/6c/48/d9/6c48d9f998eb37ac15ff55754cc75223.jpg", "", "iw1054"), "iw1054.jpg")
    assert.equal(imageFileName("https://example.com/a/Forest%20Spirit.JPEG?x=1", "", "id"), "Forest-Spirit.jpg")
    assert.equal(imageFileName("https://example.com/art/kodama.webp", "", "id"), "kodama.webp")
    assert.equal(
      imageFileName(
        "https://substackcdn.com/image/fetch/f_auto/https%3A%2F%2Fsubstack-post-media.s3.amazonaws.com%2Fpublic%2Fimages%2F87e58bc6_1400x700.jpeg",
        "",
        "id"
      ),
      "87e58bc6-1400x700.jpg"
    )
    assert.equal(imageFileName("https://i.ytimg.com/vi/abc/maxresdefault.jpg", "Ghibli forest ambience", "id"), "Ghibli-forest-ambience.jpg")
  })

  test("the download's type sets the extension", () => {
    assert.equal(withMimeExtension("_INBOX/google-images/x/Totoro.jpg", "image/png"), "_INBOX/google-images/x/Totoro.png")
    assert.equal(withMimeExtension("a/b.jpg", "image/jpeg"), "a/b.jpg")
    assert.equal(withMimeExtension("a/b.jpg", "text/html"), "a/b.jpg")
    assert.equal(withMimeExtension("a/v1.2-final.jpg", "image/webp"), "a/v1.2-final.webp")
  })

  test("only images count as saved", () => {
    assert.ok(isImageDownload("image/jpeg", "https://x.com/a"))
    assert.ok(isImageDownload("application/octet-stream", "https://x.com/a.png"))
    assert.ok(!isImageDownload("application/octet-stream", "https://x.com/a"))
    assert.ok(!isImageDownload("text/html", "https://x.com/a.jpg"))
  })

  test("the same image with another #hash is a duplicate", () => {
    assert.equal(imageKey("https://x.com/a.jpg#one"), imageKey("https://x.com/a.jpg"))
  })
})

test("an ended session keeps its counts, not its lists", () => {
  const session = retireGiSession({
    tabId: 1,
    active: true,
    seen: ["id:a", "https://x.com/a.jpg"],
    pending: [{ id: "b" }],
    skipping: 3000,
    saved: 12,
    failed: 2
  })
  assert.equal(session.active, false)
  assert.deepEqual(session.seen, [])
  assert.deepEqual(session.pending, [])
  assert.equal(session.skipping, undefined)
  assert.equal(session.saved, 12)
  assert.ok(session.stoppedAt > 0)
})
