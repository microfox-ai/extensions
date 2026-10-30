---
name: create-distrokid-lyrics
description: >-
  Rewrite song lyrics into DistroKid's lyric format: capitalize each line, one
  sentence per line, blank lines between verses and choruses, repeats written
  out in full, no section labels, no social links, no punctuation at the end
  of a line, and no censoring unless the word was bleeped. Use when the user
  gives lyrics to format for DistroKid, asks for DistroKid lyrics, or a release
  folder needs distrokid_lyrics.md. pack-distrokid runs this step when it packs
  a release.
---

# Create DistroKid lyrics

Turn the lyrics you are given into text that can be pasted into DistroKid. Change formatting only. Do not rewrite, translate, or "improve" the words.

Read the lyric from the user's message, or from the release folder's lyrics file (`.json`, `.txt`, `.lrc`, or `.md`, often not named `lyrics`). Leave that source file as it is.

## How to format lyrics

Do

Begin each line with a capital letter

Enter only one sentence per line

Include blank lines between verses and chorus

Write out repeated lines in full

Don't write "Chorus 2x" etc.

Avoid

Social media links

Punctuation at the end of lines

Vocalist's name or section labels

Example: "intro", "chorus", artist name etc

Censoring explicit words unless they were dropped/bleeped in the recording

Don't enter "F***", unless the word was dropped or bleeped

## Apply the rules

1. Take the lyric text out of JSON, LRC timestamps (`[00:12.34]`), and HTML. Ignore keys that are not the lyric.
2. Delete section labels and singer labels, then keep a blank line where a new verse or chorus started. Labels include intro, verse, pre-chorus, chorus, hook, bridge, outro, refrain, drop, breakdown, interlude, and an artist name used as a header. That covers `[Chorus]`, `(Verse 1)`, `Chorus:`, and a line that is only the vocalist's name. A `Name:` prefix that only marks who sings comes off. A name that is part of the sentence stays.
3. A repeat note (`Chorus 2x`, `x2`, `(repeat)`, `repeat chorus`) means that section is heard that many times. Write the section's lines that many times, then delete the note. If every repeat is already written in full, delete only the note. Put the copies one after another with no extra blank line inside the repeated section.
4. Split a line that contains more than one sentence. A sentence ends at `.` `!` or `?`.
5. Remove punctuation at the end of a line (`.` `,` `!` `?` `;` `:` `…` and a closing quote that only wraps the line). Keep apostrophes, hyphens, and punctuation inside the line.
6. Capitalize the first letter of each line. Leave the rest of the line as written.
7. Delete URLs, `@handles`, and a line that is only a social link or a "follow me" call.
8. Spell explicit words. If the source hides a word with asterisks (`F***`, `f*ck`), write the word. Keep the censor only when the user says that word was dropped or bleeped in the recording. If you cannot tell, ask before leaving asterisks in.
9. One blank line between verses, and between a verse and a chorus. Do not add a title, a heading, or a label to the result.

## Show the result

Show the formatted lyric. If the user named a release folder, or you are writing that folder's `info.json`, also write `distrokid_lyrics.md` in that folder containing only the formatted lyric. If they pasted lyrics and named no folder, show the lyric and do not create a file until they say where.

If there is no lyric, or the song is instrumental, do not write `distrokid_lyrics.md`.

When `info.json` sets `addLyrics`, Browse Hack pastes this file on DistroKid's lyrics page after the upload. So the file holds the lyric and nothing else.

## Example

Source:

```
[Verse 1]
i walk the street. the night is mine
follow me https://instagram.com/artist

[Chorus]
we run it
Chorus 2x

Artist:
what the f***
```

`distrokid_lyrics.md`:

```
I walk the street
The night is mine

We run it
We run it

What the fuck
```
