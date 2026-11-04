# Browse Hack MCP server

Lets Claude (Claude Code, Claude Desktop, or any MCP client) use the [Browse Hack](../get-into-zone) extension running in your browser: bulk-download Pinterest, download YouTube videos and Instagram posts, save media to Mediamake, switch overlays on or off, make songs and covers on Suno and drive Midjourney.

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
| Updates | `update_browse_hack` |
| Tabs | `list_tabs`, `open_tab` |
| Settings | `get_settings`, `update_settings`, `list_projects` |
| Mediamake | `save_media_to_mediamake` |
| Pinterest | `pinterest_bulk_start`, `pinterest_bulk_stop`, `pinterest_bulk_status`, `pinterest_analyze_image`, `pinterest_save_analysis`, `pinterest_list_analyses` |
| YouTube | `youtube_get_video`, `youtube_download`, `youtube_list_downloads`, `youtube_cancel_download`, `youtube_clear_finished` |
| Instagram | `instagram_get_post`, `instagram_download` |
| Overlays (Saver tab) | `saver_get`, `saver_set`, `saver_remove_rule`, `saver_reset` |
| Suno | `suno_status`, `suno_list_workspaces`, `suno_list_songs`, `suno_get_songs`, `suno_create`, `suno_cover`, `suno_download`, `suno_list_generations`, `suno_rate`, `suno_list_presets`, `suno_save_preset`, `suno_batch_start`, `suno_batch_status`, `suno_batch_pause`, `suno_upload_track` |
| DistroKid | `distrokid_fill_releases` |
| YouTube Studio | `youtube_list_channels`, `youtube_switch_channel`, `youtube_fill_uploads` |
| Google AI Mode | `google_ai_save_answers` |
| Midjourney (prompt automation) | `midjourney_submit_prompts`, `midjourney_scrape`, `midjourney_queue_size`, `midjourney_list_queue`, `midjourney_run_queue`, `midjourney_load_prompts` |
| Midjourney (images) | `midjourney_outcrop`, `midjourney_repaint`, `midjourney_repaint_status`, `midjourney_generate`, `midjourney_vary`, `midjourney_upscale`, `midjourney_pan`, `midjourney_zoom_out`, `midjourney_job_status`, `midjourney_download_images` |
| Midjourney (batches) | `midjourney_batch_start`, `midjourney_batch_status`, `midjourney_batch_pause` |

