# Browse Hack MCP changelog

Release notes for `mcp/browse-hack` in the MediaMake catalog. Add a
`## <version>` section with every version bump: CI releases the MCP on merge
with that section as its notes (without one, the commit subjects since the
last release; see `.github/workflows/release-browse-hack-mcp.yml`). They show
on Browse Hack's page on MediaMake and in `get_status` / `update_browse_hack`
after an update.

## 0.11.0

- `youtube_fill_uploads` gets past Details on channels in the Partner Programme, with Browse Hack 0.13.0: it turns monetisation On (or Off with `"monetization": false`), answers Ad suitability with None of the above and clicks Submit rating (`"adSuitability": "skip"` leaves it to you), then goes on through Video elements and Checks to Visibility and sets the schedule. Before, it stopped on Details with "Your video needs a monetisation setting".
- New in info.json: `endScreen` imports the end screen from one of the channel's videos (by title) and can point its playlist element at another playlist; `cards` adds channel cards with their message and teaser.
- When Studio refuses the thumbnail, it tries again once the upload is under way, and the warning gives Studio's own reason instead of "Upload file".

## 0.10.2

- `youtube_fill_uploads`, `youtube_switch_channel` and `youtube_list_channels` switch channels again on profiles that manage several: with Browse Hack 0.12.3 the Studio tab comes to the front while it opens the account menu (Studio only draws that menu in a visible tab), instead of failing with "Couldn't find Switch account".

## 0.10.1

- Browse Hack's own logo, the green cursor, replaces Plasmo's default purple icon in Claude's extensions list. Browse Hack 0.12.2 shows the same logo in Chrome's toolbar and on `chrome://extensions`, with icons drawn for 16, 32 and 48 px so it stays sharp in the toolbar.

## 0.10.0

- `saver_set` and `saver_remove_rule` take `suno`: Browse Hack's buttons on suno.com (Copy for Claude, Variations, Save and the Create form's bar) turn on and off like the other overlays, also from the popup's Saver tab.
- `suno_download` works with Suno's new download dialog, through Browse Hack 0.12.0: it picks only the format asked for (MP3 or WAV) and presses Unlock & Download, then waits for Suno to prepare the file (up to five minutes for a WAV).
- Songs downloaded before don't count against the month's downloads (Suno lets you download them again for free), and `downloadsLeft` is read back from Suno after downloading.
- `suno_cover` of an audio file goes through Suno's new upload dialog (rights, content categories, description), with Browse Hack 0.12.0.

## 0.9.0

- Makes songs on Suno: `suno_create` fills Suno's own Create form (lyrics, styles, exclude styles, title, model, vocal gender, sliders, workspace) and clicks Create in Browse Hack's Suno tab, then waits for the two songs. Suno runs its usual checks; a captcha brings the tab forward for you.
- Covers, extensions, mashups, samples and inspirations with `suno_cover`, from a Suno song, a MediaMake library item (one that came from Suno is covered from Suno directly) or an audio file you own.
- Records every take in MediaMake cloud under the channel's project (`suno_list_generations`, `suno_rate`, `suno_list_presets`, `suno_save_preset`), once MediaMake has its songs database.
- `suno_download` saves keepers into the library inbox (`_INBOX/suno/<channel>/<set>/`) with a `.source.json` holding the lyrics, styles, settings and parent; it reports Suno's monthly downloads left.
- `suno_batch_start`, `suno_batch_status` and `suno_batch_pause` run many songs in the background and pause for a captcha or low credits. New `suno-songs` skill.
- Needs Browse Hack 0.11.0 or later, which adds Copy for Claude, Variations and Save buttons on suno.com and a Suno tab in the popup.

## 0.8.1

- `pinterest_bulk_start` tells the extension which of the pins the library has are videos, so a video pin is skipped only when the library has its video, not just its cover image. Needs Browse Hack 0.10.1, which also saves video pins as videos when you're signed in to Pinterest instead of saving their covers.

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
