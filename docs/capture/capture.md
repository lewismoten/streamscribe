# capture

Script: [`capture.js`](../../src/capture/capture.js)

Command:

```bash
npm run capture -- [options]
```

Continuously watches each configured source's live stream and captures every HLS segment to disk as it arrives.

Configuration (`sources` in `config.local.js`):

- `liveUrls`: live HLS playlists (`.m3u8`) to watch, or pages that name one
- `discoveryUrls`: pages to search for the live stream when no playlist is given directly
- `provider`: `hls` (any plain HLS stream, the default) or `swagit`; see [Providers](#providers)
- Optionally `liveStorageDir`; otherwise the script uses `{storageDir}/live`

Captured files are written under:

```text
{liveStorageDir}/{videoId}/YYYY-MM-DD hh-mm-ss/
```

Each live session can include:

- `session.json`
- `video-page.html`
- `playlists/master.m3u8`
- `playlists/latest.m3u8`
- `segments/{sequence}.ts` or the segment's original extension
- `segments.jsonl`
- `discarded-segments.jsonl` when the provider recognizes standby slides (Swagit's silent seal screen)

Behavior:

- Runs continuously until stopped
- Uses a configured playlist directly when it answers; otherwise searches the source's pages for the live stream (with Swagit, its embedded **Watch Live** player)
- Captures new HLS segments only once and appends a timestamped manifest line for each segment
- Uses a short cooldown for HLS requests, while retaining the normal crawl delay for public pages
- Retries timed-out HLS requests and reports concise capture status about every 30 seconds
- On startup, resumes a recent unfinished session for a currently listed video, preserving its segment manifest and reporting the recovered video position, captured time, inferred missing time, and wall-clock restart point
- Reports when a resumed stream is caught up, and completes an already-ended HLS playlist without downloading it as if it were live
- On initial live capture, probes backward from the live playlist and saves any still-available prior segments before following the live edge
- With the Swagit provider, detects the silent standby slide using three resolution-independent frame samples: eight black left-rail/outside-seal points and four non-black seal points. Matching segments are logged to `discarded-segments.jsonl` and removed immediately rather than retained as video.
- Announces when the video transitions to slides and when normal video resumes. The displayed per-stream capture metrics reset at each boundary; intentionally discarded slides do not count as missing capture time or make the live feed stale.
- Writes `silence-boundaries.json` in each session, recording completed and active near-silent periods for later program-boundary review
- Writes `color-bar-transitions.json` when color bars or an abrupt visual source transition is found during a silent period or its beginning/end transition; it checks the current segment and the two preceding segments so a brief test pattern or corrupted transition frame is not missed
- Writes `stream-identity-transitions.json` whenever the stream identifier in segment file names changes (Swagit's `media-{identifier}`, or a plain HLS source's `segmentPattern`); this is recorded as a definite upstream source or encoder transition, independent of silence or image analysis
- Tracks progress per current stream identifier: when that identifier changes, the displayed capture duration, missing time, position, segment count, bytes, and first-capture time reset for the new stream while the session manifest retains the full history
- Keeps per-source state in `state/`
- Cleans up stale `.download` files from prior interrupted runs before monitoring starts
- Marks a session complete after the live listing disappears and no new segments arrive for a while, or when the playlist ends

Options:

- `--source KEY` limits the run to one configured source key
- `--poll-ms N` controls how often live listing pages are checked when nothing is recording
- `--segment-poll-ms N` controls how often active playlists are refreshed
- `--video-page-refresh-ms N` controls how often the stream's page is re-fetched during a live capture
- `--capture-stale-ms N` controls how long to wait without new segments before completing a vanished stream

Examples:

```bash
npm run capture
npm run capture -- --source warren-county-va
npm run capture -- --source warren-county-va --poll-ms 15000 --segment-poll-ms 2000
```

Recovering earlier video:

- A live playlist lists only the newest few segments, but many servers keep earlier ones for a while (Swagit: about 23 more, roughly 4 minutes, measured October 2026). Segment numbers are sequential, so the capture walks backwards from the playlist's first segment, building each earlier segment's name, until the server returns 404. Swagit names are built from its `media-<id>_<n>.ts` pattern; for plain HLS, the trailing number in the file name is changed (keeping zero padding), and servers that name segments differently simply return 404.
- **Startup backfill:** when a session starts mid-meeting, it recovers the earlier segments still on the server (up to 90).
- **Gap backfill:** after an interruption (a restart or a network drop), it recovers the segments between the last one captured and the playlist, as far back as the server still has them. Stops shorter than about 4 minutes lose nothing.
- Anything older than the server's window is gone from the live stream; the archived meeting video is the only other source.

Segment identifiers and sessions:

- Swagit names segment files `media-<identifier>_<sequence>.ts` and renews the identifier about hourly (the moments a browser player tends to freeze) and skips one sequence number when it does. The server serves any sequence number under any identifier, so the skipped segment is recovered by the gap backfill.
- One meeting, one session folder. Identifier changes are only logged (`stream-identity-transitions.json`), since the renewal runs on a timer and lands mid-meeting. A new session starts when the stream comes back from the standby slide after at least `newSessionAfterStandbyMinutes` (10 by default): the old session is marked complete, and the sessions link through `previousSessionDir` / `nextSessionDir` (with `endedByStandby` / `startedAfterStandby` saying when standby ran). No folder is made for standby alone. A recess or closed session doesn't split the meeting: boards show their own title card for that (such as "Executive Session"), which is kept.
- `splitOnStreamIdentifierChange: true` brings back the old behavior of a new session at every identifier change (the old session first recovers any segments up to the change).

Request rate:

- Playlist polls and live segments use the `liveMedia` rate profile (default: one request a second, bursts of three).
- The startup backfill of earlier segments uses `liveBackfill` (default: two requests a second).
- Both can be changed under `http.profiles` in `config.local.js`. robots.txt is checked first, like every request.

## Providers

A source's `provider` adds what is specific to its streaming service ([`src/providers`](../../src/providers/)):

- **`hls`** (default): any plain HLS live stream. A configured `.m3u8` is captured directly; a page in `liveUrls` or `discoveryUrls` is searched for a playlist address. Earlier and missed segments are fetched by changing the trailing number in segment file names. Add `segmentPattern` (a regular expression whose first group is the stream identifier and second the sequence number) to track identifier changes.
- **`swagit`**: [Swagit](https://swagit.com), used by many local governments. Follows the government's video pages to Swagit's live player, tracks its hourly stream-identifier renewals, recovers segments by Swagit's naming, discards its silent standby slide, and downloads archived meetings for [`backfill-from-archive`](../archive/backfill-from-archive.md). Sources with Swagit addresses use it automatically.

Supporting another service means adding a provider beside `src/providers/swagit/` (or the plain `hls.js`) with the same functions, and naming it in `src/providers/index.js`.
