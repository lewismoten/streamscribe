# streamscribe

Capture public meeting livestreams, fill the gaps from the official archive, transcribe them locally with Whisper, and review them on a page with speakers, chapters, votes, audio boosts, a magnifier, and clips. Everything runs on your own machine.

It keeps the whole meeting, including the parts an official archive sometimes leaves out: the live capture is the primary record, and the archived copy only fills what the capture missed.

## Requirements

- Node.js 20 or later (no npm packages)
- [ffmpeg](https://ffmpeg.org) and ffprobe (Homebrew's `ffmpeg-full` includes drawtext for burned-in clocks)
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) (`brew install whisper-cpp`) with a model such as `ggml-large-v3.bin` and the Silero VAD model, in `~/.cache/whisper-cpp/` by default

## Setup

```bash
npm install
cp config.example.js config.local.js
npm run build
npm start
```

Edit `config.local.js` first: add a `sources` entry for each stream (its live `.m3u8` playlist or the pages that lead to it), the transcription context and vocabulary, and tool paths if they aren't on your PATH. `config.example.js` documents every option.

`npm start` opens the library at http://127.0.0.1:4873/ (`-- --port` and `--host` change that).

## The web app

- **Library:** every recording, newest first and grouped by day. That covers live captures, full meetings, and downloaded official recordings, each with its picture, length, and what's been marked (transcript lines, chapters, votes, speaker changes). **▶ Review** opens the review page. **Details** shows the chapters, the votes with their results, the captures a meeting was built from, and the transcript; every time links to that moment on the review page. Captures already joined into a full meeting are hidden unless you ask for them.
- **Search:** finds words in every transcript at once, matching word forms ("budget" also finds "budgets" and "budgeted"); use quotes for an exact phrase. Results are grouped by recording, and each line opens the review page at that moment.
- **Capture:** starts and stops the live capture of each source. Each capture runs as its own process, so restarting the server doesn't interrupt it. A thumbnail watcher keeps the review page current while it records, so you can watch and scrub it live. The page shows the capture's log and its newest recording, and won't start a second capture beside one already running, including one started from a terminal.
- **Review page:** the existing per-recording page, with the player, transcript, speakers, chapters, votes, boosts, clips, and the magnifier. 🏠 returns to the library.

The library is kept in a SQLite database, `data/streamscribe.db`. It holds the recordings and their transcripts (indexed for search), plus everything saved on the review page: speaker marks, chapters, votes, camera views, boosts, meeting names, and each source's people. The server finds new recordings, transcripts, and files changed by the scripts every half minute (**↻ Rescan** does it at once). Each save is also written to its JSON file beside the video, so the command-line scripts keep working with it.

To work on the web app, run `npm run dev` and open http://localhost:5173/: Vite reloads the app as you edit `web/src`, and the server restarts when `server/` changes. `npm run typecheck` checks both.

## A meeting, start to finish

1. **Capture** while it's live: **Start capture** on the Capture page (or `npm run capture`). It recovers the minutes before you started (as far back as the server keeps them) and any gaps from network drops.
2. **Transcribe**, even while still recording: `npm run transcribe`. Fix mishearings once with `npm run transcript-corrections -- add "heard as" "should be"`; they apply to every transcript.
3. **Review** it from the library. Mark speakers, chapters (agenda items), and votes; boost quiet speakers and transcribe them again; magnify whoever is speaking; download clips, with or without the overlays. A capture started outside the app gets its page from `npm run extract-thumbnails` (add `-- --watch` during the meeting to follow it live).
4. **Complete it** once the official recording is posted: `npm run build-meeting -- --url <its page or video link>` (or `--file <video>`). It joins the archive and your capture into one full meeting, carrying your marks over.

## Scripts

