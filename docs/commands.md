# Commands

Each command is `npm run <command>` (add options after `--`, as in `npm run capture -- --help`). Each runs `bin/<command>.js`.

| Command                                                             | What it does                                                                                                  |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `start`                                                             | Runs the streamscribe server: the web app, its API, and the data folders                                      |
| `dev`                                                               | Runs the server and Vite for working on the web app                                                           |
| `build`                                                             | Builds the web app into `web/dist`                                                                            |
| [`capture`](capture/capture.md)                                     | Records live HLS streams segment by segment, recovering earlier and missed segments                           |
| [`transcribe`](transcription/transcribe.md)                         | Transcribes a captured session locally with whisper.cpp                                                       |
| [`transcribe-media`](transcription/transcribe-media.md)             | Transcribes any video or audio file, or part of one                                                           |
| [`transcript-corrections`](transcription/transcript-corrections.md) | Manages mishearing corrections and line edits, and rebuilds transcripts                                       |
| [`combine-transcripts`](transcription/combine-transcripts.md)       | Combines the usual transcript with a `--best` one, chunk by chunk                                             |
| [`extract-thumbnails`](review/extract-thumbnails.md)                | Builds a session's thumbnails, camera changes, and review page                                                |
| [`extract-slides`](media/extract-slides.md)                         | Saves each presentation slide shown during a session                                                          |
| [`extract-clip`](media/extract-clip.md)                             | Cuts an MP4 clip of a session                                                                                 |
| `render-playlist`                                                   | Joins a playlist of clips into one video (used by the review page)                                            |
| [`render-mp4`](media/render-mp4.md)                                 | Stitches a session's segments into one MP4, optionally with a clock                                           |
| `publish-library`                                                   | Sends recordings in the library (details, transcripts, stills, marks) to the hub (hub/deploy.md)              |
| [`publish-media`](media/publish-media.md)                           | Makes light audio (also the podcast) and silent 360p video of recordings, and puts them on the hub            |
| `deploy:hub`                                                        | Puts the hub and the web app on your server over SSH (hub/deploy.md)                                          |
| [`retranscribe-range`](transcription/retranscribe-range.md)         | Boosts the audio of part of a session and transcribes it again (used by the review page)                      |
| [`split-session`](capture/split-session.md)                         | Splits a session in two                                                                                       |
| [`join-sessions`](capture/join-sessions.md)                         | Joins sessions of one meeting into one                                                                        |
| [`backfill-from-archive`](archive/backfill-from-archive.md)         | Downloads the official recording, lines it up with the capture by audio, and cuts out what the capture missed |
| [`build-meeting`](archive/build-meeting.md)                         | Joins the capture and the archive into one complete meeting                                                   |
| [`report-stream-identifiers`](capture/report-stream-identifiers.md) | Reports stream identifier changes in captured sessions                                                        |
| [`classify-swagit-standby`](capture/classify-swagit-standby.md)     | Finds Swagit standby-slide segments (Swagit sources only)                                                     |
| `simulate-hls`                                                      | Serves a saved session as a simulated live stream, for testing                                                |
| [`recorder`](recorder/recorder.md)                                  | Runs the recorder (agent): records scheduled meetings, does work from the hub's queue                         |
| `hub:dev`                                                           | Runs the hub locally with `php -S` (its database in `hub-php/data/`)                                          |
| `check`, `lint`, `format`, `typecheck`, `test`, `test:recorder`     | Checking a change (see [development.md](development.md))                                                      |
