# Browse Hack MCP changelog

Release notes for `mcp/browse-hack` in the MediaMake catalog. Add a
`## <version>` section with every version bump: CI releases the MCP on merge
with that section as its notes (without one, the commit subjects since the
last release; see `.github/workflows/release-browse-hack-mcp.yml`). They show
on Browse Hack's page on MediaMake and in `get_status` / `update_browse_hack`
after an update.

## 0.14.0

- Search Midjourney's Explore from Claude, with Browse Hack 0.17.0. `midjourney_explore` searches like Explore's search box (`query`) or reads a feed (`top_month`, `top`, `hot`, `new`, `random`, `videos`, …), and gives each image or video its prompt rebuilt as a command you can reuse (`--ar`, `--sref`, `--p`, `--v` …), its style codes, maker, full-size and preview links, its page on midjourney.com and a ref (`mj:<jobId>#<index>`) that `midjourney_generate` takes in `imagePrompts` or `styleReferences`.
- `midjourney_explore_styles` finds style codes (`--sref`) in Explore's Styles tab, by words, by a code (styles like it) or from a feed, with preview pictures.
- `midjourney_explore_download` saves picks (PNGs, and videos as MP4) into the library inbox under `midjourney/references/<date>-<search>`, so MediaMake files them as references, with a `.source.json` holding the prompt, maker, model and the search they came from. What the library already has comes back as `alreadyHave`.
- The requests run in a midjourney.com tab like the other Midjourney tools. The search, the Styles tab and every feed but Top month need that tab signed in; signed out, Midjourney answers Top month whatever feed is asked for, and the result says so.

## 0.13.1

- Suno makes every song on the model you asked for. With Browse Hack 0.16.4, `suno_create`, `suno_cover` and `suno_batch_start` pick the model in Suno's Create form, wait for the form to hold it (suno.com puts its last model back a moment after the form loads, which is how a batch that switched between v6 and v6-wild on 5 Nov got the previous model on 9 Creates), read it back again after the other fields, and click Create only when the form shows it; otherwise the Create page is loaded afresh and filled once more, then the job fails with the model the form shows, spending no credits.
- After the songs are made, their model is checked against the one asked for: `suno_create` and `suno_cover` answer with `modelMismatch` and a warning, and a batch job whose songs came out on another model fails (its error names the songs) instead of counting as done, in `run.log` and `suno_batch_status`. `retryFailed` makes such a job again.
- Creates from this server go to Browse Hack one at a time, whoever asks (a batch at any concurrency, two batches, `suno_create` beside a batch): the next form fill starts only once the previous Create is confirmed, so two jobs never share the form.

## 0.13.0

- New tool `youtube_bulk_upload_shorts`: the popup's Bulk Upload Shorts from Claude. Give it a folder with `shorts-pack.json` (MediaMake's pack-youtube writes one for a production's shorts) and it uploads each short in its own YouTube Studio tab on the next day that has no short on the channel, at the pack's time, with Browse Hack 0.16.0. It stops on Visibility for you to click Schedule, or clicks Schedule itself with `clickSchedule` when you ask. A mistake in the pack (a missing video, a short with no title) stops it before anything goes up.

## 0.12.0

- `youtube_fill_uploads` sets up YouTube's A/B testing from info.json's `abTest`, with Browse Hack 0.14.0: 2 or 3 variants, each a thumbnail, a title or both (Thumbnail only, Title only, or Title and thumbnail). It uploads every thumbnail, types the titles and clicks Set test. A video that already has a test keeps it.
- Thumbnails go up: Studio previewed the thumbnail Browse Hack gave it, then its upload failed ("Studio refused the thumbnail"). Browse Hack now hands the file over from Studio's own page, where it goes up, and says Studio's own reason when it still refuses one.
- Ad suitability gets submitted: Browse Hack waits for Studio's rating ("Safe for ads") before pressing Submit rating, checks that Studio took it, and tries once more. Before, it pressed too soon and Studio stayed on Ad suitability.

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
