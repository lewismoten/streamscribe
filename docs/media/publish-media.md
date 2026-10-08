# publish-media

Makes light copies of recordings for the hub, sends them to the server's private folder, and lists them on the hub. Meetings are private, so only signed-in people who may see meetings can play or download them. On each meeting page they get a player. Agents run the same thing as an `encode` job ([../hub/hub.md](../hub/hub.md), Agents and their work). To share part of a meeting with everyone, publish it as a clip.

```bash
npm run publish-media -- --dry-run      # what it would do
npm run publish-media                    # encode what's new or changed, send it, update the hub
npm run publish-media -- --recording 6   # one recording, by its id in the library database
npm run publish-media -- --no-upload     # encode only
npm run publish-media -- --force         # encode again even if nothing changed
```

It works on the same recordings as `npm run publish-library`, which sends their transcripts, stills and marks; run that first. Both need `recorder.hubUrl` and `recorder.key` in `config.local.js`. Files go up through the hub's API in pieces of up to 4 MB, because shared hosting limits each request. An interrupted upload resumes, and a file the hub already has isn't sent again.

## What it makes

For each part of a recording, in `{part}/published/`:

| File             | Setting                                                                                  | About                 |
| ---------------- | ---------------------------------------------------------------------------------------- | --------------------- |
| `audio.m4a`      | AAC-LC, 48 kbit/s, mono, 44.1 kHz                                                        | 23 MB an hour         |
| `video-360p.mp4` | H.264 High, 640×360, 15 fps, CRF 34, capped at 150 kbit/s, keyframe every 10 s, no sound | 24 MB an hour or less |

So a 4-hour meeting comes to about 180 MB, compared with about 3.6 GB captured.

- **Audio.** Loudness is evened out to −16 LUFS, the podcast norm, in two passes, with rumble below 80 Hz removed. Quiet and loud speakers come out closer together.
- **Timing.** A file's time is the recording's position: moments that weren't captured are silence and black. Transcript times and chapters line up exactly.
- **When files are remade.** Only when the recording's segments or the settings change (`published/manifest.json` records both), or with `--force`.

Encoding a 4-hour meeting takes about 15 minutes on an Apple Silicon Mac, most of it decoding the audio segment by segment. Each segment lands exactly at its position, padded or trimmed by a fraction of a second where its audio or video runs short of its stated length.

## On the hub

- **Where files go.** They land in the hub's private folder, under `recordings/<recording>/<part>/`, named by their content (`audio-<hash>.m4a`). They're served only with a signature (see ../hub/hub.md, Private files). A new encoding gets a new address, and the old file is removed.
- **What the hub records.** Each part gets a `media` record: the paths, sizes, length, title and source.
- **Seeking.** The files have their index at the front, and the server answers byte-range requests. A player jumping around a 4-hour meeting fetches only what it plays.
- **How long video stays.** Video is removed from the hub once a recording is older than `recorder.media.keepVideoDays` (365): the file is deleted and the record says so. Audio and stills stay. The local copies in `published/` are kept.

The settings are under `recorder.media` in `config.local.js`: `height`, `fps`, `crf`, `maxrateKbps`, `audioKbps` and `keepVideoDays`.

## On the website

- **The player.** A meeting with published media shows a player beside the transcript. The audio plays, and the silent video follows it: play, pause, seeking and speed, corrected whenever it drifts.
- **Pictures mode.** It shows the stills changing as the audio plays instead of the video. It's lighter on data, and it's all there is once the video has been removed.
- **Jumping around.** Clicking any transcript, chapter or vote time plays from there, and the line being spoken is highlighted.

## The podcast

The podcast lists published clips, not full meetings: see ../hub/hub.md, Publishing. To list it in Apple Podcasts, Spotify and others, add a cover image and contact email in the hub's `config.php`:

```php
'podcasts' => [
  'warren-county-va' => [
    'title' => 'Warren County Board of Supervisors: clips',
    'description' => 'Clips from public meetings, from an independent archive.',
    'author' => 'Your name',
    'email' => 'you@example.com',
    'image' => 'https://streamscribe.lewismoten.com/hub/media/podcast-cover.jpg',   // square JPEG or PNG, 1400–3000 px
  ],
],
```

Put the cover image in the hub's `media/` folder, because deploys replace the website folder.
