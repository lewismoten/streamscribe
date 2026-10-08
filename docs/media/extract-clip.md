# extract-clip

Script: [`extract-clip.js`](../../src/media/clips/extract-clip.js)

Command:

```bash
npm run extract-clip -- --session <folder> --from HH:MM:SS --to HH:MM:SS [--output <file.mp4>] [--accurate]
```

Cuts an MP4 clip of a captured live session between two video positions: the times shown in transcripts, on the slides page, and on the thumbnails page. The thumbnails page (`thumbnails/index.html`) builds this command for you: click a thumbnail for the start and another for the end, then copy the command.

By default the video and audio are copied without re-encoding, so even long clips take seconds (2 minutes of video in under a second); cuts land on the nearest keyframe, within about a second. `--accurate` re-encodes for frame-exact cuts, which takes longer. In a full meeting from [`build-meeting`](../archive/build-meeting.md), a clip can cross from the archive into the live capture (or back); each stretch is cut on its own and the cuts are joined.

Output goes to `{session}/clips/clip-HH-MM-SS-to-HH-MM-SS.mp4` unless `--output` names a file. Moments inside the range that were missed or discarded during capture are left out, and the script says how much shorter the clip is because of them.
