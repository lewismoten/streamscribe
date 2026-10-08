# extract-slides

Script: [`extract-slides.js`](../../src/media/extract-slides.js)

Command:

```bash
npm run extract-slides -- [--session <folder>] [options]
```

Finds the presentation slides shown during a captured live session and saves each one as an image.

A slide is a still digital image, so its frames stay identical for seconds at a time, while camera video always has some motion and compression noise. The script scans the video with ffmpeg's `freezedetect` filter in parts of about 10 minutes, several at once, decoding only keyframes (about one a second), so a 3-hour meeting takes well under a minute. Each still is handled the moment it is detected, while scanning continues: it is fingerprinted and either saved as a new slide or recorded as another showing of a slide already saved.

The fingerprint has two parts. Slide templates usually repeat the same header, footer, and side bands, so it samples the whole frame on a coarse 16x16 grid (256 points) and the center, inside a 20% border, on a dense 24x24 grid (576 points), recording whether each point is brighter than its neighbor. A still counts as an already-saved slide only when both parts match.

Re-running picks up where the last run stopped: parts already scanned are skipped (a recording that grew gets its new parts scanned), and slides already saved are recognized by their fingerprints instead of being saved again.

Output goes to `{session}/slides/`:

- `slide-HH-MM-SS.png`, one per distinct slide, named by the video position it was captured from
- `slides.json`: every slide (numbered in time order), each time it was shown (video position matching the transcript, approximate time of day, duration, segment sequence), and its fingerprint
- `index.html`: a contact sheet to browse the slides with their times
- `slides.log`: a timestamped log of parts scanned, stills detected, slides saved, and repeats recognized
- `progress.json`: which parts have been scanned

Options:

- `--session <folder>` (default: the most recently updated capture)
- `--min-seconds 4`: how long an image must stay still to count as a slide
- `--noise -60`: how much frame-to-frame change (in dB) still counts as still; raise it (for example `-50`) if slides are missed, lower it if still camera shots are picked up
- `--match-distance 16`: how many of the 256 whole-frame points may differ for two stills to count as the same slide
- `--center-match-distance 36`: how many of the 576 center points may differ
- `--border 0.2`: the fraction trimmed from each edge before the dense center grid

Lower the distances if different slides are merged; raise them if a re-shown slide is saved twice.

Changing a detection option (`--min-seconds`, `--noise`, or the match settings) scans every part again; saved slides are kept. `split-session` divides an existing `slides/` folder between the two sessions, so it can run before or after a split.
