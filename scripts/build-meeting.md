# build-meeting

Script: [`build-meeting.js`](build-meeting.js)

Command:

```bash
npm run build-meeting -- --url <archived video page or video link> [options]
npm run build-meeting -- --file <archived video file> [--id <name>] [options]
```

Builds the complete meeting from your live capture plus the archived copy (the official recording), as one folder with one thumbnails page, transcript, and set of speaker marks. This is the step to run after a meeting once the county posts the archived video. One command does everything:

1. **Downloads and lines up the archive** by running [`backfill-from-archive`](backfill-from-archive.md), unless that has already been done for this video. Use `--realign` to redo it, for example after adding sessions.
2. **Joins the pieces in airing order:**
   - the archive before your capture started
   - each live session
   - the archive wherever the capture missed something, such as the ~45 seconds lost each time a Swagit stream renews its identifier
   - the archive after your capture ended

   The live capture is used wherever it exists, so anything the county cut from the archive (a recess, for example) stays in. Live segments are hard-linked, so they take no extra disk space. Archive pieces are cut into 10-second segments without re-encoding, which takes seconds. The first segment after each stream renewal carries a few stray audio packets stamped long before its video. The meeting uses a cleaned copy of that segment, and the captured original is left alone.
3. **Carries over your speaker marks, agenda items, votes, and transcript edits** from the sessions, moved to the meeting's timeline. Agenda items come in the same way as speaker marks: on every build until you add or change one on the meeting's page.
   - Until you mark speakers on the meeting's own page, every rebuild picks up the sessions' latest marks.
   - After that, the meeting's marks are kept, and `--reimport-speakers` replaces them with the sessions' marks.
   - If a rebuild changes the timeline, the meeting's marks and edits move with it.
4. **Merges the transcripts.**
   - Live stretches use the sessions' Whisper output.
   - Archive stretches reuse any [`transcribe-media`](transcribe-media.md) output for the archive video, thorough preferred over quick.
   - Anything not yet transcribed is transcribed with whisper.cpp. The page is built before this step, so it is usable right away and gets the text when transcription finishes.
   - Corrections apply as usual: `npm run transcript-corrections` rebuilds meetings too.
5. **Builds the thumbnails page** for the meeting, with camera and slide changes. Each session's thumbnails page gets a link to it.

Output goes to `{storageDir}/meetings/{date} video-{id}/`:

- `meeting.json`: where each stretch of the meeting comes from (`pieces`: live session and positions, or archive times), with its meeting start and length
- `segments/`, `segments.jsonl`, `playback.m3u8`: the joined video, laid out like a live session, so `extract-slides`, `extract-clip`, and `extract-thumbnails` all accept `--session <meeting folder>`
- `speakers.json`, `transcripts/` (`raw.json`, `edits.json`, `latest.*`, and `pieces/` for archive transcriptions), `thumbnails/`
- `archive-pieces/`, `cleaned/`: the archive cuts and cleaned segments, reused by later builds

Open the page through `npm start` (the build prints its path).

Options:

- `--url <archived video page or link>` or `--file <video file>`: required the first time (see [`backfill-from-archive`](backfill-from-archive.md)); afterwards `--video-id <id>` is enough
- `--session <folder>` (repeatable): sessions to line up, when running the archive step (default: every session recorded that day)
- `--quality thorough|quick`: for transcribing archive stretches (default thorough)
- `--no-transcribe`: build everything but leave untranscribed archive stretches for a later run
- `--realign`: download and line up the archive again
- `--reimport-speakers`: replace the meeting's speaker marks with the sessions'
- `--output <folder>`: another meeting folder

Typical meeting:

1. `npm run capture` during the meeting.
2. Optionally transcribe and mark speakers on the session pages while you wait for the county's archive.
3. Once the archive is posted, run `npm run build-meeting -- --url <its video page>`.

Positions on the meeting page are meeting positions. They match the meeting's transcript and clips, not the session pages, and there's no way back from meeting positions to session positions.
