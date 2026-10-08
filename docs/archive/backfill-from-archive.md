# backfill-from-archive

Script: [`backfill-from-archive.js`](../../src/archive/backfill-from-archive.js)

Command:

```bash
npm run backfill-from-archive -- --url <archived video page or video link> [--session <folder> ...] [--dry-run]
npm run backfill-from-archive -- --file <archived video file> [--id <name>] [--session <folder> ...] [--dry-run]
```

Fills in what a live capture missed using the archived copy of the same meeting (the official recording), without ever replacing the live capture.

The archive can be a provider's video page (Swagit: `https://<site>.swagit.com/videos/403089`, downloaded through its download link), any direct link to a video file, or a video already on disk (`--file`, linked in without copying when it's on the same drive). It's saved as `{storageDir}/archive/{id}/video.mp4`, where the id is `--id`, the provider's video id, or the file name.

1. **Downloads the archive.** Follows the video page's download link (a signed, one-hour address) and saves the full MP4 to `{storageDir}/archive/{videoId}/video.mp4`. An interrupted download resumes, and an expired address is requested again. Requests go through the usual robots.txt check and rate limit.
2. **Lines it up with each live session** by matching the audio's loudness pattern, at points about every 5 minutes across the session (the first point is searched across the whole archive, then refined to about 10 ms).
3. **Reports where the archive differs from the live capture.** The county sometimes cuts material from the archived copy. Where the live capture runs longer than the archive between two matching points, or a stretch of the capture isn't found in the archive at all, the script prints it and records it under `removedFromArchive`. Because each point has its own offset, a cut doesn't throw off the positions after it.
4. **Cuts what the live capture is missing** (before it started, gaps inside a session, between sessions, after it ended) from the archive without re-encoding, into `{session}/archive-fill/archive-HH-MM-SS-to-HH-MM-SS.mp4` (archive times), with `archive-fill.json` describing the alignment and each range (archive time, video position, approximate time of day).

Without `--session`, it uses every session recorded on the same day in the most recently updated capture. `--dry-run` downloads and aligns but cuts nothing.

To join the live capture and the archive into one complete meeting (one page, transcript, and set of speaker marks), run [`build-meeting`](build-meeting.md), which runs this step first when needed.

Output summary: `{storageDir}/archive/{videoId}/alignment.json` (every session's matching points and offsets, live material the archive lacks, and the missing ranges).

The archive and the live capture use the same encoding (H.264 1280x720 at 29.97 fps, AAC 44.1 kHz), so the cut pieces can be played, transcribed, or joined with the live segments without re-encoding.
