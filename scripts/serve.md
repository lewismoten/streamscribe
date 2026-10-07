# serve

Script: [`serve.js`](serve.js)

Serves each source's folder over `http://localhost`, so the thumbnails page can play video and save marks (browsers block both on `file://`).

## Usage

```bash
npm run serve
npm run serve -- --port 8080
npm run serve -- --root extras=/Volumes/Backup\ Plus/Some\ Folder
```

## What It Serves

- `/{source-key}/` for each configured `sources` entry (its `storageDir`: live captures, full meetings, archive downloads, and people)
- anything added with `--root alias=/path`

The root page at `/` lists every active alias and its filesystem path.

## Options

- `--host 127.0.0.1`
- `--port 4873`
- `--root alias=/absolute/path`

You can repeat `--root` to add more folders.

## Notes

- Directory listings are generated automatically.
- Video files support HTTP range requests, so browser playback and seeking work.
- This is intended for local browsing only.
- Jobs: `POST {session or meeting folder}/retranscribe` (JSON only) starts [`retranscribe-range`](retranscribe-range.md) in the background for the thumbnails page's Boost & re-transcribe and Download clip dialogs (boost previews, waveforms, re-transcription, and clips). The values are checked, and only folders with captured segments are accepted.
- Saving: pages can write back only a few kinds of metadata, with `PUT`: a session's `speakers.json`, `audio-boosts.json`, `meeting-info.json`, `agenda.json`, `votes.json`, and `views.json`, the `people/people.json` roster, and `people/<id>.png` face crops (used by the [thumbnails page](extract-thumbnails.md)'s speaker marking). JSON must parse to an object, images must be PNG, uploads are capped at 8 MB, and files are written atomically. Every other path is refused, and other websites can't write at all, because the server never answers the cross-origin preflight a `PUT` needs.
