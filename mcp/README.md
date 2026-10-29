# Browse Hack MCP server

Lets Claude (Claude Code, Claude Desktop, or any MCP client) use the [Browse Hack](../get-into-zone) extension running in your browser: bulk-download Pinterest, download YouTube videos and Instagram posts, save media to Mediamake, switch overlays on or off, upload Suno tracks and drive Midjourney.

```
Claude ──stdio──▶ MCP server (this folder) ◀──WebSocket 127.0.0.1:17892── extension service worker ──▶ your tabs
```

The extension connects out to the server, so the server never needs browser access of its own. Everything happens in your real browser profile, with your sign-ins.

## Setup

With Claude Code, open this repo and ask Claude to "set up browse-hack": the [`browse-hack-setup`](../.claude/skills/browse-hack-setup/SKILL.md) skill runs the steps below and tells you which ones to do in Chrome.

### Claude Desktop: one-click install

1. Get `browse-hack.mcpb`, or build it yourself (Node 18+):

   ```bash
   cd mcp && npm install && npm run pack:mcpb
   ```

2. Double-click `browse-hack.mcpb`, or drag it into Claude Desktop's **Settings → Extensions**, then click **Install**. The port and an optional extension id can be changed there later. Claude Desktop runs the server with its built-in Node, so nothing else needs installing.

3. Continue with step 3 below to load the browser extension.

### Manual setup (Claude Code, other clients)

1. Build the server (Node 18+):

   ```bash
   cd mcp && npm install && npm run build
   ```

2. Add it to Claude.

   **Claude Code**:

   ```bash
   claude mcp add browse-hack -s user -- node /absolute/path/to/extensions/mcp/dist/index.js
   ```

   **Claude Desktop**: add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

   ```json
   {
     "mcpServers": {
       "browse-hack": {
         "command": "node",
         "args": ["/absolute/path/to/extensions/mcp/dist/index.js"]
       }
     }
   }
   ```

3. Load a build of the extension that includes the bridge (version after 0.1.0, or `npm run build` in `get-into-zone/` and load `build/chrome-mv3-prod`). In the popup, **Settings → Let Claude use this extension (MCP)** is on by default and shows **Connected to Claude** once the server runs. The extension looks for the server every 30 seconds, so the first connection can take up to that long.

4. Ask Claude something like "check the browse-hack status", then "download this YouTube video at 1080p: https://youtu.be/…".

Claude Code and Claude Desktop can both use it at once: the first server to start listens on the port and later ones relay through it. If the first one exits, another takes over and the extension reconnects.

The extension can also be connected from several Chrome profiles (accounts) at once. Each Claude session works in one profile only:

- With one profile connected, every tool uses it.
- With two or more connected, tools refuse to run until the session picks one. Claude asks you which profile to use, naming each by its Google account email rather than a number (`list_profiles` shows each one's email, name, open tab count and active tab), then calls `use_profile` with your answer. From then on every tool in that session, `list_tabs` included, runs in that profile only. Another Claude session can pick a different one.
- If the chosen profile disconnects, tools wait up to 35 seconds for it to come back, then ask whether to switch.

To tell profiles apart, give each one a name in the popup's **Settings → Profile name** (otherwise Claude shows the profile's Google account). The extension asks for the `identity.email` permission to read that account.

## Tools

| Area | Tools |
| --- | --- |
| Status, profiles and sign-in | `get_status`, `list_profiles`, `use_profile`, `sign_in_to_mediamake` |
| Tabs | `list_tabs`, `open_tab` |
| Settings | `get_settings`, `update_settings`, `list_projects` |
| Mediamake | `save_media_to_mediamake` |
| Pinterest | `pinterest_bulk_start`, `pinterest_bulk_stop`, `pinterest_bulk_status`, `pinterest_analyze_image`, `pinterest_save_analysis`, `pinterest_list_analyses` |
| YouTube | `youtube_get_video`, `youtube_download`, `youtube_list_downloads`, `youtube_cancel_download`, `youtube_clear_finished` |
| Instagram | `instagram_get_post`, `instagram_download` |
| Overlays (Saver tab) | `saver_get`, `saver_set`, `saver_remove_rule`, `saver_reset` |
| Suno | `suno_upload_track` |
| DistroKid | `distrokid_fill_releases` |
| Midjourney (prompt automation) | `midjourney_submit_prompts`, `midjourney_scrape`, `midjourney_queue_size`, `midjourney_list_queue`, `midjourney_run_queue`, `midjourney_load_prompts` |
| Midjourney (images) | `midjourney_outcrop`, `midjourney_repaint`, `midjourney_repaint_status`, `midjourney_generate`, `midjourney_vary`, `midjourney_upscale`, `midjourney_pan`, `midjourney_zoom_out`, `midjourney_job_status`, `midjourney_download_images` |
| Midjourney (batches) | `midjourney_batch_start`, `midjourney_batch_status`, `midjourney_batch_pause` |

