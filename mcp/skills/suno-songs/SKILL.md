---
name: suno-songs
description: Make songs, covers and variations on Suno for a MediaMake channel through the Browse Hack browser extension, record every take in MediaMake cloud, and save the keepers into MediaMake's media library. Use when the user asks to "make a song on Suno", "generate songs / tracks", "cover this song", "make variations / versions of this Suno song", "extend this song", "an instrumental version", "run these prompts on Suno", pastes a "Suno song:" block copied with Browse Hack's Copy for Claude button, or wants a channel's past Suno prompts and keepers.
---

# Suno songs through Browse Hack

Browse Hack drives Suno in the user's own Chrome: it fills Suno's Create form and clicks Create in a background "Browse Hack" Suno tab, so Suno runs every check it normally does. Each take is recorded in MediaMake cloud under the channel's project, where the whole team can search it (`suno_list_generations`). Keepers are downloaded into MediaMake's media library inbox, ready for `media ingest`.

## Before you start

- The `browse-hack` MCP tools must be available. If a tool says the extension isn't connected, call `get_status`. If it's connected in several Chrome profiles, ask the user which one by Google account email (the one signed in to Suno), then `use_profile`.
- Call `suno_status` first. It shows the plan, the **credits** and the **downloads left this month**, the models (`v6`, `v6-wild`, `v6-mini`), and each MediaMake channel with its linked Suno workspace and MediaMake project. Links are made in the Browse Hack popup's Suno tab. If the channel the user means has no workspace or project yet, tell them where to link it. The tools still work without the links.
- Credits: every Create makes two songs and spends credits. Say what a request will cost in runs ("3 runs = 6 songs") and get a yes before more than two or three runs, or before any batch.
- Downloads are metered by Suno (60 a month on Premier). Download only the songs the user keeps.

## Write the request

1. **Look at what the channel already made.** Use `suno_list_generations` with the channel and a `q` such as the song or a style word, or `rating: "keeper"`. Reuse the styles and settings of keepers, and don't repeat rejected ones. Saved styles are in `suno_list_presets`.
2. **A new song** is `suno_create`:
   - `styles`: genre, mood, instruments and vocals, up to 1000 characters.
   - `lyrics`: section tags such as `[Verse]` and `[Chorus]` on their own lines. Use `instrumental: true` instead for no vocals.
   - Optional: `title`, `excludeStyles`, `model`, `vocalGender`, `weirdness` / `styleInfluence` (0-100), `channel`.
3. **A cover or extension** is `suno_cover` with `from`:
   - **A Suno song id or link.** These come from a pasted "Suno song:" block, `suno_list_songs`, or an earlier result.
   - **A MediaMake library item id**, from `media find --kind=music`. A library song that came from Suno is covered from Suno directly.
   - **An audio file's path.** It is uploaded to Suno. **Ask the user** whether they own or license it, and pass `rightsConfirmed: true` only on their yes. Suno itself rejects uploads that match copyrighted music.

   Leave `lyrics` and `styles` out to keep the source's, or give new ones. `kind: "extend"` with `extendFrom` (seconds) continues a song.
4. **Many songs** go through `suno_batch_start` (a folder, the jobs, the `channel`), agreed with the user first. Check on it with `suno_batch_status` (`waitMs` waits).

## While it runs

- The tools wait for the songs (about 1-3 minutes) unless `wait: false`. `suno_get_songs` checks songs by id.
- **A captcha:** if Suno shows one, the Browse Hack Suno tab comes to the front and the tool waits. Tell the user to clear it in that tab. Never try to solve or get around it.
- **Uploads:** an upload may stop at Suno's terms ("you have the rights"). The user ticks them in the tab, unless they turned on "I own or license the audio I cover" in Browse Hack's Suno tab.

## After

1. Give the user the song links and ask which to keep.
2. Rate the takes with `suno_rate`: `keeper`, `maybe` or `reject`, with a `note` on what was wrong. With `download: true`, keepers are saved too.
3. Or download with `suno_download`. Files go to `_INBOX/suno/<channel>/<set>/<Title> [<id>].mp3`, with a `.source.json` holding the styles, lyrics, model, settings and parent. Then file them in the mediamake repo with `npm run media -w lyrics_videos -- ingest`; they land in `music/<channel>/<song>/`.
4. Save a style the user liked with `suno_save_preset`, for the channel's team and the Variations button on suno.com.

## On suno.com

The user can do the same without Claude. Hovering a song shows:
- **Copy for Claude:** the song's prompt, lyrics and settings, to paste here.
- **Variations:** pick a type, a style, runs, a workspace and a channel.
- **Save:** downloads it to MediaMake.

The Create form gets a bar to pick the channel, **Save as preset**, or press Create several times (**Run ×N**). When the user pastes a "Suno song:" block, its id is the `from` for `suno_cover`.