| Command | What it does |
| --- | --- |
| `start` | Runs the streamscribe server: the web app, its API, and the data folders |
| `dev` | Runs the server and Vite for working on the web app |
| `build` | Builds the web app into `web/dist` |
| [`capture`](docs/capture/capture.md) | Records live HLS streams segment by segment, recovering earlier and missed segments |
| [`transcribe`](docs/transcription/transcribe.md) | Transcribes a captured session locally with whisper.cpp |
| [`transcribe-media`](docs/transcription/transcribe-media.md) | Transcribes any video or audio file, or part of one |
| [`transcript-corrections`](docs/transcription/transcript-corrections.md) | Manages mishearing corrections and line edits, and rebuilds transcripts |
| [`combine-transcripts`](docs/transcription/combine-transcripts.md) | Combines the usual transcript with a `--best` one, chunk by chunk |
| [`extract-thumbnails`](docs/review/extract-thumbnails.md) | Builds a session's thumbnails, camera changes, and review page |
| [`extract-slides`](docs/media/extract-slides.md) | Saves each presentation slide shown during a session |
| [`extract-clip`](docs/media/extract-clip.md) | Cuts an MP4 clip of a session |
| `render-playlist` | Joins a playlist of clips into one video (used by the review page) |
| [`render-mp4`](docs/media/render-mp4.md) | Stitches a session's segments into one MP4, optionally with a clock |
| [`retranscribe-range`](docs/transcription/retranscribe-range.md) | Boosts the audio of part of a session and transcribes it again (used by the review page) |
| [`split-session`](docs/capture/split-session.md) | Splits a session in two |
| [`join-sessions`](docs/capture/join-sessions.md) | Joins sessions of one meeting into one |
| [`backfill-from-archive`](docs/archive/backfill-from-archive.md) | Downloads the official recording, lines it up with the capture by audio, and cuts out what the capture missed |
| [`build-meeting`](docs/archive/build-meeting.md) | Joins the capture and the archive into one complete meeting |
| [`report-stream-identifiers`](docs/capture/report-stream-identifiers.md) | Reports stream identifier changes in captured sessions |
| [`classify-swagit-standby`](docs/capture/classify-swagit-standby.md) | Finds Swagit standby-slide segments (Swagit sources only) |

## Repository layout

```text
bin/                 one entry point per npm command (npm run capture runs bin/capture.js)
src/
  config/            settings (config.local.js), repository paths, the mounted-volume check
  util/              files, processes, command-line options, HTML
  net/               fetching with rate limits and robots.txt
  providers/         streaming services: plain HLS, and swagit/ (discovery, identifiers, standby slides)
  capture/           live capture: discovery, playlists, segments, backfill, sessions, stream identity, signals
  sessions/          a session's segment timeline; splitting and joining sessions; identifier reports
  transcription/     whisper.cpp, transcribe (speech detection, boosts), corrections, combining, re-transcribing
  media/             thumbnails/ (frames, camera changes, title cards), clips/ (clips, playlists),
                     render-mp4/, slides, audio, text recognition
  archive/           official recordings: download and alignment (backfill-from-archive), full meetings (build-meeting)
  review-page/       the review page: page.js puts markup.js, styles.css, and client/ (its script, by feature)
                     into each session's thumbnails/index.html
server/              the web server: library database, scan, capture jobs, and routes/ (api, files, session jobs, app)
web/                 the web app (Vite, React, TypeScript)
docs/                how each command works, by area
```

## Providers

Any plain HLS stream works. A source's `provider` adds knowledge of a particular streaming service; [Swagit](https://swagit.com), used by many local governments, is built in (finding the live stream from a government's video page, its hourly stream identifier renewals, its standby slide, and downloading its archived meetings). See [capture: Providers](docs/capture/capture.md#providers) and [`scripts/providers`](src/providers/).

## Data layout

```text
data/
  streamscribe.db                            the library: recordings, transcripts, marks, people, capture jobs
  logs/                                      logs of captures started from the web app
  <source key>/
    live/<stream>/<YYYY-MM-DD hh-mm-ss>/   one capture session: segments/, transcripts/, thumbnails/, slides/, marks
    meetings/<date> video-<id>/              full meetings built from a capture and the archive
    archive/<id>/                            downloaded official recordings and their alignment
    people/                                  names, roles, groups, and face photos shared by the source's meetings
  state/                                     capture state and the robots.txt cache
```

The server serves each source's folder at `/files/<source>/`.
