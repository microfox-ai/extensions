# extensions

Simple Repo For Developing Extensions to support accelerated automations on local

| Folder | What it is |
| --- | --- |
| [`get-into-zone/`](get-into-zone) | **Browse Hack**: a Chrome extension that adds Save / AI overlays to images on any site, automates Midjourney prompts, and sends media to Mediamake |
| [`mcp/`](mcp) | **MCP server**: lets Claude (Claude Code, Claude Desktop) use the Browse Hack extension in your browser |

## Install Browse Hack

Every release is published on the [Releases page](https://github.com/microfox-ai/extensions/releases) as a ready-to-load zip. It works in Chrome and other Chromium browsers (Edge, Brave, Arc).

1. Download the zip:
   - Latest version: [browse-hack-chrome.zip](https://github.com/microfox-ai/extensions/releases/latest/download/browse-hack-chrome.zip)
   - A specific version: open [Releases](https://github.com/microfox-ai/extensions/releases) and download `browse-hack-vX.Y.Z-chrome.zip`
2. Unzip it into a folder you'll keep, for example `~/Extensions/browse-hack`. Don't delete this folder later: Chrome loads the extension from it.
3. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
4. Turn on **Developer mode** (toggle in the top right).
5. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
6. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Browse Hack**.

> Chrome may show a "Disable developer mode extensions" warning on startup. That's expected for extensions installed outside the Chrome Web Store; click away or choose **Keep**.

### Update to a new version

Installed from MediaMake (the install prompt from Browse Hack's page, which puts the extension in `~/Extensions/browse-hack-chrome` and the MCP server in `~/.mediamake/mcp/browse-hack`), Browse Hack updates itself: every few hours the MCP server installs a newer MCP and a newer extension, and reloads the extension in each Chrome profile that loads it from that folder (it waits while the extension is busy downloading). A profile that loads a build from a git checkout of this repo is never overwritten: Claude tells you it's behind and the commands to pull and rebuild, and reloads Chrome once the new build is there. The only reload by hand is the first one onto 0.10.0, since older copies can't reload themselves. To update right away, or to see which versions you have, say "update browse hack" to Claude (the `update_browse_hack` tool). `"autoUpdate": false` in `~/.mediamake/config.json` turns automatic updates off.

By hand:

1. Download the new zip.
2. Delete the contents of the folder you loaded in step 5 and unzip the new version into **the same folder**.
3. On `chrome://extensions`, click the reload icon on the **Browse Hack** card.

Keeping the same folder keeps the same extension ID, so your settings and saver rules carry over. The installed version is shown on the extension card.

## Use Browse Hack

### First-time setup

Browse Hack works once it's signed in to your Mediamake account. Until then the popup shows only **Sign in to Mediamake**, the on-page buttons stay hidden, and Claude's tools ask you to sign in.

1. Open the extension popup and click **Sign in to Mediamake**. A Mediamake window opens: sign in (if you aren't already), then click **Allow**. The window closes; open the popup again.
2. You stay signed in while you use the extension: the sign-in renews itself, and you're only asked again after 30 days without using it, or after you sign out.
3. Prefer an API key? Click **Use a Mediamake API key instead** on the sign-in screen and paste one. Every Mediamake user can make any number of keys on Mediamake's **API keys** page (one per app or computer), and disable or delete them there.
4. Using your own Mediamake (for example `http://localhost:3000`)? Change **Mediamake URL** on the sign-in screen before signing in.

Then, in **Settings**:

- **Tags**: comma-separated tags added to everything you save
- **Default Project**: the Mediamake project uploads go to

Click **Save Settings**. Settings also shows the account you're signed in as, with **Sign out**.

### Save media from any page

Hover any image or video (at least 50×50 px) and a **Save** button appears in its top-left corner. Click it to send the media, plus its prompt when on Midjourney, to Mediamake.

On Pinterest the overlay has more options:

| Button | What it does |
| --- | --- |
| Save + AI | Runs AI analysis (description, keywords, art style) and saves the image with it |
| Save (No AI) | Saves the image as is |
| AI Only | Runs the analysis without saving; results show up in the **Pinterest** tab |
| View AI | Shows the last analysis for that image |

On suno.com, songs get their own buttons; see [Make songs on Suno](#make-songs-on-suno-suno-tab-and-sunocom).

### Bulk download from Pinterest (Pinterest tab)

Saves every pin image and video you browse in a Pinterest tab, page after page, until you stop it.

1. Open Pinterest, then open the popup's **Pinterest** tab.
2. Under **Bulk download**, pick where images go:
   - **Browser downloads**: every image is saved into the same folder inside your Downloads folder (for example `Downloads/pinterest-2026-10-21`), and videos into a separate folder (default: a `videos` folder inside it)
   - **Mediamake**: every image and video is uploaded with the same tags (pre-filled from Settings). Uses your Mediamake sign-in and the Default Project from Settings
3. Untick **Also download videos** if you only want images.
4. Set **Max images, and videos, per page** (empty means no limit), then click **Start downloading this tab**.
5. Browse normally: scroll, open pins, search. Each new page contributes up to the limit, including pins loaded as you scroll.
6. Click **Stop** when done. The panel shows saved images and videos, queued and failed counts while it runs.

Rules:

- A page you go back to (Back button, or clicking to it again) is skipped, so it's never downloaded twice. A page is its path, plus the query on search pages.
- An image that already appeared on an earlier page is not saved again.
- Images are saved at original resolution when Pinterest has it, otherwise at 736px wide.
- Videos are saved as MP4 at up to 720p. Pinterest only plays videos as streams, so the extension finds the pin's MP4 file; for the few pins that have none, it downloads the stream and joins picture and sound into one MP4 (older pins become a `.ts` file).
- The session belongs to that tab only and ends when you click Stop, close the tab, or quit the browser.

### Download one Pinterest video

Hover a video pin anywhere on Pinterest (home feed, search, boards) and click **Download** in its bottom-left corner. On a video pin's own page the button stays visible on the video. The video is saved to your Downloads folder as an MP4 of up to 720p, named after the pin, for example `Pin title [1a2b3c4d].mp4`.

A progress card appears in the top-right corner of the page: × cancels a running download, **Show** opens a finished file in its folder. Turn the button off with the **Download buttons** switch in the Saver tab.

### Download a YouTube video

**On YouTube pages** (no popup needed):

- **Under the video title** on a watch page: click **Download** to save the video in the best H.264 quality with sound (up to 1080p; the quality and size are shown next to the button). Click the arrow next to it to pick another quality, audio only, or video only.
- **On any thumbnail** (home, search, sidebar, channel pages, Shorts): hover it and click **Download** in its bottom-left corner. That saves the same best-quality MP4 without opening the video.

A progress card appears in the top-right corner of the page: × cancels a running download, **Show** opens a finished file in its folder. Live streams can be downloaded only after they end. Turn the buttons off with the **Download buttons** switch in the Saver tab.

**From the popup's YouTube tab:**

1. Open a YouTube video (a `watch` page, a Short, or a live replay) in the current tab, then open the popup's **YouTube** tab. It shows the video's title, channel and length.
2. Pick what to save:
   - **Video + audio**: one MP4 with sound, up to 1080p in H.264 (higher when YouTube offers AV1 for the video)
   - **Video only**: picture without sound, every resolution YouTube has, including VP9 WebM up to 4K
   - **Audio only**: M4A (AAC) or WebM (Opus)
3. Choose a **Quality** (the estimated size is shown) and click **Download**. The file goes to your Downloads folder, named after the video, for example `Video title (1080p).mp4`.

Progress shows under **Downloads** in the tab, and keeps going if you close the popup. Click × to cancel, or the folder icon to show a finished file.

Notes:

- YouTube stores picture and sound as separate streams; for **Video + audio** the extension downloads both and merges them into one MP4 without re-encoding.
- The whole file is held in memory until it's saved, so very long videos at high quality need a lot of RAM.
- Videos that need sign-in (age-restricted, members-only, private) and paid or DRM-protected content can't be downloaded. Only download videos you have the right to save.

### Download Instagram photos and videos

You need to be logged in to Instagram in this browser.

**On instagram.com:** hover a photo or video in the feed, on a post page, in a profile or explore grid, on a reel, or in a story. **Download** saves the slide you're looking at; on carousels, **All** saves every slide. Files go to Downloads as `<username> - <post code> - <slide>.jpg` (or `.mp4`).

**From the popup's Instagram tab:** open a post, reel or story, or paste its link, then download one item or **Download all**.

Story highlights aren't supported. Only download posts you have the right to save.

### Turn overlays on or off (Saver tab)

The **Saver** tab controls where overlays appear. It has four switches:

- **All savers**: every overlay, including the buttons on suno.com
- **Save button**: the Save buttons
- **AI analyse**: the Save + AI, AI Only, and View AI buttons
- **Download buttons**: the Download buttons on YouTube thumbnails, under the YouTube video title, on Pinterest video pins, and on Instagram photos and videos

Pick where a change applies with **Apply changes to**, then flip a switch:

| Scope | Applies to | Lasts |
| --- | --- | --- |
| This page | The current URL (query string and `#hash` ignored) | Until you remove it |
| This site | Every page on the current domain (`www.` ignored) | Until you remove it |
| This window | Every tab in the current browser window | Until the window closes |
| Everywhere | All sites | Until you remove it |

When rules overlap, the narrowest one wins: page beats site, site beats window, window beats everywhere. That lets you do things like "off everywhere, but on for pinterest.com". When you flip a switch, any narrower rule for the current tab that would block the change is cleared, and an **Undo** link appears.

The bottom of the tab lists the rules affecting the current tab (remove one with ×), and **Show N rules for other pages** lists the rest. **Reset all** clears every rule (click it twice to confirm).

Shortcuts:

- **Toolbar badge**: the extension icon shows **OFF** when no overlay will appear on the current tab.
- **Right-click menu**: right-click any page, then **Hide savers** (or **Show savers** when they're off) → *On this page / On this site / In this window / Everywhere*.

### Let Claude use the extension (MCP)

With the [MCP server](mcp) set up, Claude can run everything above for you ("download this YouTube video at 720p", "bulk-download this Pinterest board", "save every slide of this Instagram post"). In **Settings**, **Let Claude use this extension (MCP)** turns this on or off; it shows **Connected to Claude** while the server runs. Setup steps are in [`mcp/README.md`](mcp/README.md).

### Upload to YouTube from a pack folder (Claude only)

Ask Claude to upload a folder that holds the video and an `info.json` (MediaMake's `pack-youtube` skill writes one). For each folder, Browse Hack opens YouTube Studio, switches this Chrome profile to the channel `info.json` names (Studio's **Switch account**), picks the video and fills in the upload form: title, description, thumbnail, playlists, audience, AI-use answer, tags, language, category, licence, comments, and visibility or a schedule. It stops on the **Visibility** step; you check the tab and click **Save**, **Publish** or **Schedule** yourself.

- Picking the video starts the upload, so YouTube keeps a private draft even if you close the tab.
- Custom thumbnails work only on channels verified by phone (youtube.com/verify while on that channel); Claude says when one didn't take.
- Switching channel changes which channel YouTube acts as in this Chrome profile, on youtube.com too.
- End screens, cards and subtitles are left for you to add.

The `info.json` fields are listed in [`mcp/README.md`](mcp/README.md#infojson-for-youtube-uploads).

### Make songs on Suno (Suno tab and suno.com)

Sign in to suno.com in the same Chrome profile. Browse Hack keeps every song you make for a channel in MediaMake: each take is recorded under the channel's MediaMake project (the team sees the prompts, lyrics and ratings), and the songs you keep are saved into MediaMake's media library.

**On suno.com:**
- **On a song:** hover it in any song list (or open its page) for three buttons:
  - **Copy for Claude**: copies its title, link, model, settings, styles, lyrics and channel, ready to paste into Claude with what to change.
  - **Variations ▾**: makes covers, an instrumental, an extension, the same lyrics in a new style, or the same prompt again. You pick the style (or one of the channel's saved styles), how many runs, the Suno workspace, the MediaMake channel and the song folder. Browse Hack runs them in its own Suno tab.
  - **Save**: downloads the song into the library inbox (`_INBOX/suno/<channel>/<song>/`), with a `.source.json` beside it, and marks it a keeper.
- **On the Create form:** a bar picks the channel, saves the form's styles and settings as a preset for the channel (**Save as preset**), and presses Create several times for you (**Run ×N**).

**In the popup's Suno tab:**
- your credits and the downloads left this month
- each MediaMake channel linked to its Suno workspace and MediaMake project
- the download format, and whether songs you download by hand on suno.com are filed into the library too
- **I own or license the audio I cover**: lets Browse Hack accept Suno's upload terms when it uploads one of your tracks for a cover. Only you can turn this on.

Things to know:
- Every Create makes two songs and costs credits. Downloads count against Suno's monthly download limit, so Browse Hack only downloads what you save.
- If Suno shows a captcha, Browse Hack brings its Suno tab forward and waits for you. It never solves one.
- Suno checks uploads against copyrighted music and refuses matches.

Claude does the same with the `suno_` tools (see [`mcp/README.md`](mcp/README.md#suno)): new songs, covers of your Suno songs or library tracks, batches, ratings, and saved styles.

### Automate Midjourney (Midjourney tab)

With a midjourney.com tab open, queue prompts as plain text (one per line) or JSON, pull them from your Mediamake database, scrape your Midjourney results, and run the request queue in batches.

## For maintainers

### Releases are automatic

Every push to `main` that changes code in `get-into-zone/` publishes a new release through the [release workflow](.github/workflows/release-browse-hack.yml). Nothing to do by hand:

- **Patch releases** (`0.1.0` → `0.1.1`): the workflow bumps the version in `package.json` and `package-lock.json`, commits it to `main` as `chore(release): browse-hack vX.Y.Z`, tags it, and publishes the release.
- **Minor or major releases**: set `version` in [`get-into-zone/package.json`](get-into-zone/package.json) yourself (for example `npm version minor --no-git-tag-version` in `get-into-zone/`) and push. If that version isn't released yet, the workflow releases it as is instead of bumping.

Each release has install notes, an auto-generated changelog, and two assets: `browse-hack-vX.Y.Z-chrome.zip` and `browse-hack-chrome.zip` (the stable name the "latest" link above points to).

Changes that don't need a new extension build don't trigger a release: Markdown files, and anything outside `get-into-zone/`. To release without a code change, open **Actions → Release Browse Hack extension → Run workflow**.

Run `git pull` after pushing so you have the bot's version-bump commit locally.

The MCP server is released the same way by its own [workflow](.github/workflows/release-browse-hack-mcp.yml): every push to `main` that changes `mcp/` tests it, packs `browse-hack.mcpb` and releases it to the MediaMake catalog as `mcp/browse-hack`, with the notes from that version's section of [`mcp/CHANGELOG.md`](mcp/CHANGELOG.md) (patch-bumping `mcp/package.json` and `mcp/manifest.json` when the version is already out, and tagging `mcp-vX.Y.Z`). It needs the repository secret `MEDIAMAKE_ADMIN_KEY` (a MediaMake admin's API key) and, for another site than mediamake.microfox.app, the variable `MEDIAMAKE_URL`; without the key it only builds and tests. Installed copies pick up both releases within a few hours.

### Develop locally

See [`get-into-zone/README.md`](get-into-zone/README.md).
