---
name: suno-songs
description: Make songs, covers and variations on Suno for a MediaMake channel through the Browse Hack browser extension, record every take in MediaMake cloud, run big batches only in whole sets the credits can pay for, and download nothing unless the user approves those songs. Use when the user asks to "make a song on Suno", "generate songs / tracks", "cover this song", "make variations / versions of this Suno song", "extend this song", "an instrumental version", "run these prompts on Suno", "run this prompt library / these sections on Suno", pastes a "Suno song:" block copied with Browse Hack's Copy for Claude button, or wants a channel's past Suno prompts and keepers.
---

# Suno songs through Browse Hack

Browse Hack drives Suno in the user's own Chrome: it fills Suno's Create form and clicks Create in a background "Browse Hack" Suno tab, so Suno runs every check it normally does. Each take is recorded in MediaMake cloud under the channel's project, where the whole team can search it (`suno_list_generations`). The user listens on suno.com; nothing is downloaded unless they approve those songs, which then go into MediaMake's media library inbox, ready for `media ingest`.

## Before you start

- The `browse-hack` MCP tools must be available. If a tool says the extension isn't connected, call `get_status`. If it's connected in several Chrome profiles, ask the user which one by Google account email (the one signed in to Suno), then `use_profile`.
- Call `suno_status` first. It shows the plan, the **credits** and the **downloads left this month**, the models (`v6`, `v6-wild`, `v6-mini`), and each MediaMake channel with its linked Suno workspace and MediaMake project. Links are made in the Browse Hack popup's Suno tab. If the channel the user means has no workspace or project yet, tell them where to link it. The tools still work without the links.
- Credits: every Create makes two songs and spends credits (10 credits a Create on v6, Premier, measured 2026-11-11; read `creditsLeft` in `suno_status` before and after the first Create to know the real price). Say what a request will cost in runs and credits ("3 runs = 6 songs = 30 credits") and get a yes before more than two or three runs, or before any batch.
- **Downloads: none.** Every job runs with `download: "none"`. Never call `suno_download`, `suno_rate` with `download: true`, or a batch with `download: "all"` or `"keepers"`, unless the user has approved downloading those specific songs. Downloads are metered by Suno (60 a month on Premier) and the user listens on suno.com first. Check a take with `suno_get_songs` (metadata only), never by downloading it.

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
4. **Many songs** go through `suno_batch_start` (a folder, the jobs, the `channel`), agreed with the user first. Check on it with `suno_batch_status` (`waitMs` waits). For more than a handful, follow **Big batches** below.

## Big batches

For a prompt library, an album's worth of takes, or anything over ~20 Creates.

1. **Split it into sets** the user would name: sections, albums, one artist's prompts. One batch folder and one jobs file per set (`suno_batch_start` with `jobsFile`).
2. **Whole sets only.** Work out the cost before starting: jobs × credits per Create. Run only the sets the credits pay for in full, one after another, and never start a set the credits can't finish. Leave the next set for later rather than half-running it. When the user gives a budget ("I only have 3,840 credits"), plan to it: 1,000-credit sets on 3,840 credits means three sets, about 840 left over.
3. **One test Create first:** a batch of the set's first job alone, in the set's folder. Check both takes with `suno_get_songs` (model, `instrumental`, workspace, title, settings) and the credit drop. Then start the batch again on the same folder with the whole jobs file; it skips the job that is done.
4. **One model per batch.** Mixed models in one batch can land on the wrong one. Run a second model as its own batch.
5. **Keep the session open.** The batch runs inside this session's MCP server; if the session ends, start it again on the same folder to resume. Run sets one at a time: there is one Suno tab.
6. **Pausing:** when the user says pause, `suno_batch_pause` at once. The songs already in Suno finish and are recorded, then it stops. Say how far the set got and what is left. To resume, start the batch again on the same folder.
7. **Checking a set without reading every song:** `run.log` in the batch folder has one `done … model <m> confirmed` line per job; count them and the clip ids in `state.json`, then read a few songs across the set with `suno_get_songs`. A `the model menu isn't on the form` line is harmless when the job's `done` line confirms the model.
8. **Report at the end:** a table of the sets (jobs done of total, takes, failed, complete or not), the credits at the start, used and left, what the next set would cost, and anything odd (for example the download counter moving when this run downloaded nothing).

## While it runs

- The tools wait for the songs (about 1-3 minutes) unless `wait: false`. `suno_get_songs` checks songs by id.
- **A captcha:** if Suno shows one, the Browse Hack Suno tab comes to the front and the tool waits. Tell the user to clear it in that tab. Never try to solve or get around it.
- **Uploads:** an upload may stop at Suno's terms ("you have the rights"). The user ticks them in the tab, unless they turned on "I own or license the audio I cover" in Browse Hack's Suno tab.

## After

1. Give the user the song links and ask which to keep.
2. Rate the takes with `suno_rate`: `keeper`, `maybe` or `reject`, with a `note` on what was wrong. Leave `download` off.
3. Only when the user approves downloading specific songs: `suno_download` those ids (or `suno_rate` with `download: true`). Files go to `_INBOX/suno/<channel>/<set>/<Title> [<id>].mp3`, with a `.source.json` holding the styles, lyrics, model, settings and parent. Then file them in the mediamake repo with `mm media ingest`; they land in `music/<channel>/<song>/`.
4. Save a style the user liked with `suno_save_preset`, for the channel's team and the Variations button on suno.com.

## On suno.com

The user can do the same without Claude. Hovering a song shows:
- **Copy for Claude:** the song's prompt, lyrics and settings, to paste here.
- **Variations:** pick a type, a style, runs, a workspace and a channel.
- **Save:** downloads it to MediaMake.

The Create form gets a bar to pick the channel, **Save as preset**, or press Create several times (**Run ×N**). When the user pastes a "Suno song:" block, its id is the `from` for `suno_cover`.

## Lessons

- 2026-11-11 · ZONE instrumentals (1,000 prompts in 10 sections of 100) · "I only have 3840 credits, only do until sections is completed and leave the next section, I don't want incomplete sections; a clear report on how many sections are done and what's the credit left" → whole sets only, planned to the budget, with a set-by-set report and credits left (Big batches 2 and 8).
- 2026-11-11 · same run · "do not do any downloads, never download Suno songs, only very rarely is it acceptable, that also with specific human approval" → `download: "none"` on every job; no `suno_download` without approval for those songs (Before you start, After 3).
- 2026-11-11 · same run · the user said "pause" with a set at 95/100 → pause at once, report what is left, resume the same folder when they say so (Big batches 6). A v6 Create cost 10 credits; 300 Creates ran with no failures at about 1.7 Creates a minute (concurrency 2).
