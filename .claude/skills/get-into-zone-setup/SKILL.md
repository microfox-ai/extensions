---
name: get-into-zone-setup
description: Set up everything needed for Claude to use the Get into zone browser extension from this repo — build the MCP server, register it with Claude Code and/or Claude Desktop, build and load the Chrome extension, connect the two, and verify. Use when someone who cloned this repo asks to "set up get-into-zone", "install the MCP server", "connect Claude to the extension", "make the get-into-zone tools work", or when get-into-zone tools are missing or say the extension isn't connected.
---

# Set up Get into zone for Claude

Gets a fresh clone of this repo to the point where Claude can call the `get-into-zone` MCP tools (Pinterest bulk download, YouTube downloads, Mediamake, Suno, Midjourney) in the user's own Chrome.

```
Claude ──stdio──▶ MCP server (mcp/) ◀──WebSocket 127.0.0.1:17892── extension (get-into-zone/) ──▶ the user's tabs
```

Three pieces have to line up: the **server** is built, **Claude** is told to start it, and the **extension** (a build that includes the MCP bridge) is loaded in Chrome with its MCP switch on. Do the steps in order, check each one, and skip any that are already done. Run commands from the repo root; use absolute paths when registering the server.

## 1. Check what's already there

Run these and note the results before changing anything:

```bash
node --version                      # needs 18 or newer
claude mcp get get-into-zone        # already registered with Claude Code? which path?
ls mcp/dist/index.js get-into-zone/build/chrome-mv3-prod/manifest.json
```

If the `get_status` tool is already available in this session, call it: a response listing at least one extension means everything works and only the parts the user asked about need doing.

If Node is missing or older than 18, stop and tell the user to install the current LTS from nodejs.org (or `brew install node`), then continue.

## 2. Ask which Claude app(s) to connect

Unless the user already said, ask whether they want the tools in **Claude Code**, **Claude Desktop**, or both. Both can run at once: the first server to start owns the port and the other relays through it.

## 3. Build the MCP server

```bash
cd mcp && npm install && npm run build
```

`mcp/dist/index.js` must exist afterwards. `npm audit` warnings from `npm install` come from build-only tools and can be ignored.

## 4. Register the server

**Claude Code** (user scope, so it works in every project):

```bash
claude mcp add get-into-zone -s user -- node "<repo>/mcp/dist/index.js"
```

Replace `<repo>` with the absolute path of this clone (`pwd` from the repo root). If `claude mcp get get-into-zone` showed a different path, run `claude mcp remove get-into-zone -s user` first. If the `claude` CLI isn't on PATH (for example in the desktop app), tell the user to run the command from a terminal where `claude` works, or add the same entry under `mcpServers` in `~/.claude.json`.

**Claude Desktop** (one-click bundle):

```bash
cd mcp && npm run pack:mcpb
```

This writes `mcp/get-into-zone.mcpb`. On macOS, `open mcp/get-into-zone.mcpb` shows Claude Desktop's install dialog; elsewhere, tell the user to double-click the file or drag it into **Settings → Extensions**. The user clicks **Install** themselves. If they previously added `get-into-zone` by hand to `claude_desktop_config.json`, have them remove that entry so it doesn't run twice.

## 5. Build and load the Chrome extension

Build it from this clone, so the extension and server match:

```bash
cd get-into-zone && npm install && npm run build
```

The build lands in `get-into-zone/build/chrome-mv3-prod`. Loading it is something only the user can do: Claude can't open `chrome://` pages, including with Claude in Chrome. Give them these steps with the absolute path filled in:

1. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose `<repo>/get-into-zone/build/chrome-mv3-prod`.
4. If Get into zone was already loaded from that folder, click its reload icon instead.

Loading from a *different* folder than before gives the extension a new ID, so its settings start empty. If the user already has it loaded from a release zip, either keep that copy (if it's 0.2.0 or newer, the MCP bridge is included) or remove it so only one copy is installed.

For more than one Chrome profile, load the extension in each profile that should be usable, and suggest giving each a **Profile name** in the popup's Settings so they're easy to tell apart (otherwise they show up by Google account). Each Claude session then works in one profile: when two or more are connected, ask the user which one to use, naming each by its Google account email (and its Profile name, if set), never by its number, which the user doesn't know (from `list_profiles`); call `use_profile` with their answer, and never pick one for them.

## 6. Turn on the connection

Tell the user to open the extension popup → **Settings** and check **Let Claude use this extension (MCP)**. It's on by default and shows **Connected to Claude** once a server is running. The port there must match the server's (default `17892`; the server reads `GET_INTO_ZONE_PORT`).

The extension retries every 30 seconds, so the first connection can take that long.

## 7. Start the server and verify

A newly registered or rebuilt server is only picked up when Claude starts it:

- **Claude Code**: start a new session, or open `/mcp` in the current one, pick `get-into-zone` and choose **Reconnect**. Claude can't restart its own MCP servers, so ask the user to do this.
- **Claude Desktop**: installing the `.mcpb` starts it; otherwise quit and reopen Claude Desktop.

Then call `get_status`. Success looks like:

```json
{ "port": 17892, "bridgePid": 12345, "profiles": [{ "id": "…", "label": "Work", "version": "0.2.0", ... }], "sessionProfile": null }
```

With two or more profiles listed, ask the user which to use (by email, never by number) and call `use_profile` before anything else. When it works, offer a quick test, such as `list_tabs`.

## Optional extras

- **Midjourney skills**: `cd mcp && npm run install-skills` links the `midjourney-outcrop`, `midjourney-repaint`, `midjourney-style-reference`, `midjourney-restyle` and `midjourney-iterate` skills into `~/.claude/skills`.
- **Mediamake**: saving to Mediamake needs the API endpoint (`https://mediamake.microfox.app`) and key in the popup's **Settings**. The user types the key there themselves; never ask for it in chat or write it to a file.
- **Accept only this extension**: set `GET_INTO_ZONE_EXTENSION_ID` to the ID shown on `chrome://extensions` (`claude mcp add … -e GET_INTO_ZONE_EXTENSION_ID=<id>`, or the extension id field in Claude Desktop's settings for the bundle).

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| No `get-into-zone` tools in Claude | Server not registered or not started: check `claude mcp list`, then reconnect (step 7). |
| `get_status` shows `"profiles": []`, or tools say the extension isn't connected | Extension not loaded, its MCP switch is off, or the ports differ. Check the status line under the switch. Wait 30 seconds after turning it on. |
| Extension version below 0.2.0, or no MCP switch in Settings | An old build without the bridge. Rebuild and reload it (step 5). |
| `get_status` has `extensions` instead of `profiles`, or there's no `use_profile` tool | The running server is older than the code: rebuild (step 3) and reconnect it (step 7). With Claude Code and Claude Desktop both open, restart both so neither runs the old bridge. |
| `Port 17892 is in use by something else` | Another program owns the port. Pick another port in the extension's Settings and pass the same one as `GET_INTO_ZONE_PORT`. |
| A tool acts in the wrong Chrome profile | Call `use_profile` with the right one (from `list_profiles`); the choice lasts for the session. |
| Two profiles show the same label, or `Profile 1a2b…` | Set a different **Profile name** in each profile's Settings. Profiles show a short id when they have no name and no signed-in Google account. |

More detail: [`mcp/README.md`](../../../mcp/README.md) and the main [`README.md`](../../../README.md).
