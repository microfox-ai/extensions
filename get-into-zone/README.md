This is a [Plasmo extension](https://docs.plasmo.com/) project bootstrapped with [`plasmo init`](https://www.npmjs.com/package/plasmo).

> Just want to install the extension? Download it from [Releases](https://github.com/microfox-ai/extensions/releases) and follow the [install steps](../README.md#install-browse-hack).

## Project layout

| Path | What it does |
| --- | --- |
| `popup.tsx` | Popup shell and header tabs. Set `hidden: true` in `TABS` to hide a tab (AI Agents is hidden) |
| `componenets/` | One component per popup tab (`SaverTab.tsx`, `MidjourneyTab.tsx`, ...) |
| `content.ts` | Content script: Save / AI overlays on images, the Pinterest bulk-download collector |
| `background.ts` | Service worker: API calls, Midjourney queue, Suno transcription upload |
| `lib/midjourneyApi.ts` | Midjourney image jobs: Editor outcrop and repaint, Create-page generate, and vary, upscale, pan and zoom on a result |
| `lib/midjourneyExplore.ts` | Midjourney's Explore for the MCP server: feeds, search and the Styles tab, read in a midjourney.com tab |
| `lib/midjourneyEdit.ts` | Repaint sessions: opens the brush tab and submits once the user erases a region |
| `tabs/midjourney-edit.tsx` | Brush page where the user marks the parts of an image Midjourney should repaint |
| `lib/mediamake.ts` | Mediamake sparkboard-index upload, shared by the Save overlay and bulk download |
| `lib/pinterestBulk.ts` | Pinterest bulk download: session types, pin image and video URL parsing, page keys |
| `lib/pinterestBulkBackground.ts` | Pinterest bulk download sessions (one per tab): per-page limits, skipping revisited pages, the download / upload queue. A stopped session keeps only its counts in `chrome.storage.session` (10 MB for the whole extension); when it is full, stopped sessions of other tabs are cleared |
| `lib/googleImages.ts` | Google Images bulk download: session types, reading a result's original image from Google's data, file names (tests: `lib/googleImages.test.mjs`) |
| `lib/googleImagesPage.ts` | Runs in the Google Images tab's own page: reads the results' data from its scripts and from the answers to Google's own More results requests, and clicks More results |
| `lib/googleImagesBackground.ts` | Google Images bulk sessions (one per tab): reads the tab, asks for more results, the download / upload queue with its count, size filter and `.source.json` sidecars |
| `componenets/GoogleImagesTab.tsx` | Popup tab: bulk-download the Google Images search in the active tab (count, smallest side, folder), progress and Stop |
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
| `lib/instagram.ts` | Instagram: post / reel / story URL parsing, shortcode to media id, the in-page media lookup (needs a logged-in session), file names |
| `lib/instagramBackground.ts` | Instagram lookups for the popup (run in an open instagram.com tab) and saving files to Downloads |
| `contents/instagram.ts` | Content script on Instagram: Download / All buttons on hovered photos and videos, result toasts |
| `componenets/InstagramTab.tsx` | Popup tab: load the current or a pasted post, download one slide or all |
| `lib/suno/clip.ts` | Suno songs as Browse Hack uses them: normalised clips, accounts and workspaces, Copy for Claude text, file names, the MediaMake cloud record |
| `lib/suno/form.ts`, `lib/suno/selectors.ts` | Suno's Create form, driven like a person: fields, sliders, model and workspace pickers, audio uploads, a song's Download. Every selector is in `selectors.ts`; how suno.com works is in `lib/suno/NOTES.md` |
| `contents/suno.ts` | Content script on suno.com: reads through Suno's API with the page's sign-in, fills and submits the Create form, takes uploads, and the Copy for Claude / Variations / Save buttons and the Create-form bar |
| `contents/sunoPage.ts` | Runs in suno.com's own page: reports what the site's Create request returned, and sets the Lexical lyrics editor |
| `lib/sunoBridge.ts` | Suno for the MCP server and the buttons: the background Suno tab, making and downloading songs one at a time, filing downloads into the library inbox, MediaMake cloud records and presets |
| `lib/sunoPrefs.ts`, `componenets/SunoTab.tsx` | Suno settings and their popup tab: channel ↔ workspace ↔ MediaMake project links, download format, upload terms |
| `contents/youtubeStudio.ts` | Content script on YouTube Studio: switches channels, fills the upload dialog from info.json (Details, Monetisation, Ad suitability, Video elements, Visibility), reads the Shorts list and a video's details, opens drafts |
| `contents/youtubeStudioPage.ts` | Runs in Studio's own page: sets thumbnail files (from the isolated world their upload fails) and reads the thumbnail editor's error |
| `lib/youtubeUploadBridge.ts` | YouTube Studio for the MCP server and the popup's jobs: channel switching, one Studio tab per upload, drafts |
| `lib/studioFront.ts` | Brings a Studio tab to the front only while Browse Hack uses Studio's page (account menu, reading lists, filling the form; Studio draws none of them in a background tab), then puts the user's tab back |
| `componenets/StudioTab.tsx` | Popup tab: Upload from a pack (info.json), Bulk Upload Shorts (shorts-pack.json), Autofill Shorts (drafts copy their most similar short and go on the next day with no short) |
| `lib/studioJobs.ts`, `lib/studioFiles.ts` | The popup's Studio jobs, run by the service worker from files the popup saved in IndexedDB (the popup closes once Studio comes to the front) |
| `lib/youtubePackFiles.ts`, `lib/youtubeShorts.ts` | Reading a picked pack folder (info.json or shorts-pack.json), empty-day scheduling, and which short a draft copies |
| `lib/libraryFiles.ts` | Files for MediaMake's media library, written through `chrome.downloads`: a download's `<file>.source.json` and a Pinterest session's `_session.json` |
| `lib/saverRules.ts` | Saver toggle rules (page / site / window / everywhere) shared by popup, content script, and background |
| `lib/saverBackground.ts` | Toolbar "OFF" badge, right-click menu, window-rule cleanup |

## Releasing

Releases are automatic: every push to `main` that changes code here bumps the patch version and publishes a GitHub release via the repo-level [release workflow](../.github/workflows/release-browse-hack.yml). For a minor or major release, set `version` in `package.json` before pushing. See [Releases are automatic](../README.md#releases-are-automatic).

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
