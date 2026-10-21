# extensions

Simple Repo For Developing Extensions to support accelerated automations on local

| Folder | What it is |
| --- | --- |
| [`get-into-zone/`](get-into-zone) | **Get into zone**: a Chrome extension that adds Save / AI overlays to images on any site, automates Midjourney prompts, and sends media to Mediamake |
| [`midjourney-gen-workflow1/`](midjourney-gen-workflow1) | Standalone Midjourney generation script |

## Install Get into zone

Every release is published on the [Releases page](https://github.com/microfox-ai/extensions/releases) as a ready-to-load zip. It works in Chrome and other Chromium browsers (Edge, Brave, Arc).

1. Download the zip:
   - Latest version: [get-into-zone-chrome.zip](https://github.com/microfox-ai/extensions/releases/latest/download/get-into-zone-chrome.zip)
   - A specific version: open [Releases](https://github.com/microfox-ai/extensions/releases) and download `get-into-zone-vX.Y.Z-chrome.zip`
2. Unzip it into a folder you'll keep, for example `~/Extensions/get-into-zone`. Don't delete this folder later: Chrome loads the extension from it.
3. Open `chrome://extensions` (Edge: `edge://extensions`, Brave: `brave://extensions`).
4. Turn on **Developer mode** (toggle in the top right).
5. Click **Load unpacked** and select the unzipped folder (the one that contains `manifest.json`).
6. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **Get into zone**.

> Chrome may show a "Disable developer mode extensions" warning on startup. That's expected for extensions installed outside the Chrome Web Store; click away or choose **Keep**.

### Update to a new version

1. Download the new zip.
2. Delete the contents of the folder you loaded in step 5 and unzip the new version into **the same folder**.
3. On `chrome://extensions`, click the reload icon on the **Get into zone** card.

Keeping the same folder keeps the same extension ID, so your settings and saver rules carry over. The installed version is shown on the extension card.

## Use Get into zone

### First-time setup

Open the extension popup, go to **Settings**, and fill in:

- **API Endpoint**: your Mediamake URL (defaults to the hosted instance)
- **API Key**: your Mediamake API key. The extension sends it with every request to the Mediamake APIs (saving media, loading projects, the Midjourney queue) to authorize them
- **Tags**: comma-separated tags added to everything you save
- **Default Project**: the Mediamake project uploads go to

Click **Save Settings**.

### Save media from any page

Hover any image or video (at least 50×50 px) and a **Save** button appears in its top-left corner. Click it to send the media, plus its prompt when on Midjourney, to Mediamake.

On Pinterest the overlay has more options:

| Button | What it does |
| --- | --- |
| Save + AI | Runs AI analysis (description, keywords, art style) and saves the image with it |
| Save (No AI) | Saves the image as is |
| AI Only | Runs the analysis without saving; results show up in the **Pinterest** tab |
| View AI | Shows the last analysis for that image |

On suno.com, an **Upload to Mediamake** panel appears under the open track's Remix/Edit button.

### Bulk download from Pinterest (Pinterest tab)

Saves every pin image and video you browse in a Pinterest tab, page after page, until you stop it.

1. Open Pinterest, then open the popup's **Pinterest** tab.
2. Under **Bulk download**, pick where images go:
   - **Browser downloads**: every image is saved into the same folder inside your Downloads folder (for example `Downloads/pinterest-2026-10-21`), and videos into a separate folder (default: a `videos` folder inside it)
   - **Mediamake**: every image and video is uploaded with the same tags (pre-filled from Settings). Uses the API Endpoint, API Key and Default Project from Settings
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

### Turn overlays on or off (Saver tab)

The **Saver** tab controls where overlays appear. It has three switches:

- **All savers**: every overlay, including the Suno upload panel
- **Save button**: the Save buttons
- **AI analyse**: the Save + AI, AI Only, and View AI buttons

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

### Automate Midjourney (Midjourney tab)

With a midjourney.com tab open, queue prompts as plain text (one per line) or JSON, pull them from your Mediamake database, scrape your Midjourney results, and run the request queue in batches.

## For maintainers

### Releases are automatic

Every push to `main` that changes code in `get-into-zone/` publishes a new release through the [release workflow](.github/workflows/release-get-into-zone.yml). Nothing to do by hand:

- **Patch releases** (`0.1.0` → `0.1.1`): the workflow bumps the version in `package.json` and `package-lock.json`, commits it to `main` as `chore(release): get-into-zone vX.Y.Z`, tags it, and publishes the release.
- **Minor or major releases**: set `version` in [`get-into-zone/package.json`](get-into-zone/package.json) yourself (for example `npm version minor --no-git-tag-version` in `get-into-zone/`) and push. If that version isn't released yet, the workflow releases it as is instead of bumping.

Each release has install notes, an auto-generated changelog, and two assets: `get-into-zone-vX.Y.Z-chrome.zip` and `get-into-zone-chrome.zip` (the stable name the "latest" link above points to).

Changes that don't need a new extension build don't trigger a release: Markdown files, and anything outside `get-into-zone/`. To release without a code change, open **Actions → Release Get into zone extension → Run workflow**.

Run `git pull` after pushing so you have the bot's version-bump commit locally.

### Develop locally

See [`get-into-zone/README.md`](get-into-zone/README.md).
