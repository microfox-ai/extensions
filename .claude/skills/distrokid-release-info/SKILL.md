---
name: distrokid-release-info
description: >-
  Write a DistroKid info.json by talking with the user and reading the release
  folder (audio, a square cover, and a lyrics file that may not be named
  lyrics), write distrokid_lyrics.md from those lyrics, then fill
  distrokid.com/new/ from those folders. Use when the user wants to prepare a
  DistroKid upload, choose a genre, confirm song details, create the info.json
  the Browse Hack DistroKid tab uses, or upload one or many releases.
---

# DistroKid release info

Create `info.json` in the release folder. The Browse Hack popup reads that file, fills the DistroKid upload form, and stops. The user clicks Continue. After that, `useMyOriginals` and `addLyrics` let the extension fill in the Mixea page and the lyrics page in the same tab. The user clicks Continue and Save lyrics there.

Talk to the user. Suggest fields from the folder, then write the file only after they confirm the full draft.

## Find the folder

Ask which folder to use if it is not the current directory. Read it. Expect:

- one or more `.wav`, `.m4a`, or `.mp3` files
- one square cover (`.jpg`, `.jpeg`, `.png`, or `.gif`; DistroKid wants 1000–5000 px)
- `info.json` if a draft already exists
- a lyrics file, often JSON, and often **not** named `lyrics.json`

Skip `__MACOSX`, dotfiles, and `._` files. Treat an existing `info.json` as a draft to confirm, not something to overwrite blindly.

For the lyrics file, use another `.json` whose name contains "lyric" when there is one. Otherwise use the other `.json`. If there is no JSON, use a `.txt`, `.lrc`, or `.md` that looks like lyrics. Leave that source file as it is. The formatted copy is `distrokid_lyrics.md`, written when you write `info.json`. The upload form has no lyrics field. Lyrics go on the lyrics page that DistroKid's Done page links to. Use the source lyric for your suggestions, and use `distrokid_lyrics.md` as the text for that page. Browse Hack saves it there when `addLyrics` is true; otherwise the user pastes it.

If the user shares the audio, listen to it. Otherwise use the lyrics text and the filenames.

## What to suggest

Propose a draft, with a one-line reason for each guess. Ask the user to correct it. Do not write the file until they accept the whole draft.

- **artist** — the name that should appear on the release. Use a name already in the folder or that the user stated. Do not invent a stage name.
- **releaseDate** — `YYYY-MM-DD`. If they have no date, suggest one at least a week ahead and ask them to confirm. Do not pick a date and save it without that confirmation.
- **primaryGenre** — exactly one label from the primary list below.
- **electronicSubGenre** — required when primary or secondary is `Electronic`. Exactly one label from the electronic list. Omit it otherwise.
- **secondaryGenre** — optional. Exactly one label from the secondary list, or omit it. Soundtrack is not a secondary genre.
- **isApplePublish** — ask. `true` keeps Apple Music and iTunes on and requires the four credit fields. `false` turns both stores off and omits those credits.
- **songTitle** — Title Case. Keep a token that is already all-caps and at least two letters, such as `SSJ`. Take a parenthetical from the filename as **version**, not as part of the title.
- **version** — the text DistroKid shows in brackets beside the title, such as `Heavy Bass` or `Radio Edit`. Omit it for the normal version. Do not wrap it in brackets in the JSON.
- **songWriters** — at least one real person: `firstName`, `middleName` (empty string if none), `lastName`, and `credit` of `music`, `lyrics`, or `music and lyrics`.
- **instrumental** — `true` only when the song has no lyrics. If the lyrics file has a real lyric, suggest `false` and ask.
- **isExplicit** — `true` or `false`. `true` checks Explicit lyrics on the DistroKid page for every track in the folder. Suggest `true` when the lyric has profanity, sexual content, or violence. Suggest `false` for a clean lyric, an instrumental, or a Radio Edit. Say why, and let the user change it. If the draft has no `isExplicit`, add `false` unless the lyric or the user already shows that the song is explicit.
- **recordLabel** — the label name stores display. Use the name the user gives. If they do not name one, use `ZONE MUSIC`. If the draft has no `recordLabel`, add `ZONE MUSIC`.
- **creditPerformerRole**, **creditPerformerName**, **creditProducer**, **creditProducerName** — only when `isApplePublish` is true. Read [reference.md](reference.md) and copy a role string exactly. Default `creditPerformerRole` to `Unknown` and `creditProducer` to `Producer`; use another role only when the user asks for one. `creditProducer` is the producer **role**, not the person's name.
- **useMyOriginals** — ask. After the user clicks Continue, DistroKid shows a Mixea page that offers to master the track for a fee. `true` makes Browse Hack pick "Use my originals" ($0) there. The user clicks Continue. `false` leaves that page to the user. Browse Hack never picks a paid option.
- **addLyrics** — ask when the song has a lyric. `true` makes Browse Hack click Add your lyrics on the Done page, paste `distrokid_lyrics.md`, pick the free Basic plan, and tick "I have read and agree to the terms of the DistroKid Lyric Agreement". The user clicks Save lyrics. Say that it ticks that agreement for them. Use `false` for an instrumental or when there is no lyric. On a multi-track release it covers only the track the Done page links to, normally track 1.
- **lyrics** — the formatted lyric that will be saved as `distrokid_lyrics.md`. Read [../distrokid-lyrics/SKILL.md](../distrokid-lyrics/SKILL.md) and follow it. Show that text in the draft. Skip it when the song is instrumental or there is no lyric.

