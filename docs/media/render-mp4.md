# render-mp4

Script: [`render-mp4.js`](../../src/media/render-mp4/render-mp4.js)

Command:

```bash
npm run render-mp4 -- [options]
```

Builds a stitched MP4 from previously captured live HLS segments.

The rendered live MP4 is kept separate from any archived video so both versions can be preserved and linked independently.

Input:

- `session.json`
- `segments.jsonl`
- `segments/*`

Output files written into each live capture session directory:

- `YYYY-MM-DD HH-MM-SS {stream-identifier}.mp4`
- `missing-feed-manifest-YYYY-MM-DD HH-MM-SS {stream-identifier}.json`
- `render/YYYY-MM-DD HH-MM-SS {stream-identifier}/concat.txt`
- `render/YYYY-MM-DD HH-MM-SS {stream-identifier}/clips/*.mp4`
- `render/live-capture-{stream-identifier}/gap-text/*.txt`
- `rendered-streams.json`

Behavior:

- Reads captured segments in order
- Splits the render whenever the original HLS segment filename changes from one `media-{stream-identifier}` value to another; each output is dated from its first captured segment, and a repeated identifier later in the same session receives a `-part-N` suffix
- Detects missing-feed gaps from segment sequence numbers: a filler clip appears only where sequence numbers are missing (and weren't deliberately discarded as slides), sized as the number missing times the usual segment length. Download times are not used, because they jitter by several seconds and used to insert filler mid-sentence between consecutive segments. The rendered video's timeline therefore matches the session transcript's timestamps.
- Inserts black filler clips for missing time with an updating on-screen timeline showing:
  - the time the live feed was lost (in `locale.timeZone`)
  - elapsed time since the loss
  - time remaining until the next captured feed
  - the time and rendered timestamp where the feed resumes
  - a progress bar through the missing span
- Writes a JSON manifest of those gaps so a web page can jump directly to the next available captured point
- Re-encodes segment clips into a normalized MP4 format, then concatenates them into the final live MP4. Clips are cached under `render/.../clips/`, named by segment sequence (with `-clock` when the clock is burned in), so re-renders reuse them.

Options:

- `--source KEY` limits rendering to one configured source
- `--video-id ID` limits rendering to one capture ID, including a direct HLS stream ID
- `--gap-threshold-seconds N` controls how large a missing span must be before a filler clip is inserted
- `--burn-wall-clock` overlays a ticking date and time of day in the lower-right corner (for example `Tue Oct 06 2026  03:06:02 PM EDT`): when each frame aired, from the session timeline (correct for backfilled segments too), in `locale.timeZone`
- `--latest-stream-only` renders only the most recent stream-identifier chunk in each matched live session
- `--force` rebuilds outputs even if the stream-specific MP4 already exists

Examples:

```bash
npm run render-mp4
npm run render-mp4 -- --source warren-county-va
npm run render-mp4 -- --source warren-county-va --latest-stream-only
npm run render-mp4 -- --source warren-county-va --video-id 393218 --force
npm run render-mp4 -- --source warren-county-va --burn-wall-clock --force
```

The wall-clock overlay uses the local capture timestamp recorded in `segments.jsonl`; it is not an encoder-supplied broadcast timestamp.
