# Get into zone MCP server

Lets Claude (Claude Code, Claude Desktop, or any MCP client) use the [Get into zone](../get-into-zone) extension running in your browser: bulk-download Pinterest, download YouTube videos, save media to Mediamake, switch overlays on or off, upload Suno tracks and drive Midjourney.

```
Claude ──stdio──▶ MCP server (this folder) ◀──WebSocket 127.0.0.1:17892── extension service worker ──▶ your tabs
```

The extension connects out to the server, so the server never needs browser access of its own. Everything happens in your real browser profile, with your sign-ins.

## Setup

With Claude Code, open this repo and ask Claude to "set up get-into-zone": the [`get-into-zone-setup`](../.claude/skills/get-into-zone-setup/SKILL.md) skill runs the steps below and tells you which ones to do in Chrome.

### Claude Desktop: one-click install

1. Get `get-into-zone.mcpb`, or build it yourself (Node 18+):

   ```bash
   cd mcp && npm install && npm run pack:mcpb
   ```

2. Double-click `get-into-zone.mcpb`, or drag it into Claude Desktop's **Settings → Extensions**, then click **Install**. The port and an optional extension id can be changed there later. Claude Desktop runs the server with its built-in Node, so nothing else needs installing.

3. Continue with step 3 below to load the browser extension.

### Manual setup (Claude Code, other clients)

1. Build the server (Node 18+):

   ```bash
   cd mcp && npm install && npm run build
   ```

2. Add it to Claude.

   **Claude Code**:

   ```bash
   claude mcp add get-into-zone -s user -- node /absolute/path/to/extensions/mcp/dist/index.js
   ```

   **Claude Desktop**: add this to `~/Library/Application Support/Claude/claude_desktop_config.json` (Windows: `%APPDATA%\Claude\claude_desktop_config.json`), then restart Claude Desktop:

   ```json
   {
     "mcpServers": {
       "get-into-zone": {
         "command": "node",
         "args": ["/absolute/path/to/extensions/mcp/dist/index.js"]
       }
     }
   }
   ```

3. Load a build of the extension that includes the bridge (version after 0.1.0, or `npm run build` in `get-into-zone/` and load `build/chrome-mv3-prod`). In the popup, **Settings → Let Claude use this extension (MCP)** is on by default and shows **Connected to Claude** once the server runs. The extension looks for the server every 30 seconds, so the first connection can take up to that long.

4. Ask Claude something like "check the get-into-zone status", then "download this YouTube video at 1080p: https://youtu.be/…".

Claude Code and Claude Desktop can both use it at once: the first server to start listens on the port and later ones relay through it. If the first one exits, another takes over and the extension reconnects.

The extension can also be connected from several Chrome profiles at once. `list_tabs` lists the tabs of every profile, marked with a `profile` number that matches `get_status`. A tool given a `tabId` runs in the profile that has that tab; a tool without one runs in the profile whose window you used last (marked `default` in `get_status`).

## Tools

| Area | Tools |
| --- | --- |
| Status and tabs | `get_status`, `list_tabs`, `open_tab` |
| Settings | `get_settings`, `update_settings`, `list_projects` |
| Mediamake | `save_media_to_mediamake` |
| Pinterest | `pinterest_bulk_start`, `pinterest_bulk_stop`, `pinterest_bulk_status`, `pinterest_analyze_image`, `pinterest_save_analysis`, `pinterest_list_analyses` |
| YouTube | `youtube_get_video`, `youtube_download`, `youtube_list_downloads`, `youtube_cancel_download`, `youtube_clear_finished` |
| Overlays (Saver tab) | `saver_get`, `saver_set`, `saver_remove_rule`, `saver_reset` |
| Suno | `suno_upload_track` |
| Midjourney (prompt automation) | `midjourney_submit_prompts`, `midjourney_scrape`, `midjourney_queue_size`, `midjourney_list_queue`, `midjourney_run_queue`, `midjourney_load_prompts` |
| Midjourney (images) | `midjourney_outcrop`, `midjourney_generate`, `midjourney_job_status`, `midjourney_download_images` |

