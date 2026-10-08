# transcript-corrections

Script: [`transcript-corrections.js`](../../src/transcription/transcript-corrections.js)

Command:

```bash
npm run transcript-corrections -- <command> [options]
```

Fixes what Whisper mishears, and rebuilds final transcripts in seconds without re-transcribing.

Transcripts are built in layers, so nothing you fix is lost when they are rebuilt:

1. `transcripts/raw.json`: Whisper's output, untouched.
2. Corrections: `{ "heard as": "should be" }` rules that apply to every transcript, stored in `transcription-corrections.local.json` next to `config.local.js` (git ignores it). The file is a JSON object of `"heard as": "should be"` pairs; the `add` command writes it for you.
3. `transcripts/edits.json`: one-off line edits for a single session.
4. `transcripts/latest.txt`, `.srt`, `.json`: the final transcript, rebuilt from the layers above.

Commands:

- `list` shows every correction.
- `find "phrase"` shows each line where Whisper wrote the phrase, and what it becomes after corrections. Use it to check a correction before adding it.
- `add "heard as" "should be"` adds or changes a correction and rebuilds every transcript.
- `remove "heard as"` removes a correction and rebuilds.
- `edit --at HH:MM:SS "replacement text"` replaces the line nearest that video position, for mistakes a general rule shouldn't touch. `--clear` restores the line.
- `apply` rebuilds every final transcript (after editing the corrections file by hand, for example).

Without `--session`, commands cover every live session with a transcript and every full meeting built by [`build-meeting`](../archive/build-meeting.md). `--session <folder>` limits `find`, `edit`, `add`, `remove`, and `apply` to one session; `edit` otherwise uses the most recently transcribed session.

Corrections match case-insensitively on whole words, longest phrase first. Prefer a phrase over a single word when the word is also ordinary speech (for example `Chandler Valley` rather than `Chandler`).

Typical workflow:

```bash
npm run transcript-corrections -- find "Chando"
npm run transcript-corrections -- add "Chando Shores" "Shenandoah Shores"
npm run transcript-corrections -- edit --at 01:02:46 "Do you mind going next, Sheriff Cline?"
```
