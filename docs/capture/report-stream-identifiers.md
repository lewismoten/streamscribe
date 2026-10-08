# report-stream-identifiers

Script: [`report-stream-identifiers.js`](../../src/sessions/report-stream-identifiers.js)

Command:

```bash
npm run report-stream-identifiers -- [options]
```

Scans every captured `segments.jsonl` manifest for the selected source and groups HLS segment URLs such as `media-uae0o0huw_2184.ts` by their stream identifier (`uae0o0huw`). It reports the first and last local capture time, sequence range, segment count, distinct `t` query values recorded in the manifest, and separate contiguous runs when an identifier changes or a sequence is missing.

The report uses `capturedAt` from the capture manifest. The live recorder does not currently persist HTTP `Date` or `ETag` response headers, so those cannot be reconstructed from already-captured segments.

Options:

- `--source KEY` limits the scan to one configured source
- `--json` prints JSON instead of the text report
- `--output PATH` writes the JSON report to a file (and still prints the text report unless `--json` is also passed)

Examples:

```bash
npm run report-stream-identifiers -- --source warren-county-va
npm run report-stream-identifiers -- --source warren-county-va --output /private/tmp/stream-identifiers.json
```
