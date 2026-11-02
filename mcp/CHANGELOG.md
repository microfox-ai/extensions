# Browse Hack MCP changelog

Release notes for `mcp/browse-hack` in the MediaMake catalog. Add a
`## <version>` section with every version bump: CI releases the MCP on merge
with that section as its notes (without one, the commit subjects since the
last release; see `.github/workflows/release-browse-hack-mcp.yml`). They show
on Browse Hack's page on MediaMake and in `get_status` / `update_browse_hack`
after an update.

## 0.8.0

- Keeps itself up to date: a minute after it starts and then every few hours it checks MediaMake for a newer Browse Hack MCP and installs it into `~/.mediamake/mcp/browse-hack` (checked against its sha256). The next Claude session runs the new version.
- Keeps the Chrome extension up to date: installs new releases into `~/Extensions/browse-hack-chrome` (checked against GitHub's digest) and reloads the extension in every Chrome profile that loads it from there, waiting while it's busy with downloads or other Claude calls.
- New `update_browse_hack` tool: checks and installs now, reports the versions before and after with the release notes, and turns automatic updates on or off.
- `get_status` shows the MCP version this session runs, the one installed for the next session, the live versions and the extension version in each Chrome profile.

## 0.7.0

- Switches YouTube channels and fills YouTube Studio's upload form from a pack folder's info.json.

## 0.6.0

- YouTube, Instagram, Pinterest and Midjourney downloads go to MediaMake's media library inbox with a source sidecar, and media the library already has is skipped.

## 0.5.0

- Saves Google AI Mode answers to files word for word.

## 0.4.0

- Fills DistroKid's Mixea and lyrics pages after Continue.

## 0.3.0

- Signs in to MediaMake; Midjourney batch tools that survive dropped connections.

## 0.2.0

- Renamed from Get into zone to Browse Hack.
