# classify-swagit-standby

Script: [`classify-standby-slides.js`](classify-standby-slides.js) (Swagit sources only)

Command:

```bash
npm run classify-swagit-standby -- [options]
```

Classifies silent post-meeting slide segments that are candidates for discarding. By default it reports only and never deletes files.

The scanner is deliberately conservative. A segment is reported only when all of these conditions hold:

- Audio is digital silence (at or below `-90 dB`), not merely quiet. The current encoder represents silence as approximately `-91 dB` rather than `-inf dB`.
- A visual slide signature appears at the start, middle, and end: eight resolution-relative points in the left rail and immediately outside the seal are black, while four points inside the seal are non-black. This recognizes the persistent black rail and either the County or Town seal without depending on the slide's text or clock.

The signature needs only three decoded, downscaled frames and no OCR. The report is not a deletion instruction; review candidates before introducing any automatic cleanup.

To reduce scan time, the scanner classifies sequential items in blocks of 11. It inspects the first and last item in a block. If their keep/drop status matches, it infers that status for the interior items. If they differ, it inspects the middle item and recursively narrows the boundary. The JSON log marks each inferred finding with `"inferred": true`.

Each run writes the complete findings—both `drop` candidates and `keep` results—to `{liveStorageDir}/slide-classification-findings.json` by default. The console prints only compact contiguous file ranges and their UTC capture-time span.

Options:

- `--source KEY` limits scanning to one configured source
- `--file-name NAME` limits scanning to a captured filename; repeat for more than one filename
- `--concurrency N` runs up to `N` FFmpeg/Tesseract analyses at once (default: `2`; use `3` or `4` only if the capture drive keeps up)
- `--output PATH` writes JSON results to a file
- `--json` prints JSON instead of the text report
- `--discard` permanently deletes files classified as discard candidates after recording them in the JSON report and that session's `discarded-segments.jsonl`, so renders omit them without adding a lost-feed gap

Examples:

```bash
npm run classify-swagit-standby -- --source warren-county-va
npm run classify-swagit-standby -- --source warren-county-va --file-name 001751.ts --file-name 001635.ts
npm run classify-swagit-standby -- --source warren-county-va --discard
```
