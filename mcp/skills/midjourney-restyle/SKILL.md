---
name: midjourney-restyle
description: Redraw the user's own image in a different style with Midjourney (the Create page's edit image, --edit), keeping its subject and layout, through the Get into zone browser extension. Use when the user wants "this photo as anime / watercolor / pixel art / 3D render", "restyle", "turn my image into…", "convert this picture to a … style", or to edit an uploaded image with a prompt.
---

# Midjourney: restyle an image

Redraws an image the user provides to match a prompt. The image goes into Midjourney's Create page prompt bar as an **edit image** (not the Editor tab), so the result keeps its subject and composition while the prompt sets the new style or changes. It runs in the user's own Chrome through the `get-into-zone` MCP server, on their Midjourney account.

To make new images that only borrow an image's look, use `midjourney-style-reference`. To extend an image past its edges, use `midjourney-outcrop`.

## Before you start

- The `get-into-zone` MCP tools must be available. If a tool says the extension isn't connected, call `get_status` and tell the user to open Chrome with the Get into zone extension (Settings → "Let Claude use this extension" on).
- The user must be signed in to midjourney.com in that Chrome. Every job uses their Midjourney GPU time.

## Steps

1. **Get the image to restyle.** Accept any of these:
   - an `https://` URL
   - an **absolute** local path (PNG, JPEG, WebP or GIF, under 20 MB)
   - `mj:<jobId>#<index>` for one of the user's earlier Midjourney results

   If the user only pasted an image into the chat, ask for its file path or URL.
2. **Write the prompt** describing the **result**: what's in the image plus the new style. Example: "a woman with a red umbrella crossing a rainy street, Studio Ghibli anime style, soft watercolor backgrounds". Naming the subject helps Midjourney keep it. Parameters go in `extraFlags`, for example `"--ar 3:4 --stylize 200"`. The edit model version is added for you (`--v 8.2` unless you pass `--v`).
3. **Optionally add a style reference.** If the user has an image of the target style ("make my photo look like this painting"), pass it in `styleReferences` together with `editImage`.
4. **Call `midjourney_generate`** with `prompt`, `editImage` and, if used, `styleReferences`. It waits up to 4 minutes by default and returns `jobId`, the final `prompt` sent and four `imageUrls`.
   - `mode` defaults to `relaxed`. Use `fast` if the user is in a hurry.
   - If `status` comes back `running` or `starting`, call `midjourney_job_status` with `wait: true`.
5. **Show the results.** Give the user the four image URLs. To save them, call `midjourney_download_images` with the `jobId`.
6. **Iterate.** For a stronger or weaker change, reword the prompt. Be more specific about what must stay the same, or about how far the style should go. To restyle a result again, pass `mj:<jobId>#<index>` as `editImage`.

## Example

User: "Turn /Users/me/Desktop/dog.jpg into pixel art."

```json
{
  "prompt": "a golden retriever sitting on grass, 16-bit pixel art, limited palette",
  "editImage": "/Users/me/Desktop/dog.jpg"
}
```

## Errors

| Message | What to do |
| --- | --- |
| "Sign in to midjourney.com" | Ask the user to sign in to Midjourney in that Chrome |
| "moderation rejected" or a `failure` list | Tell the user what Midjourney said. Don't retry unchanged |
| "needs a Midjourney subscription" | Uploads require a paid Midjourney plan |
