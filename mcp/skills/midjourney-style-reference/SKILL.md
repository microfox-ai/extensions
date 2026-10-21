---
name: midjourney-style-reference
description: Generate new Midjourney images that borrow the look of an image the user provides (style reference, --sref), optionally also using images as content prompts or a subject reference, through the Get into zone browser extension. Use when the user says things like "make something in the style of this image", "use this as style inspiration/inspo", "match this aesthetic/palette/mood", or gives an sref code.
---

# Midjourney: generate with a style reference

Creates new images on Midjourney's Create page using the user's image as **style inspiration**. Midjourney takes its colors, medium, texture and mood, not its content. It runs in the user's own Chrome through the `get-into-zone` MCP server, on their Midjourney account.

To change the user's image itself (same picture, new style), use the `midjourney-restyle` skill instead.

## Before you start

- The `get-into-zone` MCP tools must be available. If a tool says the extension isn't connected, call `get_status` and tell the user to open Chrome with the Get into zone extension (Settings → "Let Claude use this extension" on).
- The user must be signed in to midjourney.com in that Chrome. Every job uses their Midjourney GPU time.

## Steps

1. **Collect the images.** Each one can be:
   - an `https://` URL
   - an **absolute** local path (PNG, JPEG, WebP or GIF, under 20 MB)
   - `mj:<jobId>#<index>` for one of the user's earlier Midjourney results

   If the user only pasted an image into the chat, ask for its file path or URL.
2. **Sort them by role** (every list is optional):
   - `styleReferences`: up to 5 images whose **look** to copy. Numeric sref codes such as `"2147483647"` work here too.
   - `imagePrompts`: up to 5 images whose **content or composition** to draw on.
   - `omniReferences`: 1 image of a **subject or character** to put in the new image. This needs a model that supports `--oref` (V7), so add `--v 7` in `extraFlags` if the user's default model rejects it.
3. **Write the prompt** about the **content** of the new image, for example "a lighthouse on a cliff during a storm". Leave the style words out and let the reference carry them. Parameters go in `extraFlags` or at the end of the prompt:
   - `--sw 0..1000` sets style strength (default 100). Use higher values when the user wants it "more like the reference".
   - `--iw` sets image-prompt weight.
   - `--ar 16:9` for the shape. `--stylize`, `--raw` and `--v` are kept as written.
4. **Call `midjourney_generate`** with `prompt` and the lists. It waits up to 4 minutes by default and returns `jobId`, the final `prompt` sent and four `imageUrls`.
   - `mode` defaults to `relaxed`. Use `fast` if the user is in a hurry.
   - If `status` comes back `running` or `starting`, call `midjourney_job_status` with `wait: true`.
5. **Show the results.** Give the user the four image URLs. To save them, call `midjourney_download_images` with the `jobId`.
6. **Iterate.** Adjust `--sw`, the prompt or the references. To use a result as the next style reference, pass `mj:<jobId>#<index>`.

## Example

User: "Make me a poster of a fox in a forest in the style of ~/Pictures/ref.jpg, wide."

```json
{
  "prompt": "a fox standing in a misty pine forest",
  "styleReferences": ["/Users/<user>/Pictures/ref.jpg"],
  "extraFlags": "--ar 16:9"
}
```

## Errors

| Message | What to do |
| --- | --- |
| "Sign in to midjourney.com" | Ask the user to sign in to Midjourney in that Chrome |
| "moderation rejected" or a `failure` list | Tell the user what Midjourney said. Don't retry unchanged |
| "needs a Midjourney subscription" | Uploads require a paid Midjourney plan |
| A parameter error about `--oref` | Add `--v 7` to `extraFlags`, or drop the omni reference |
