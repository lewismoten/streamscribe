# streamscribe

Capture public meeting livestreams, fill the gaps from the official archive, transcribe them locally with Whisper, and review them on a page with speakers, chapters, votes, audio boosts, a magnifier, and clips. Everything runs on your own machine.

It keeps the whole meeting, including the parts an official archive sometimes leaves out: the live capture is the primary record, and the archived copy only fills what the capture missed.

## Requirements

- Node.js 20 or later (no npm packages)
- [ffmpeg](https://ffmpeg.org) and ffprobe (Homebrew's `ffmpeg-full` includes drawtext for burned-in clocks)
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`brew install whisper-cpp`) with a model such as `ggml-large-v3.bin` and the Silero VAD model, in `~/.cache/whisper-cpp/` by default

## Setup

```bash
cp config.example.js config.local.js
```

Edit `config.local.js`: add a `sources` entry for each stream (its live `.m3u8` playlist or the pages that lead to it), the transcription context and vocabulary, and tool paths if they aren't on your PATH. `config.example.js` documents every option.

## A meeting, start to finish

1. **Capture** while it's live: `npm run capture`. It recovers the minutes before you started (as far back as the server keeps them) and any gaps from network drops.
2. **Transcribe**, even while still recording: `npm run transcribe`. Fix mishearings once with `npm run transcript-corrections -- add "heard as" "should be"`; they apply to every transcript.
3. **Review** on the thumbnails page: `npm run extract-thumbnails`, then `npm run serve` and open the address it prints. Mark speakers, chapters (agenda items), and votes; boost quiet speakers and transcribe them again; magnify whoever is speaking; download clips, with or without the overlays.
4. **Complete it** once the official recording is posted: `npm run build-meeting -- --url <its page or video link>` (or `--file <video>`). It joins the archive and your capture into one full meeting, carrying your marks over.

## Scripts

| Command | What it does |
| --- | --- |
| [`capture`](scripts/capture.md) | Records live HLS streams segment by segment, recovering earlier and missed segments |
| [`transcribe`](scripts/transcribe.md) | Transcribes a captured session locally with whisper.cpp |
| [`transcribe-media`](scripts/transcribe-media.md) | Transcribes any video or audio file, or part of one |
| [`transcript-corrections`](scripts/transcript-corrections.md) | Manages mishearing corrections and line edits, and rebuilds transcripts |
| [`extract-thumbnails`](scripts/extract-thumbnails.md) | Builds a session's thumbnails, camera changes, and review page |
| [`serve`](scripts/serve.md) | Serves the data folders locally so the review page can play video and save marks |
| [`extract-slides`](scripts/extract-slides.md) | Saves each presentation slide shown during a session |
| [`extract-clip`](scripts/extract-clip.md) | Cuts an MP4 clip of a session |
| [`render-mp4`](scripts/render-mp4.md) | Stitches a session's segments into one MP4, optionally with a clock |
| [`retranscribe-range`](scripts/retranscribe-range.md) | Boosts the audio of part of a session and transcribes it again (used by the review page) |
| [`split-session`](scripts/split-session.md) | Splits a session in two |
| [`backfill-from-archive`](scripts/backfill-from-archive.md) | Downloads the official recording, lines it up with the capture by audio, and cuts out what the capture missed |
| [`build-meeting`](scripts/build-meeting.md) | Joins the capture and the archive into one complete meeting |
| [`report-stream-identifiers`](scripts/report-stream-identifiers.md) | Reports stream identifier changes in captured sessions |
| [`classify-swagit-standby`](scripts/providers/swagit/classify-standby-slides.md) | Finds Swagit standby-slide segments (Swagit sources only) |

## Providers

Any plain HLS stream works. A source's `provider` adds knowledge of a particular streaming service; [Swagit](https://swagit.com), used by many local governments, is built in (finding the live stream from a government's video page, its hourly stream identifier renewals, its standby slide, and downloading its archived meetings). See [capture: Providers](scripts/capture.md#providers) and [`scripts/providers`](scripts/providers/).

## Data layout

```text
data/
  <source key>/
    live/<stream>/<YYYY-MM-DD hh-mm-ss>/   one capture session: segments/, transcripts/, thumbnails/, slides/, marks
    meetings/<date> video-<id>/              full meetings built from a capture and the archive
    archive/<id>/                            downloaded official recordings and their alignment
    people/                                  names, roles, groups, and face photos shared by the source's meetings
  state/                                     capture state and the robots.txt cache
```

Speaker marks, chapters, votes, boosts, zoom areas, and meeting names are small JSON files beside each session's video, saved by the review page through `npm run serve`.
