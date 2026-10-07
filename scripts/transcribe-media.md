# transcribe-media

Script: [`transcribe-media.js`](transcribe-media.js)

Command:

```bash
npm run transcribe-media -- --input <file> [--from HH:MM:SS --to HH:MM:SS] [--quality quick|thorough] [--output-dir <folder>]
```

Transcribes any video or audio file, or a time range of it, locally with whisper.cpp: for example an archived meeting MP4 downloaded by [`backfill-from-archive`](backfill-from-archive.md), or the pieces it cuts into a session's `archive-fill/` folder.

Quality:

- `quick`: greedy decoding (one candidate per step), about 2-3 times faster, slightly less accurate on difficult audio. Good for a first look.
- `thorough` (default): beam search over 5 candidates, the same settings as `transcribe`.

Both transcribe in 10-minute chunks, retry a chunk that loops on one phrase at a higher temperature, skip silence with voice activity detection, and apply the transcript corrections file.

Timestamps follow the input file's own timeline: with `--from 21:02`, the first line is stamped at about 21:02, matching the same moment in the file.

Output goes to `{input folder}/transcripts/` (or `--output-dir`): `{name}[-HH-MM-SS-to-HH-MM-SS]-{quality}.txt`, `.srt`, and `.json`.

Example:

```bash
npm run transcribe-media -- --input data/warren-county-va/archive/403089/video.mp4 --from 21:02 --to 33:26 --quality quick
```