Tools behave like the matching buttons in the popup; see the [main README](../README.md#use-browse-hack) for what each feature does.

Every tool needs the extension signed in to Mediamake (see [First-time setup](../README.md#first-time-setup)). When it isn't, tools say so; `sign_in_to_mediamake` opens the sign-in window in Chrome for the user to click **Allow**. `get_status` and `list_profiles` show each profile's sign-in.

- **Pinterest bulk download** collects what the tab shows. After `pinterest_bulk_start`, the tab has to be scrolled or navigated to collect more pins. Do that yourself, or let Claude do it with Claude in Chrome (see below).
- **YouTube** downloads only need a video URL. The extension uses any open YouTube tab to read the formats, or opens one in the background.
- **Instagram** downloads only need a post, reel or story URL, and you must be logged in to Instagram in that Chrome profile. The extension asks Instagram from any open instagram.com tab, or opens one in the background. Story highlights aren't supported.
- **DistroKid** fills https://distrokid.com/new/ from a release folder (`info.json`, audio, square cover). `distrokid_fill_releases` opens one tab per folder and does not click Continue.

### Midjourney image tools

These call midjourney.com's own API from a midjourney.com tab (one opens in the background if none is open), signed in as you. Each job uses your GPU time; `mode` defaults to `relaxed`.

| Tool | What it does | Midjourney equivalent |
| --- | --- | --- |
| `midjourney_outcrop` | Puts an image in a bigger frame (`aspectRatio`, `anchor`, `scale`) and fills the rest | Editor → Move → aspect ratio → Submit edit |
| `midjourney_repaint` | Opens a brush tab. The user erases the parts to change, then clicks Repaint. Call `midjourney_repaint_status` after telling them | Editor → Erase → Submit edit |
| `midjourney_generate` | New images, optionally with `imagePrompts`, `styleReferences` (`--sref`), `omniReferences` (`--oref`) or an `editImage` to restyle (`--edit`) | Create page, images dropped in the prompt bar |
| `midjourney_vary` | Four variations of one result image (`strength` subtle or strong) | Vary (Subtle) / Vary (Strong) |
| `midjourney_upscale` | One result image at twice the size (`kind` subtle or creative) | Upscale (Subtle) / Upscale (Creative) |
| `midjourney_pan` | Extends one result image by half its width or height (`direction`) | Pan ← → ↑ ↓ |
| `midjourney_zoom_out` | Shrinks one result image in a same-shape frame and fills around it (`zoom` 1.1–2) | Zoom Out 1.5x / 2x |
| `midjourney_job_status` | Status of a job; `wait: true` waits for the images | |
| `midjourney_download_images` | Saves a job's images to Downloads | Download |

Images can be an `https://` URL, an absolute local file path (read by the MCP server), or `mj:<jobId>#<index>` for an earlier result. Jobs wait up to 4 minutes by default and return the four image URLs (`https://cdn.midjourney.com/<jobId>/0_<index>.png`). Longer relaxed jobs return their status; poll them with `midjourney_job_status`.

### Midjourney batches

For more than a few prompts, `midjourney_batch_start` takes the whole list (`jobs`, or a `jobsFile` for long lists) and a `folder`, and returns at once. In the background it keeps `concurrency` jobs (default 6) in Midjourney, relaxed by default, polls them together, and saves each job's images to the folder as `<name>-<index>.png`. Each job has its own prompt and, like `midjourney_generate`, optional `imagePrompts`, `styleReferences`, `omniReferences` and `extraFlags`; a reference image used by many jobs is uploaded once.

- Progress, saved and failed jobs, and recent errors: `midjourney_batch_status` (`waitMs` waits for the batch to finish). Every step is also in `<folder>/state.json` and `<folder>/run.log`.
- If Chrome closes, the extension restarts or the computer sleeps, calls time out after a few minutes at most and are retried without counting against the job; jobs already in Midjourney are picked up again. On a Mac the batch keeps the computer awake while it runs.
- Moderation refusals fail a job at once with Midjourney's reason; jobs Midjourney errors on are sent again, up to 4 times. `retryFailed` sends failed jobs again.
- `midjourney_batch_pause` stops sending new jobs and lets the ones in Midjourney finish (`now` stops at once). `midjourney_batch_start` on the same folder resumes, also from a new Claude session, and adds any new jobs. A batch runs in the MCP server of the session that started it, so it stops when that session ends; resume it the same way.

The vary, upscale, pan and zoom tools take one of your own finished results (`jobId` plus `index`, or a `cdn.midjourney.com/<jobId>/0_<index>.png` URL) and reuse its prompt. Upscales return one image. On `--v 8.1`/`8.2`, pan and zoom are sent as Editor jobs, as midjourney.com does; older versions use Midjourney's pan and zoom jobs. `--v 8` has no upscale, pan or zoom.

## Skills

[`skills/`](skills) holds Claude Code skills that tell Claude when and how to use the Midjourney image tools:

| Skill | For requests like |
| --- | --- |
| [`midjourney-outcrop`](skills/midjourney-outcrop/SKILL.md) | "make this 16:9", "extend the background", "zoom out" |
| [`midjourney-repaint`](skills/midjourney-repaint/SKILL.md) | "erase the sign", "change just the jacket", "repaint this face" |
| [`midjourney-style-reference`](skills/midjourney-style-reference/SKILL.md) | "make a poster in the style of this image" |
| [`midjourney-restyle`](skills/midjourney-restyle/SKILL.md) | "turn this photo into anime / watercolor / pixel art" |
| [`midjourney-iterate`](skills/midjourney-iterate/SKILL.md) | "vary the second one", "upscale that", "pan left", "zoom out 2x" |

Install them for every project (symlinks into `~/.claude/skills`, so edits here apply right away; `-- --copy` copies instead):

```bash
npm run install-skills
```

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `BROWSE_HACK_PORT` | `17892` | Port to listen on. Change the port in the extension's Settings to match. |
| `BROWSE_HACK_EXTENSION_ID` | any | Accept only this extension id (shown on `chrome://extensions`). |

Pass them with `-e NAME=value` in `claude mcp add`, or an `"env"` object in the Desktop config. With the `.mcpb` install, set them in the extension's settings in Claude Desktop.

## Security

- The server listens on `127.0.0.1` only.
- Web pages can open WebSockets to localhost, but the server rejects any connection that carries a web page's `Origin`. Only extensions (`chrome-extension://…`) and local processes get in. Set `BROWSE_HACK_EXTENSION_ID` to accept only this extension.
- Any program on your computer can reach the port, the same as any local process can reach your browser profile. Turn the switch off in Settings when you don't want Claude to use the extension.
- `get_settings` never returns the Mediamake sign-in or API key, only the account and how it's signed in. Claude can't set an API key; the user does that in the popup.
- If the extension goes silent for a minute (Chrome froze, the computer slept), the server drops its connection so pending calls fail instead of hanging, and the extension reconnects.

## Develop

```bash
npm run build     # compile to dist/
npm run inspect   # try the tools in the MCP Inspector
npm run pack:mcpb # build browse-hack.mcpb for Claude Desktop
```

`pack:mcpb` bundles `src/` into a single `server/index.js` with esbuild (no `node_modules` in the bundle), copies [`manifest.json`](manifest.json) with the version from `package.json` and the tool list read from the server itself, and packs it with the [`mcpb`](https://github.com/modelcontextprotocol/mcpb) CLI. New tools show up in the bundle without editing the manifest.

The extension side lives in [`get-into-zone/lib/mcpBridge.ts`](../get-into-zone/lib/mcpBridge.ts): each tool calls a method there (`youtube.download`, `pinterest.bulkStart`, …). To add a tool, add a method to `commands` in that file and a `tool(...)` line in [`src/index.ts`](src/index.ts).