### Names you must not invent

Songwriter, performer, and producer names are legal credits. Suggest one only when the user or the lyrics file already gives that name, and ask them to confirm it. If no name is available, ask. The example below uses placeholders. Never copy those placeholders into a real `info.json`.

A soundtrack primary genre needs the soundtrack type in `version` or the title, for example `Original Motion Picture Soundtrack`. Classical is not delivered to Apple Music and still needs a composer typed on the DistroKid page later. Mention that if you suggest Classical.

K-Pop, J-Pop, French Pop, German Pop, and German Folk force a store language. Mention that when you suggest one of them.

## Write the file

After confirmation, write `info.json` in the release folder. Use this shape and these key names:

```json
{
  "artist": "Example Artist",
  "releaseDate": "2026-11-01",
  "primaryGenre": "Electronic",
  "electronicSubGenre": "Drum & Bass",
  "secondaryGenre": "Hip Hop/Rap",
  "isApplePublish": true,
  "songTitle": "Limit Break",
  "version": "Heavy Bass",
  "songWriters": [
    {
      "firstName": "Given",
      "middleName": "",
      "lastName": "Family",
      "credit": "music and lyrics"
    }
  ],
  "instrumental": false,
  "isExplicit": false,
  "recordLabel": "ZONE MUSIC",
  "useMyOriginals": true,
  "addLyrics": true,
  "creditPerformerRole": "Unknown",
  "creditPerformerName": "Given Family",
  "creditProducer": "Producer",
  "creditProducerName": "Given Family"
}
```

Leave out `electronicSubGenre` when neither genre is Electronic. Leave out `secondaryGenre` and `version` when the user does not want them. Leave out the four credit fields when `isApplePublish` is false. Always include `isExplicit`, `recordLabel`, `useMyOriginals`, and `addLyrics`.

In the same step, write `distrokid_lyrics.md` in that folder from the lyric the user accepted. The file is the lyric lines only. Do not overwrite the original lyrics file. If the song is instrumental, or there is no lyric, do not create `distrokid_lyrics.md`.

Then fill the DistroKid form. Do not click Continue on the release form, and do not submit it.

When the Browse Hack extension is connected, call `distrokid_fill_releases` with the absolute path of each release folder. One parent folder is enough when every child folder has its own `info.json`. The tool opens one https://distrokid.com/new/ tab per release and fills a few at a time. It does not submit. Tell the user which tabs were filled, quote any warnings, and tell them to review each tab and click Continue themselves. When `useMyOriginals` or `addLyrics` is true, tell them the Mixea and lyrics pages are then filled in that tab, and that they click Continue on the Mixea page and Save lyrics.

If that tool says the extension is not connected, or the user wants to fill a single folder from the popup, tell them:

1. Open https://distrokid.com/new/ and log in.
2. Open the Browse Hack popup and choose the DistroKid tab.
3. Choose this folder and click Fill.
4. Read the warnings on the page, fix anything that looks wrong, and click Continue themselves. With `useMyOriginals` or `addLyrics` on, the Mixea and lyrics pages that follow are filled in, and they click Continue and Save lyrics.

## Genre labels

Copy these strings exactly.

**Primary:** Afrobeat, Afropop, Alternative, Big Band, Blues, Children's Music, Christian/Gospel, Classical, Comedy, Contemporary Latin, Country, Dance, Electronic, Fitness & Workout, Folk, French Pop, German Folk, German Pop, Hip Hop/Rap, Holiday, J-Pop, Jazz, K-Pop, Latin, Latin House, Latin Jazz, Latin Urban, Maskandi, Metal, New Age, Pop, Pop in Spanish, Punk, R&B/Soul, Reggae, Rock, Rock en Español, Singer/Songwriter, Soundtrack, Spoken Word, Vocal, World, Xigaza.

**Secondary:** the same list without Soundtrack.

**Electronic subgenre:** Big Room, Breaks, Chill Out, Deep House, Drum & Bass, Dubstep, Electro House, Electronica / Downtempo, Funk / Soul / Disco, Glitch Hop, Hard Dance, Hardcore / Hard Techno, Hip-Hop / R&B, House, Indie Dance / Nu Disco, Minimal / Deep Tech, Progressive House, Psy-Trance, Reggae / Dancehall / Dub, Tech House, Techno, Trance.

Match the suggestion to the lyric and the recording. A heavy bass electronic track is often Electronic plus a subgenre such as Drum & Bass, Dubstep, or Electro House, with Hip Hop/Rap or Rock as a secondary genre only when the lyric or the user supports it. Say why, and let the user change it.
