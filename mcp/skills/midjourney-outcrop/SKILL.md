---
name: midjourney-outcrop
description: Outcrop (outpaint, uncrop, extend, zoom out) an image with Midjourney through the Get into zone browser extension. Use when the user wants an image widened, made taller, converted to another aspect ratio (16:9, 9:16, 1:1, …) without cropping, given more background or headroom, or zoomed out with new content around it.
---

# Midjourney outcrop

Extends an image beyond its edges with Midjourney's Editor. The image sits inside a bigger frame and Midjourney paints the empty area. It runs in the user's own Chrome through the `get-into-zone` MCP server, on their Midjourney account.

To change a region inside the picture (erase an object, repaint a face, replace a detail), use `midjourney-repaint`. The user brushes that region in Chrome.

## Before you start

- The `get-into-zone` MCP tools must be available. If a tool says the extension isn't connected, call `get_status` and tell the user to open Chrome with the Get into zone extension (Settings → "Let Claude use this extension" on).
- If a tool says the extension is connected in several Chrome profiles, ask the user which profile to use by each profile's Google account email (and its name, if it has one), never by its number, which the user doesn't know (from `list_profiles`; it should be the one signed in to Midjourney), call `use_profile` with their answer, then carry on. Don't pick one yourself.
- The user must be signed in to midjourney.com in that Chrome. Every outcrop uses their Midjourney GPU time.

## Steps

1. **Get the image.** Accept any of these:
   - an `https://` URL
   - an **absolute** local path (PNG, JPEG, WebP or GIF, under 20 MB)
   - `mj:<jobId>#<index>` for one of the user's earlier Midjourney results (index 0–3)

   If the user only pasted an image into the chat, ask for its file path or URL. The tool can't read chat attachments.
2. **Choose the frame.**
   - `aspectRatio` is the new frame, for example `"16:9"` to widen a square or `"9:16"` for a phone wallpaper. Ratios up to 4:1 work.
   - Outcropping to the image's own ratio adds nothing. To grow it on every side, keep the ratio and use `scale` below 1.
   - `anchor` sets where the original stays. Default `center` adds new content on both sides. Use `left` to extend only to the right, `bottom` to add sky above, and so on.
   - `scale` below 1 shrinks the original inside the frame. 0.6 to 0.8 is a typical zoom out, which adds content on all four sides.
3. **Write the prompt.** Describe the **whole final image**, not just the new parts: the subject, the setting the new area should continue into, and the style. Example: "anime digital art, a girl on a rooftop at sunset, city skyline stretching to the horizon". The prompt is required. Put parameters in `extraFlags`, for example `"--raw"` or `"--stylize 150"`. `--ar`, `--edit` and the model version are set for you (`--v 8.2` unless you pass `--v`).
4. **Call `midjourney_outcrop`.** It waits up to 4 minutes by default and returns `jobId`, `width`, `height`, `placement` (where the original landed) and four `imageUrls`.
   - `mode` defaults to `relaxed`. Use `fast` if the user is in a hurry or has no relax hours left.
   - If it returns `status` `running` or `starting`, call `midjourney_job_status` with `wait: true` until `completed`.
5. **Show the results.** Give the user the four image URLs. To save them, call `midjourney_download_images` with the `jobId` (optionally `indexes` and `folder`). Files land in the browser's Downloads folder as `<folder>/<jobId>_<index>.png`.
6. **Iterate.** To extend a result again, pass it back as `mj:<jobId>#<index>`.

## Examples

| User asks | Call |
| --- | --- |
| "Make this square photo 16:9" | `aspectRatio: "16:9"` |
| "Turn it into a phone wallpaper" | `aspectRatio: "9:16"` |
| "Add more sky above" | `aspectRatio: "2:3"`, `anchor: "bottom"` |
| "Extend only to the right" | wider `aspectRatio`, `anchor: "left"` |
| "Zoom out, show more of the scene" | same ratio as the image, `scale: 0.65` |

## Errors

| Message | What to do |
| --- | --- |
| "Nothing to extend" | Pick a different aspect ratio, or a `scale` below 1 |
| "Sign in to midjourney.com" | Ask the user to sign in to Midjourney in that Chrome |
| "moderation rejected" or a `failure` list | Tell the user what Midjourney said. Don't retry the same image or prompt unchanged |
| "needs a Midjourney subscription" | Uploads require a paid Midjourney plan |
| A relaxed job fails with no relax time left | Retry with `mode: "fast"` only after asking the user |
