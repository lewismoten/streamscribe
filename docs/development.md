# Working on streamscribe

How the repository is laid out, the conventions it keeps, and how to check a change.

## Checking a change

```bash
npm run check          # all of the below, as GitHub Actions runs it (.github/workflows/check.yml)
npm run format         # format with Prettier (npm run format:check only reports)
npm run lint           # Oxlint (with accessibility and React rules) and PHP syntax
npm run typecheck      # TypeScript: the server and the web app
npm test               # unit tests, the hub's API against php -S, the review page's script
npm run test:recorder  # end to end: a simulated meeting recorded, published, and worked on (about 4 minutes)
```

Tests that touch saved data snapshot it first and put it back. Never clear data a person made.

## Conventions

- **Formatting:** Prettier (`.prettierrc.json`), with single quotes, 120 columns, and no trailing commas. PHP isn't formatted by Prettier; keep it like the files around it.
- **Lint:** Oxlint (`.oxlintrc.json`), which includes the jsx-a11y rules. Pages should work by keyboard and with screen readers: give controls accessible names, put captions on media, and use real elements (buttons, `<dialog>`, `<fieldset>`, `<output>`) rather than roles on `div`s.
- **File size:** keep files under about 400 lines. Split by feature when one grows: one page per file, and helpers and components beside it.
- **Comments:** plain sentences. Put one at the top of each module saying what it is for, and add them where the code doesn't say why. Leave out notes about history ("changed from …").
- **No runtime packages outside the web app:** capture, transcription, the recorder, and the server run on Node with ffmpeg and whisper.cpp. React and Vite are for the web app only.

## Layout

```text
bin/                 one entry point per npm command (npm run capture runs bin/capture.js)
src/
  config/            settings (config.local.js), repository paths, the mounted-volume check
  util/              files, processes, command-line options, HTML
  net/               fetching with rate limits and robots.txt
  providers/         streaming services: plain HLS, and swagit/ (discovery, identifiers, standby slides)
  capture/           live capture: discovery, playlists, segments, backfill, sessions, stream identity, signals
  sessions/          a session's segment timeline; splitting and joining sessions
  transcription/     whisper.cpp, transcribe (speech detection, boosts), corrections, combining, re-transcribing
  media/             thumbnails/, clips/, render-mp4/, slides, audio, encoding for the hub (encode.js, publish-media.js)
  archive/           official recordings: download and alignment, full meetings (build-meeting)
  recorder/          the recorder (agent): schedules, recording, live reports, jobs, publishing to the hub
  sync/              shared with the hub and the web app: collections, permissions, recurrence, merging, layers,
                     official sources, the sync client and its stores
  review-page/       the local review page: page.js puts markup.js, styles/, and client/ into each session's
                     thumbnails/index.html
  dev/               the simulated live stream used by the tests (npm run simulate-hls)
server/              the local web server: library database, scan, capture jobs, routes/
web/                 the web app (Vite, React, TypeScript): pages/, and folders by feature (meeting/, agents/,
                     published/, schedules/), data/ (IndexedDB, sync, accounts), styles/
hub-php/             the hub: PHP with SQLite (api.php, lib/, tools/, schema.sql); see hub/hub.md
test/                node --test files; helpers in test/hub/
docs/                how each part works
```

## The review page's script

The review page (`src/review-page/`) is a generated HTML file that also works offline. Its script is the files in `client/` joined, in the order `CLIENT_PARTS` in `page.js` lists. They share one scope: a function declared in one file is used by others and by the page's inline handlers. So:

- **Adding a file:** list it in `CLIENT_PARTS`.
- **Load order:** a top-level `let` or `const` must come before code that reads it when the page loads.
- **The lint exception:** `no-unused-vars` is off for these files, since uses are in other files.
- **The test:** `test/review-page.test.js` checks that every file is listed once, that no name is declared twice, and that the joined script parses.

## Data

```text
data/
  streamscribe.db                    the library: recordings, transcripts, marks, people, capture jobs
  logs/                              logs of captures started from the web app
  <source key>/
    live/<stream>/<YYYY-MM-DD hh-mm-ss>/   one capture session: segments/, transcripts/, thumbnails/, marks,
                                           published/ (light copies for the hub)
    meetings/<date> video-<id>/            full meetings built from a capture and the official archive
    archive/<id>/                          downloaded official recordings and their alignment
    people/                                names, roles, groups, and face photos shared by the source's meetings
  state/                             capture and recorder state, the robots.txt cache
```

The local server serves each source's folder at `/files/<source>/`.
