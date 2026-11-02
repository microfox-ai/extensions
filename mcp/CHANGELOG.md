# Browse Hack MCP changelog

Release notes for `mcp/browse-hack` in the MediaMake catalog. Add a
`## <version>` section with every version bump: CI releases the MCP on merge
with that section as its notes (without one, the commit subjects since the
last release; see `.github/workflows/release-browse-hack-mcp.yml`). They show
on Browse Hack's page on MediaMake and in `get_status` / `update_browse_hack`
after an update.

## 0.9.0

- Makes songs on Suno: `suno_create` fills Suno's own Create form (lyrics, styles, exclude styles, title, model, vocal gender, sliders, workspace) and clicks Create in Browse Hack's Suno tab, then waits for the two songs. Suno runs its usual checks; a captcha brings the tab forward for you.
- Covers, extensions, mashups, samples and inspirations with `suno_cover`, from a Suno song, a MediaMake library item (one that came from Suno is covered from Suno directly) or an audio file you own.
- Records every take in MediaMake cloud under the channel's project (`suno_list_generations`, `suno_rate`, `suno_list_presets`, `suno_save_preset`), once MediaMake has its songs database.
- `suno_download` saves keepers into the library inbox (`_INBOX/suno/<channel>/<set>/`) with a `.source.json` holding the lyrics, styles, settings and parent; it reports Suno's monthly downloads left.
- `suno_batch_start`, `suno_batch_status` and `suno_batch_pause` run many songs in the background and pause for a captcha or low credits. New `suno-songs` skill.
- Needs Browse Hack 0.11.0 or later, which adds Copy for Claude, Variations and Save buttons on suno.com and a Suno tab in the popup.

## 0.8.0

- Keeps itself up to date: a minute after it starts and then every few hours it checks MediaMake for a newer Browse Hack MCP and installs it into `~/.mediamake/mcp/browse-hack` (checked against its sha256). The next Claude session runs the new version.
- Keeps the Chrome extension up to date: installs new releases into `~/Extensions/browse-hack-chrome` (checked against GitHub's digest) and reloads the extension in every Chrome profile that loads it from there, waiting while it's busy with downloads or other Claude calls.
- Never overwrites a build in a git checkout: a profile running one is told it's behind, with the commands to pull and rebuild, and Chrome is reloaded once the new build is on disk.
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
