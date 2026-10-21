# Get into zone MCP server

Lets Claude (Claude Code, Claude Desktop, or any MCP client) use the [Get into zone](../get-into-zone) extension running in your browser: bulk-download Pinterest, download YouTube videos, save media to Mediamake, switch overlays on or off, upload Suno tracks and drive Midjourney.

```
Claude ──stdio──▶ MCP server (this folder) ◀──WebSocket 127.0.0.1:17892── extension service worker ──▶ your tabs
```

The extension connects out to the server, so the server never needs browser access of its own. Everything happens in your real browser profile, with your sign-ins.

## Setup

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
| Midjourney | `midjourney_submit_prompts`, `midjourney_scrape`, `midjourney_queue_size`, `midjourney_list_queue`, `midjourney_run_queue`, `midjourney_load_prompts` |

Tools behave like the matching buttons in the popup; see the [main README](../README.md#use-get-into-zone) for what each feature does. Two notes:

- **Pinterest bulk download** collects what the tab shows. After `pinterest_bulk_start`, the tab has to be scrolled or navigated to collect more pins. Do that yourself, or let Claude do it with Claude in Chrome (see below).
- **YouTube** downloads only need a video URL. The extension uses any open YouTube tab to read the formats, or opens one in the background.

## Configuration

| Variable | Default | Use |
| --- | --- | --- |
| `GET_INTO_ZONE_PORT` | `17892` | Port to listen on. Change the port in the extension's Settings to match. |
| `GET_INTO_ZONE_EXTENSION_ID` | any | Accept only this extension id (shown on `chrome://extensions`). |

Pass them with `-e NAME=value` in `claude mcp add`, or an `"env"` object in the Desktop config.

## Security

- The server listens on `127.0.0.1` only.
- Web pages can open WebSockets to localhost, but the server rejects any connection that carries a web page's `Origin`. Only extensions (`chrome-extension://…`) and local processes get in. Set `GET_INTO_ZONE_EXTENSION_ID` to accept only this extension.
- Any program on your computer can reach the port, the same as any local process can reach your browser profile. Turn the switch off in Settings when you don't want Claude to use the extension.
- `get_settings` never returns the API key, only whether one is set.

## Develop

```bash
npm run build     # compile to dist/
npm run inspect   # try the tools in the MCP Inspector
```

The extension side lives in [`get-into-zone/lib/mcpBridge.ts`](../get-into-zone/lib/mcpBridge.ts): each tool calls a method there (`youtube.download`, `pinterest.bulkStart`, …). To add a tool, add a method to `commands` in that file and a `tool(...)` line in [`src/index.ts`](src/index.ts).