Tools behave like the matching buttons in the popup; see the [main README](../README.md#use-browse-hack) for what each feature does.

Every tool needs the extension signed in to Mediamake (see [First-time setup](../README.md#first-time-setup)). When it isn't, tools say so; `sign_in_to_mediamake` opens the sign-in window in Chrome for the user to click **Allow**. `get_status` and `list_profiles` show each profile's sign-in.

- **Pinterest bulk download** collects what the tab shows. After `pinterest_bulk_start`, the tab has to be scrolled or navigated to collect more pins. Do that yourself, or let Claude do it with Claude in Chrome (see below).
- **YouTube** downloads only need a video URL. The extension uses any open YouTube tab to read the formats, or opens one in the background.
- **Instagram** downloads only need a post, reel or story URL, and you must be logged in to Instagram in that Chrome profile. The extension asks Instagram from any open instagram.com tab, or opens one in the background. Story highlights aren't supported.
- **DistroKid** fills https://distrokid.com/new/ from a release folder (`info.json`, audio, square cover). `distrokid_fill_releases` opens one tab per folder and does not click Continue. After you click it, `"useMyOriginals": true` in `info.json` picks Use my originals on the Mixea page, and `"addLyrics": true` opens Add your lyrics on the Done page, pastes the folder's `distrokid_lyrics.md`, picks the free Basic plan and ticks the agreement. You click Continue and Save lyrics.

- **YouTube Studio** uploads from a pack folder: `youtube_fill_uploads` opens one Studio tab per folder, switches the Chrome profile's YouTube to the channel `info.json` names (its `@handle`, name or `UC…` id), picks the video and fills the upload form, then stops on the Visibility step. You click Save, Publish or Schedule. Picking the video starts the upload, so each folder leaves a private draft on its channel even if you never save it. `youtube_list_channels` lists the channels you can switch to, and `youtube_switch_channel` switches without uploading. See [`info.json` for YouTube uploads](#infojson-for-youtube-uploads).

- **MediaMake's media library.** When `~/.mediamake/config.json` names a library (`{ "library": { "root": "~/Downloads/_LIBRARY", "inbox": "~/Downloads/_INBOX" } }`), `youtube_download`, `instagram_download`, `pinterest_bulk_start` and `midjourney_download_images` save into the inbox (`_INBOX/youtube`, `_INBOX/instagram`, `_INBOX/pinterest/<date>-<search>`, `_INBOX/midjourney/<set or date>`) unless you pass a `folder`, and MediaMake's `media` CLI files them into the library from there. Each file gets a `<file>.source.json` beside it (`schema: "mediamake.source/v1"`, `tool`, `ref`, the link, title, author, prompt, height, fps, `downloadedAt`), and a Pinterest session writes `_session.json` into its folder when it stops: every page visited with its search, and every pin saved or skipped with the search it came from. Before downloading, the server asks the library's catalog (`<root>/.catalog/library.db`, read only, Node 22.5 or later) and the inbox: YouTube videos and Instagram items it already has come back as `alreadyHave` with their path, and Pinterest skips its pins. `force: true` downloads anyway; a YouTube `maxHeight` above the library copy's height does too. Without the config the tools work as before.
- **Google AI Mode** answers are saved word for word: `google_ai_save_answers` asks each query at google.com/search?udm=50 in a background tab, waits for the answer to finish, and writes it to the file you name as Markdown (headings, lists, bold, links) with Google's cited sources at the end. The server writes the file itself, so the answer never passes through Claude. Queries run one at a time; `itemsFile` takes a long list. If a file comes out empty or holds the wrong part of the page, run one query with `saveHtml: true` and pass a CSS `selector`.

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

### Suno

Browse Hack makes songs the way you would: in a background "Browse Hack" suno.com tab it fills Suno's Create form (Advanced) and clicks Create, so Suno runs its usual checks. Songs, workspaces, credits and downloads left are read through suno.com's own API with your sign-in. It never calls Suno's generate endpoint itself.

| Tool | What it does |
| --- | --- |
| `suno_status` | Plan, credits, downloads left this month, models, upload limits; MediaMake channels with their linked Suno workspace and project; the library inbox |
| `suno_create` | A new song from `lyrics` (or `instrumental`), `styles` and the form's settings: `excludeStyles`, `title`, `model`, `vocalGender`, `weirdness`, `styleInfluence`, `variety`, `maxMode`. Makes two takes |
| `suno_cover` | A cover, extension, mashup, sample or inspiration (`kind`) `from` a Suno song, a MediaMake library item (a song that came from Suno is covered from Suno; any other file is uploaded) or an audio file. Uploading needs `rightsConfirmed: true` |
| `suno_list_songs`, `suno_get_songs`, `suno_list_workspaces` | Your songs (by workspace or channel, with a search), songs by id, your workspaces |
| `suno_download` | Clicks each song's own Download and files it as `_INBOX/suno/<channel>/<set>/<Title> [<id>].mp3` with a `<file>.source.json` (styles, lyrics, model, settings, parent, workspace, channel). Songs the library has come back as `alreadyHave`. Uses one Suno download per song |
| `suno_list_generations`, `suno_rate` | The channel's takes in MediaMake cloud (search by text, rating, model, kind, parent); rate keeper / maybe / reject, optionally downloading keepers |
| `suno_list_presets`, `suno_save_preset` | A channel's saved styles in MediaMake cloud, shared with its team and the Variations button |
| `suno_batch_start`, `suno_batch_status`, `suno_batch_pause` | Many songs or covers in the background, like the Midjourney batches: a few in Suno at once, each recorded, resumable from `<folder>/state.json` |

Things to know:
- **Credits:** each Create spends credits. The tools report them, and a batch stops under `minCredits` (default 200).
- **Captchas:** a captcha brings the tab forward and waits (`waitForUserMs`, default 5 minutes). It's never solved or skipped.
- **Downloads:** they're metered by Suno, so only keepers are downloaded unless `download: "all"`.
- **Recording:** takes are recorded through MediaMake's `/api/generations`. Until a MediaMake deploy has it, recording is skipped and the tools say so.
- **Channels:** the MCP server passes the library's channels (`~/.mediamake/config.json`) to the extension, and the popup's Suno tab links each one to a Suno workspace and a MediaMake project.

The [`suno-songs`](skills/suno-songs/SKILL.md) skill tells Claude how to use these.

The vary, upscale, pan and zoom tools take one of your own finished results (`jobId` plus `index`, or a `cdn.midjourney.com/<jobId>/0_<index>.png` URL) and reuse its prompt. Upscales return one image. On `--v 8.1`/`8.2`, pan and zoom are sent as Editor jobs, as midjourney.com does; older versions use Midjourney's pan and zoom jobs. `--v 8` has no upscale, pan or zoom.

## Updates

Installed through MediaMake (the install prompt from Browse Hack's page, following MediaMake's [install.md](https://github.com/microfox-ai/mediamake/blob/main/install.md)), Browse Hack keeps itself up to date:

- **The MCP server.** A minute after it starts and then every 6 hours, the server asks MediaMake for `mcp/browse-hack`'s live version (`GET /api/catalog/versions`, with the update token the install saved in `~/.mediamake/config.json`). When it's newer than `~/.mediamake/mcp/browse-hack`, it fetches the install plan, downloads the package, checks its sha256, and swaps the new files in. Servers already running keep their code; the next Claude session runs the new one, and the first tool result in a running session says so once.
- **The Chrome extension.** It picks the newest `vX.Y.Z` release here with `browse-hack-chrome.zip`. When that's newer than `~/Extensions/browse-hack-chrome`, it downloads the zip, checks GitHub's sha256 digest, swaps the folder's files (the same folder keeps the extension id and its settings), and calls `extension.reload` in each connected Chrome profile that loads the extension from that folder, then waits for each to reconnect on the new version. A profile is matched by its extension id, which Chrome derives from the folder's path. While a profile is busy (YouTube or Pinterest downloads, other Claude calls in flight, as `extension.status` reports) the update waits and tries again every 15 minutes. Extensions older than 0.10.0 can't reload themselves: the folder is updated and `get_status` asks for one click on the reload icon.
- **Builds in a git checkout, and other folders.** For a profile that loads the extension from anywhere else, the server looks up that extension id in the browser's profile preferences (`extensions.settings.<id>.path`, read only) to find the folder. It never writes to it. When the folder is a build inside a git checkout (such as `get-into-zone/build/chrome-mv3-prod` here) and a newer release is out, `get_status` and `update_browse_hack` say so and give the commands that update it (`git -C <checkout> pull --ff-only`, then `npm install` and `npm run build` in the package); Claude runs them only if you agree. Once a newer build is on disk, the next check reloads Chrome on it. A profile on some other folder is named with the way to switch to MediaMake's folder.
- **One at a time.** Each Claude session runs its own server; the one holding `~/.mediamake/updates/browse-hack.lock` checks, and the result is kept in `~/.mediamake/updates/browse-hack.json` for the others.
- **Versions and release notes.** `get_status` shows the MCP version this session runs, the one installed for the next session, the live versions, each Chrome profile's extension version, and the release notes of the last update. `update_browse_hack` checks and installs right away and reports the versions before and after; `reloadBusy` reloads the extension even while it's busy. The same versions and notes are on Browse Hack's page on MediaMake.
- **Turning it off.** `"autoUpdate": false` in `~/.mediamake/config.json` (or `update_browse_hack` with `autoUpdate: false`, or `BROWSE_HACK_AUTO_UPDATE=0` in the server's environment) stops the automatic checks; asking for an update still works.

MCP servers that weren't installed through MediaMake (Claude Desktop's `.mcpb`, a server run from this checkout) aren't touched; `get_status` says where this session's server runs from. Without an update token (installs from before 0.8.0), saying "update browse hack" once with an install prompt from MediaMake saves one.

Releases: [`CHANGELOG.md`](CHANGELOG.md) holds the release notes; merging to `main` releases the MCP to the catalog (see the [main README](../README.md#releases-are-automatic)).

## Skills

[`skills/`](skills) holds Claude Code skills that tell Claude when and how to use the Midjourney image tools:

| Skill | For requests like |
| --- | --- |
| [`midjourney-outcrop`](skills/midjourney-outcrop/SKILL.md) | "make this 16:9", "extend the background", "zoom out" |
| [`midjourney-repaint`](skills/midjourney-repaint/SKILL.md) | "erase the sign", "change just the jacket", "repaint this face" |
| [`midjourney-style-reference`](skills/midjourney-style-reference/SKILL.md) | "make a poster in the style of this image" |
| [`midjourney-restyle`](skills/midjourney-restyle/SKILL.md) | "turn this photo into anime / watercolor / pixel art" |
| [`midjourney-iterate`](skills/midjourney-iterate/SKILL.md) | "vary the second one", "upscale that", "pan left", "zoom out 2x" |
| [`suno-songs`](skills/suno-songs/SKILL.md) | "make a song on Suno", "cover this song in metal", "3 variations of this", pasted "Suno song:" blocks |

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

## `info.json` for YouTube uploads

Put it in the upload folder beside the video. Only `channel` and the title are required; a field you leave out keeps YouTube's default. Paths are relative to the folder.

```json
{
  "channel": "@anime-music-zone",
  "video": "Goten Theme.mp4",
  "titleFile": "title.txt",
  "descriptionFile": "description.txt",
  "thumbnail": "thumbnails/goten-A.jpg",
  "playlists": ["OST Tracks"],
  "madeForKids": false,
  "ageRestricted": false,
  "paidPromotion": false,
  "alteredContent": true,
  "tags": ["goten theme", "dragon ball ost"],
  "language": "en",
  "category": "Music",
  "license": "standard",
  "allowEmbedding": true,
  "notifySubscribers": true,
  "shortsRemixing": "video-and-audio",
  "automaticChapters": true,
  "featuredPlaces": true,
  "automaticConcepts": true,
  "comments": "on",
  "commentModeration": "basic",
  "whoCanComment": "anyone",
  "commentSort": "top",
  "showLikes": true,
  "visibility": "scheduled",
  "scheduleAt": "2026-11-09T18:30",
  "premiere": false,
  "monetization": true,
  "adSuitability": "none",
  "endScreen": { "importFrom": "Full Metal Heart - Edward Elric 「 AMZ 」( Lyric Video )", "playlist": "OST Tracks" },
  "cards": [{ "channel": "@get-into-zone", "message": "Music on Get into Zone", "teaser": "Music on Get into Zone" }],
  "abTest": [
    { "thumbnail": "thumbnails/goten-A.jpg", "title": "Goten Theme - Gregorian Chant" },
    { "thumbnail": "thumbnails/goten-B.jpg", "title": "Goten Theme, as a Gregorian Chant" }
  ]
}
```

| Field | What it fills |
| --- | --- |
| `channel` | The channel to switch to: `@handle`, its name as Studio's Switch account lists it, or its `UC…` id |
| `video` | The video file. Default: the only video in the folder |
| `title` / `titleFile` | The title (100 characters at most). Default: the first line of `title.txt` |
| `description` / `descriptionFile` | The description (5000 bytes at most). Default: `description.txt` when it exists |
| `thumbnail` | A JPG or PNG. Default: the only image in `thumbnails/` (unless `abTest` has thumbnails), or `thumbnail.jpg`/`.png`. Needs a phone-verified channel |
| `playlists` | Playlist names to tick; they must exist on the channel |
| `madeForKids` | Audience. Default `false` (No, it's not Made for Kids) |
| `ageRestricted`, `paidPromotion` | `true` or `false` |
| `alteredContent` | Show more → AI use (altered or synthetic content, including AI music that's the focus of the video) |
| `automaticChapters`, `featuredPlaces`, `automaticConcepts`, `allowEmbedding`, `notifySubscribers`, `showLikes` | The Show more checkboxes |
| `tags` | A list, or one comma-separated string (500 characters in all) |
| `language` | Video language: a code (`en`, `te`, `ja`) or its name (`English`) |
| `category` | `Music`, `Entertainment`, `Film and animation`, `Gaming`, `Education`, `People and blogs`… |
| `license` | `standard` or `creative-commons` |
| `shortsRemixing` | `video-and-audio`, `audio-only` or `off` |
| `comments`, `commentModeration`, `whoCanComment`, `commentSort` | `on`/`off`; `none`/`basic`/`strict`/`hold-all`; `anyone`/`subscribers`; `top`/`newest` |
| `visibility` | `private`, `unlisted`, `public` or `scheduled` |
| `scheduleAt` | `YYYY-MM-DDTHH:MM` (24-hour) in the time zone Studio shows; sets visibility to scheduled |
| `premiere` | Set as Premiere (public or scheduled only) |
| `monetization` | The Monetisation step (channels in the Partner Programme): `true` (On) or `false` (Off). Default On |
| `adSuitability` | The Ad suitability step that follows: `none` ticks None of the above and clicks Submit rating; `skip` leaves it to you. Default `none` |
| `endScreen` | Video elements → End screen → Import from video: that video's title, or `{ "importFrom": "<title>", "playlist": "<playlist>" }` to also point the imported playlist element at another playlist |
| `cards` | Video elements → Cards: channel cards, each `{ "channel": "@handle or name", "message": "…", "teaser": "…" }` (30 characters each; the teaser defaults to the message) |
| `abTest` | Details → A/B testing: 2 or 3 variants, each `{ "thumbnail": "<file>", "title": "…" }`. Thumbnails on every variant, titles on every variant, or both (Studio's Thumbnail only, Title only, or Title and thumbnail); it clicks Set test |

Subtitles and the Checks step are left as they are.
