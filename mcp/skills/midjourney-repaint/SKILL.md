---
name: midjourney-repaint
description: Erase and repaint part of an image with Midjourney's Editor through the Browse Hack browser extension. Use when the user wants to remove an object, change one region (a face, shirt, background detail, text), inpaint, or brush over part of a picture. The user paints that region in Chrome; the same Editor job as outcrop fills it in.
---

# Midjourney repaint

Changes part of an image with Midjourney's Editor. Transparent pixels are what Midjourney paints; the rest stays. Outcrop leaves an empty margin. Repaint leaves holes where the user brushed. It runs in the user's own Chrome through the `browse-hack` MCP server, on their Midjourney account.

The brush cannot be drawn for them. A Chrome tab opens, they mark the region, and they click Repaint.

To extend the picture past its edges, use `midjourney-outcrop`. To redraw the whole image in a new style, use `midjourney-restyle`.

## Before you start

- The `browse-hack` MCP tools must be available. If a tool says the extension isn't connected, call `get_status` and tell the user to open Chrome with the Browse Hack extension (Settings → "Let Claude use this extension" on).
- If a tool says the extension is connected in several Chrome profiles, ask the user which profile to use by each profile's Google account email (and its name, if it has one), never by its number, which the user doesn't know (from `list_profiles`; it should be the one signed in to Midjourney), call `use_profile` with their answer, then carry on. Don't pick one yourself.
- The user must be signed in to midjourney.com in that Chrome. Every repaint uses their Midjourney GPU time.

## Steps

1. **Get the image.** Accept any of these:
   - an `https://` URL
   - an **absolute** local path (PNG, JPEG, WebP or GIF, under 20 MB)
   - `mj:<jobId>#<index>` for one of the user's earlier Midjourney results (index 0–3)

   If the user only pasted an image into the chat, ask for its file path or URL. The tool can't read chat attachments.
2. **Write the prompt.** Describe the **whole finished image**, including what should appear where they brush. Example: "the same portrait, the red hat replaced by dark curly hair, soft window light". Put parameters in `extraFlags`, for example `"--raw"` or `"--stylize 150"`. `--ar`, `--edit` and the model version are set for you (`--v 8.2` unless you pass `--v`).
3. **Call `midjourney_repaint`.** It opens the brush tab and returns immediately with `sessionId`. It does not wait for the user.
4. **Tell the user, before waiting.** A Chrome tab is open on the image. They should brush the parts that should change (red is repainted, Restore paints the original back), check the prompt, and click **Repaint**. Do not try to mark the region yourself.
5. **Call `midjourney_repaint_status`** with that `sessionId` and `wait: true`. It waits up to 10 minutes for them to click Repaint, then up to 4 minutes for the images. It returns `jobId` and four `imageUrls`.
   - `mode` on the first call defaults to `relaxed`. Use `fast` if the user is in a hurry or has no relax hours left.
   - If the status is `awaiting_paint`, the tab is still open. Ask them to finish, then call `midjourney_repaint_status` again.
   - If it returns `running` or `starting`, call `midjourney_job_status` with `wait: true` until `completed`.
   - If it returns `cancelled`, they closed the tab or clicked Cancel. Offer to open it again.
6. **Show the results.** Give the user the four image URLs. To save them, call `midjourney_download_images` with the `jobId` (optionally `indexes` and `folder`). Files land in the browser's Downloads folder as `<folder>/<jobId>_<index>.png`.
7. **Iterate.** To change a result again, pass it back as `mj:<jobId>#<index>`.

## Examples

| User asks | Prompt to send |
| --- | --- |
| "Remove the person on the left" | the same scene with that spot filled by whatever is behind them |
| "Change the jacket to a black coat" | the same person, now wearing a black coat |
| "Erase the sign and paint a window" | the same storefront, the sign replaced by a window |

## Errors

| Message | What to do |
| --- | --- |
| "Brush the parts to change" | The user clicked Repaint without brushing. Ask them to mark the region and click Repaint again |
| "The edit tab was closed" or `cancelled` | Ask if they want the tab opened again |
| "Sign in to midjourney.com" | Ask the user to sign in to Midjourney in that Chrome |
| "moderation rejected" or a `failure` list | Tell the user what Midjourney said. Don't retry the same image or prompt unchanged |
| "needs a Midjourney subscription" | Uploads require a paid Midjourney plan |
| "Aspect ratios wider than 4:1" | Midjourney can't edit an image that wide or tall. Ask for a crop first |
| A relaxed job fails with no relax time left | Retry with `mode: "fast"` only after asking the user |
