# How suno.com works (mapped 2026-11-02, read-only)

What Browse Hack's Suno code relies on, read from the live site in a signed-in
Premier account. When Suno changes, fix `selectors.ts` (the page) or `clip.ts`
(the API's shapes) and update this file.

## API

- Same origin: `https://suno.com/a/api/...` (a proxy to Suno's studio API).
- Auth: `Authorization: Bearer <the __session cookie>`. That cookie is a
  short-lived JWT the page keeps fresh (about 30 minutes left at any time);
  cookies alone get 401. The page also sends `browser-token` and `device-id`;
  reads work without them.
- Reads used here:
  - `GET  /a/api/billing/info/`: `total_credits_left`, `plan.name`,
    `models[]` (`name` v6 / v6-wild / v6-mini, `external_key` chirp-hawk /
    chirp-hawk-wild / chirp-goose), `download_usage`
    (`current_period_downloads_used` / `_limit`, `additional_download_remaining`),
    `audio_upload_limits` (`min` 6 s, `max` 1800 s on Premier), `accessible_features`.
  - `GET  /a/api/project/me?page=N`: workspaces (`projects[]`: id, name,
    clip_count). "My Workspace" has id `default`.
  - `POST /a/api/feed/v3` `{ cursor, limit, filters }`: a page of songs.
    Filters the site sends: `disliked: "False"`, `trashed: "False"`,
    `fromStudioProject: { presence: "False" }`, `stem: { presence: "False" }`,
    `stemComplement: "False"`, `workspace: { presence: "True", workspaceId }`,
    `searchText`. Answers `{ clips, next_cursor, has_more }`.
  - `GET  /a/api/feed/v2?ids=a,b`: exactly those songs (status polling).
  - `GET  /a/api/clip/<id>`: one song.
- A clip: `id`, `title`, `status` (complete when done), `model_name`
  (chirp-hawk…), `major_model_version`, `metadata.tags` (styles),
  `metadata.negative_tags` (exclude styles), `metadata.prompt` (lyrics,
  "[Instrumental]" for none), `metadata.make_instrumental`,
  `metadata.control_sliders` (`style_weight` 0-1, `aug_creativity` = Variety,
  …), `metadata.task` ("cover", …), `metadata.cover_clip_id` /
  `edited_clip_id` (the parent), `clip_roots` (the original song),
  `project` (`{ id, name }` = workspace), `batch_index` (0/1: each Create makes
  two), `image_url`, `media_urls` (signed playback stream), `audio_url`
  (`…/api/forbidden` until downloads are unlocked), `is_download_unlocked`,
  `handle`, `created_at`.
- Writes are NOT called directly:
  - Create posts `/api/generate/v2-web/` with a captcha token (Cloudflare
    Turnstile, hCaptcha as fallback). Browse Hack fills the form and clicks
    Create, so the page gets its own token. It never solves or skips a
    captcha: a visible challenge pauses the run for the user.
  - Downloads are metered (60 a month on Premier). Browse Hack clicks the
    song's own Download item and files the browser download; it never saves
    the playback stream instead. See "The download dialog" below.
  - Uploads go through Suno's upload dialog (below) and are checked against
    copyright databases (Audible Magic, ACRCloud).

## Checked live (2026-11-02, one Create on Premier)

- Filling the form as `form.ts` does and clicking Create made the site send
  `POST /a/api/generate/v2-web/` itself: 200, no captcha shown, answer
  `{ id: <batch id>, clips: [{ id, status }, { id, status }] }`, which
  `contents/sunoPage.ts` reports. One Create cost 10 credits; both instrumental
  songs were `complete` about 40 seconds later (2 minutes long each).
- A v6-wild song has `model_name: "chirp-hawk"` (as v6 has) and
  `major_model_version: "v6-wild"`.
- Suno rewrites the styles you type (style augmentation): `metadata.tags` is
  its longer version, which is what reproduces the song.
- Default sliders aren't stored: `control_sliders` held only `aug_creativity: 1`.

## The Create page (`/create`)

- URL parameters: `wid` (workspace), `song_id` + `remix_type` (`cover`,
  `extend`, …) load a song as the audio condition with its lyrics, styles and
  title; also `persona_id`, `voice_id`, `custom_model_id`. The page drops
  them from the address once read. (`auto_generate` exists; never used.)
- Tabs Songs / Speech / Sounds; modes Simple / Advanced (Advanced holds every
  field). Model button (text `v6-wild`) opens a menu: v6, v6-wild, v6-mini,
  Create Custom Model.
- `+ Audio` (`aria-label` "Add audio - Browse, upload, or record audio") opens
  Browse / Upload / Record; an empty Audio card has its own Upload
  (`aria-label` "Upload audio file", which sets the audio up as a Cover). In
  Advanced mode (checked live 2026-11-02) only `+ Audio` is there. It is
  Suno's own dropdown (`data-context-menu-trigger`): mouse-down toggles it, a
  click does nothing, and Enter toggles it too. The menu is a `position: fixed`
  box with `[data-context-menu]` and no role, put at the end of `<body>`. Each
  item is a `<button>` whose icon and label sit in `display: contents`
  wrappers that measure 0×0, so look for the button, not its label. Upload
  keeps the menu open.
- Both Uploads open the file picker by calling `.click()` on a hidden file
  input Suno's code adds to `<body>` (its handler is the `onchange`
  property): `contents/sunoPage.ts` catches that click while Browse Hack is
  uploading. Takes wav, flac, mp3, ogg, opus, webm, m4a, aac.
  With audio set: "Change condition type from Cover" (Cover, Mashup, Sample,
  Inspo; Extend, Crop, Remove Section, Reverse, Speed, Pro edits) and "Clear
  audio condition". Extend shows an "Extend from" time. The condition type
  button is the same mouse-down dropdown as `+ Audio`.
- Browse Hack's Suno tabs open in the background, where Chrome runs no CSS
  animations. A closed Radix dialog stays in the page with
  `data-state="closed"` until its exit animation ends, and it vanishes as soon
  as the tab is shown, so ignore closed dialogs.

## The upload dialog (read from suno.com's code and `/locales/en/*.json`, 2026-11-02)

A picked audio file goes through a dialog (a Radix Dialog, `role="dialog"`)
before it is on the Create form. The dialog closes while the file uploads and
comes back for the description; Escape or a pointer-down outside it cancels
the upload. Suno decodes the file first (6 s to 1800 s on Premier). With a
file already picked, the stages are:

1. The first time: "Confirm your rights" (Yes / No), or "Upload audio" with
   "Agree to Terms" (which sets `audio-upload-tos-acceptance` in localStorage).
2. Only when no file is picked yet (Record, or the dialog opened on its own):
   Upload or Record, with a hidden `input[type=file]` in the dialog and
   Upload / Library buttons.
3. "Identify audio content (select up to 3)": Full Song, Song Demo, Voice,
   Instrument Stem, Loop… then Continue (none picked is fine).
4. "Describes the contents of your uploaded audio": Suno analyses it and
   writes a description; the button says Skip until it has, then Continue.

Live on Premier (2026-11-02), steps 3 and 4 are one page: "Describes the
contents of your uploaded audio" (an empty box), the category chips, then
Back / Continue (no Skip). Above every step, a progress line reads "Uploading
Clip", then "Initializing", then "Uploaded". Continue before "Uploaded" hands
the file to Suno's background finish: the dialog came back, the audio never
reached the form, and the file showed up twice in Uploads. Continue after
"Uploaded" creates the clip and puts it on the form as a Cover.

Refusals: "This audio matches an existing recording", "Copyrighted material
detected", "This audio contains copyrighted lyrics".

## The download dialog (read from suno.com's code and `/locales/en/downloads.json`, 2026-11-02)

A song's Download opens "Download songs": one toggle per format (M4A, MP3,
WAV, MP4 video asset; several can be on, a picked one shows a check mark; M4A
starts on on a Mac, MP3 elsewhere), stems and MIDI, then "Unlock & Download"
for a song not downloaded yet (`POST /api/download/authorize` uses one of the
month's downloads) or "Download" for one that is, which uses none. The file
is fetched by the page and saved from a `blob:` link named after the title, so
a download carries no song id. A WAV is converted first (`convert_wav`, polled
up to two minutes). Out of downloads, the dialog is "Out of Downloads" with
download packs to buy.
- Lyrics: a contenteditable `[aria-label="Lyrics editor"]`; empty means
  instrumental.
- Styles: `textarea[maxlength=1000]` next to "Clear styles" / "Save prompt" /
  "View saved style prompts".
- More Options: `input[placeholder="Exclude styles"]`, rows labelled Vocal
  Gender (Male / Female), Duration (Custom / Auto), Max Mode (Off / On),
  sliders `[role=slider][aria-label=Weirdness|Style Influence|Audio Influence|Variety]`
  (0-100 %, Variety in steps), My Taste (Off / On).
- `input[placeholder^="Song Title"]`, then the workspace button.
- `button[aria-label="Create song"]`, `button[aria-label="Clear all form inputs"]`,
  `button[aria-label^="Credits remaining"]`.

## Song menus

A song's "…" menu: Remix ▸ (Cover, Reuse Prompt, Mashup, Sample this song, Use
as Inspiration, Voice), Edit ▸ (Extend, Crop, Remove Section, Reverse, Adjust
Speed, Fade In/Out, Add Vocal, Replace Section, Get Stems / MIDI, Remaster,
Open in Studio / Editor), Publish, Share, Download (the download dialog),
Manage ▸ (Song Details,
Create Cover Art, Allow Remixes, Allow Comments, Pin to Profile, Move to
Workspace), Add to Queue / Playlist, Song Radio, Report, Move to Trash.
