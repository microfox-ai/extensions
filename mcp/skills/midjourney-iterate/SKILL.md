---
name: midjourney-iterate
description: Make more images from one of the user's Midjourney results with the buttons under it (Vary Subtle/Strong, Upscale Subtle/Creative, Pan left/right/up/down, Zoom Out 1.5x/2x) through the Browse Hack browser extension. Use when the user picks an image from a Midjourney grid and wants variations or versions of it, a bigger or upscaled copy, the scene continued to one side, or a zoomed-out version.
---

# Midjourney vary, upscale, pan and zoom

Runs the buttons under a finished Midjourney image on the user's own account, in their Chrome, through the `browse-hack` MCP server. Each call starts a new Midjourney job from one image of an existing job.

These only work on the user's own Midjourney results. For a photo or any other image, use `midjourney-outcrop` (extend or zoom out), `midjourney-restyle` or `midjourney-style-reference`.

## Before you start

- The `browse-hack` MCP tools must be available. If a tool says the extension isn't connected, call `get_status` and tell the user to open Chrome with the Browse Hack extension (Settings → "Let Claude use this extension" on).
- If the extension is connected in several Chrome profiles, ask the user which one to use by each profile's Google account email (and its name, if it has one), never by its number, which the user doesn't know (from `list_profiles`; it should be the one signed in to Midjourney), call `use_profile` with their answer, then carry on. Don't pick one yourself.
- The user must be signed in to midjourney.com in that Chrome. Every call uses their Midjourney GPU time.

## Steps

1. **Find the image.** Every tool takes `jobId` and `index` (0–3, the position in the grid). `jobId` accepts any of these:
   - a job id from an earlier tool result (`midjourney_generate`, `midjourney_outcrop`, `midjourney_vary`, …)
   - `mj:<jobId>#<index>`
   - a result URL such as `https://cdn.midjourney.com/<jobId>/0_<index>.png`

   If the user says "the second one", that's `index: 1`. If you don't know the job, `midjourney_scrape` lists the images in the open Midjourney tab with their URLs.
2. **Pick the button.**

   | User wants | Tool | Options |
   | --- | --- | --- |
   | More like this, small changes | `midjourney_vary` | `strength: "subtle"` (default) |
   | More like this, bigger changes | `midjourney_vary` | `strength: "strong"` |
   | Bigger image, same look | `midjourney_upscale` | `kind: "subtle"` (default) |
   | Bigger image with more detail | `midjourney_upscale` | `kind: "creative"` |
   | Continue the scene to one side | `midjourney_pan` | `direction: "left" \| "right" \| "up" \| "down"` |
   | See more around the subject | `midjourney_zoom_out` | `zoom: 1.5` (default) or `2` |

   - Vary, pan and zoom return four images. Upscale returns one image (`imageUrls` has a single URL).
   - Pan and zoom reuse the parent's prompt. Pass `prompt` only to change what the new area shows, like Remix; write the whole prompt and include the parameters to keep. The version, aspect ratio and seed are handled for you.
   - Pan adds half the image's width (left/right) or height (up/down), so the result is wider or taller. Zoom keeps the shape.
3. **Call the tool.** It waits up to 4 minutes by default and returns `jobId`, `width`, `height` and `imageUrls`.
   - `mode` defaults to `relaxed`. Use `fast` if the user is in a hurry or has no relax hours left.
   - If it returns `status` `running` or `starting`, call `midjourney_job_status` with `wait: true` until `completed`.
4. **Show the results.** Give the user the image URLs. To save them, call `midjourney_download_images` with the new `jobId`; it saves all of that job's images (one for an upscale) unless you pass `indexes`.
5. **Keep going.** Each result is a job of its own: vary a variation, pan again in another direction, or upscale the one the user likes best, by passing the new `jobId` and `index`.

## Which images work

| Version | Vary | Upscale | Pan / Zoom |
| --- | --- | --- | --- |
| `--v 8.1`, `--v 8.2` | yes | yes | yes (sent as an Editor job, like the site) |
| `--v 5` to `--v 7`, `--niji 5` to `--niji 7` | yes | yes (`--v 5`: subtle is 2x, creative 4x) | yes |
| `--v 8` | yes | no | no; use `midjourney_outcrop` |
| `--hd`, `--draft`, or already upscaled | yes | no | depends on version |

## Errors

| Message | What to do |
| --- | --- |
| "isn't a Midjourney job id" | Ask for the image's Midjourney link, or use `midjourney_scrape` |
| "is running" / "not finished" | Wait with `midjourney_job_status`, then try again |
| "there is no index" | That job has fewer images (an upscale has only index 0) |
| "Midjourney can't pan / zoom out …" or "no web upscaler" | Not supported for that version; offer `midjourney_outcrop` for pan or zoom |
| "Sign in to midjourney.com" | Ask the user to sign in to Midjourney in that Chrome |
| "rejected the job" or a `failure` list | Tell the user what Midjourney said. Jobs that aren't the user's own are refused |
| A relaxed job fails with no relax time left | Retry with `mode: "fast"` only after asking the user |
