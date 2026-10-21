This is a [Plasmo extension](https://docs.plasmo.com/) project bootstrapped with [`plasmo init`](https://www.npmjs.com/package/plasmo).

> Just want to install the extension? Download it from [Releases](https://github.com/microfox-ai/extensions/releases) and follow the [install steps](../README.md#install-get-into-zone).

## Project layout

| Path | What it does |
| --- | --- |
| `popup.tsx` | Popup shell and header tabs. Set `hidden: true` in `TABS` to hide a tab (Suno and AI Agents are hidden) |
| `componenets/` | One component per popup tab (`SaverTab.tsx`, `MidjourneyTab.tsx`, ...) |
| `content.ts` | Content script: Save / AI overlays on images, the Suno upload panel, the Pinterest bulk-download collector |
| `background.ts` | Service worker: API calls, Midjourney queue, Suno upload |
| `lib/mediamake.ts` | Mediamake sparkboard-index upload, shared by the Save overlay and bulk download |
| `lib/pinterestBulk.ts` | Pinterest bulk download: session types, pin image and video URL parsing, page keys |
| `lib/pinterestBulkBackground.ts` | Pinterest bulk download sessions (one per tab): per-page limits, skipping revisited pages, the download / upload queue |
| `lib/pinterestVideoBackground.ts` | Saves one Pinterest video: finds its MP4, or falls back to HLS through `tabs/offscreen.tsx`. Shares the single offscreen-document slot with the YouTube downloader |
| `contents/pinterest.ts` | Content script on Pinterest: Download button on video pins, progress cards |
| `lib/pinterestVideoDownload.ts` | One-click Pinterest video downloads from that button: jobs, progress, cancel |
| `lib/hls.ts` | Downloads an HLS stream (best variant plus its audio rendition) into one MP4, or a `.ts` for MPEG-TS streams |
| `tabs/offscreen.tsx` | Offscreen document that turns Pinterest HLS videos into blob URLs for download or Mediamake upload |
| `contents/youtube.ts` | Content script on youtube.com: Download button on thumbnails and under the watch-page title, progress cards |
| `lib/youtube.ts` | YouTube download: video ID parsing, the in-tab player request, format choices per mode |
| `lib/youtubeBackground.ts` | YouTube download jobs: offscreen document, progress in `chrome.storage.session`, saving to Downloads |
| `lib/mp4Merge.ts` | Muxes a video-only and an audio-only fragmented MP4 into one file, no re-encoding |
| `tabs/youtube-offscreen.tsx` | Offscreen document that fetches YouTube streams in ranged chunks and merges them |
| `lib/saverRules.ts` | Saver toggle rules (page / site / window / everywhere) shared by popup, content script, and background |
| `lib/saverBackground.ts` | Toolbar "OFF" badge, right-click menu, window-rule cleanup |

## Releasing

Releases are automatic: every push to `main` that changes code here bumps the patch version and publishes a GitHub release via the repo-level [release workflow](../.github/workflows/release-get-into-zone.yml). For a minor or major release, set `version` in `package.json` before pushing. See [Releases are automatic](../README.md#releases-are-automatic).

To build the same zip locally:

```bash
npm run build && npm run package
```

The zip lands in `build/chrome-mv3-prod.zip`.

## Getting Started

First, run the development server:

```bash
pnpm dev
# or
npm run dev
```

Open your browser and load the appropriate development build. For example, if you are developing for the chrome browser, using manifest v3, use: `build/chrome-mv3-dev`.

You can start editing the popup by modifying `popup.tsx`. It should auto-update as you make changes. To add an options page, simply add a `options.tsx` file to the root of the project, with a react component default exported. Likewise to add a content page, add a `content.ts` file to the root of the project, importing some module and do some logic, then reload the extension on your browser.

For further guidance, [visit our Documentation](https://docs.plasmo.com/)

## Making production build

Run the following:

```bash
pnpm build
# or
npm run build
```

This should create a production bundle for your extension, ready to be zipped and published to the stores.

## Submit to the webstores

The easiest way to deploy your Plasmo extension is to use the built-in [bpp](https://bpp.browser.market) GitHub action. Prior to using this action however, make sure to build your extension and upload the first version to the store to establish the basic credentials. Then, simply follow [this setup instruction](https://docs.plasmo.com/framework/workflows/submit) and you should be on your way for automated submission!