Tools behave like the matching buttons in the popup; see the [main README](../README.md#use-get-into-zone) for what each feature does. Two notes:

- **Pinterest bulk download** collects what the tab shows. After `pinterest_bulk_start`, the tab has to be scrolled or navigated to collect more pins. Do that yourself, or let Claude do it with Claude in Chrome (see below).
- **YouTube** downloads only need a video URL. The extension uses any open YouTube tab to read the formats, or opens one in the background.

### Midjourney image tools

These call midjourney.com's own API from a midjourney.com tab (one opens in the background if none is open), signed in as you. Each job uses your GPU time; `mode` defaults to `relaxed`.

| Tool | What it does | Midjourney equivalent |
| --- | --- | --- |
| `midjourney_outcrop` | Puts an image in a bigger frame (`aspectRatio`, `anchor`, `scale`) and fills the rest | Editor → Move → aspect ratio → Submit edit |
| `midjourney_generate` | New images, optionally with `imagePrompts`, `styleReferences` (`--sref`), `omniReferences` (`--oref`) or an `editImage` to restyle (`--edit`) | Create page, images dropped in the prompt bar |
| `midjourney_job_status` | Status of a job; `wait: true` waits for the images | |
| `midjourney_download_images` | Saves a job's images to Downloads | Download |

Images can be an `https://` URL, an absolute local file path (read by the MCP server), or `mj:<jobId>#<index>` for an earlier result. Jobs wait up to 4 minutes by default and return the four image URLs (`https://cdn.midjourney.com/<jobId>/0_<index>.png`). Longer relaxed jobs return their status; poll them with `midjourney_job_status`.

## Skills

[`skills/`](skills) holds Claude Code skills that tell Claude when and how to use the Midjourney image tools:

| Skill | For requests like |
| --- | --- |
| [`midjourney-outcrop`](skills/midjourney-outcrop/SKILL.md) | "make this 16:9", "extend the background", "zoom out" |
| [`midjourney-style-reference`](skills/midjourney-style-reference/SKILL.md) | "make a poster in the style of this image" |
| [`midjourney-restyle`](skills/midjourney-restyle/SKILL.md) | "turn this photo into anime / watercolor / pixel art" |

Install them for every project (symlinks into `~/.claude/skills`, so edits here apply right away; `-- --copy` copies instead):

```bash
npm run install-skills
```

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `GET_INTO_ZONE_PORT` | `17892` | Port to listen on. Change the port in the extension's Settings to match. |
| `GET_INTO_ZONE_EXTENSION_ID` | any | Accept only this extension id (shown on `chrome://extensions`). |

Pass them with `-e NAME=value` in `claude mcp add`, or an `"env"` object in the Desktop config. With the `.mcpb` install, set them in the extension's settings in Claude Desktop.

## Security

- The server listens on `127.0.0.1` only.
- Web pages can open WebSockets to localhost, but the server rejects any connection that carries a web page's `Origin`. Only extensions (`chrome-extension://…`) and local processes get in. Set `GET_INTO_ZONE_EXTENSION_ID` to accept only this extension.
- Any program on your computer can reach the port, the same as any local process can reach your browser profile. Turn the switch off in Settings when you don't want Claude to use the extension.
- `get_settings` never returns the API key, only whether one is set.

## Develop

```bash
npm run build     # compile to dist/
npm run inspect   # try the tools in the MCP Inspector
npm run pack:mcpb # build get-into-zone.mcpb for Claude Desktop
```

`pack:mcpb` bundles `src/` into a single `server/index.js` with esbuild (no `node_modules` in the bundle), copies [`manifest.json`](manifest.json) with the version from `package.json` and the tool list read from the server itself, and packs it with the [`mcpb`](https://github.com/modelcontextprotocol/mcpb) CLI. New tools show up in the bundle without editing the manifest.

The extension side lives in [`get-into-zone/lib/mcpBridge.ts`](../get-into-zone/lib/mcpBridge.ts): each tool calls a method there (`youtube.download`, `pinterest.bulkStart`, …). To add a tool, add a method to `commands` in that file and a `tool(...)` line in [`src/index.ts`](src/index.ts).
