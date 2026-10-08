# The hub

The hub is a small PHP API with a SQLite database (`hub-php/`). Recorders report to it: what they're recording, live thumbnails and quick transcripts, then the final transcript and stills. The web app syncs with it, whether it's served by a recorder or hosted as a static site such as GitHub Pages. Video stays on the recorders.

## Install on shared hosting

You need PHP 8 with `pdo_sqlite`, which most hosts have, and HTTPS.

1. Upload the `hub-php/` folder, for example as `https://example.com/streamscribe/`.
2. Copy `config.example.php` to `config.php` and edit it:
   - `allowed_origins`: the web addresses allowed to call the hub from a browser, such as `https://your-name.github.io`.
   - `database` and `media_dir`: where the SQLite file and uploaded pictures go. Keep the database outside the web root if your host allows it. Otherwise the included `.htaccess` blocks `data/` from the web.
   - `keys`: one line per editor and per recorder. Make each one with:

     ```bash
     php tools/new-key.php editor "Your name"
     php tools/new-key.php recorder "Office Mac"
     ```

     Each run prints the key once, to give to that person or recorder, and the line to paste into `config.php`. The hub stores only the key's hash.
3. Open `https://example.com/streamscribe/api.php/info`. It should answer with the hub's name and `"rev": 0`.

Your recorders and the web app use `https://example.com/streamscribe/api.php` as the hub address. It works without URL rewriting: routes are `api.php/changes`, `api.php/records`, and so on, or `api.php?r=changes` where a host doesn't pass the path through.

## What's stored

Every record is `{ collection, id, data, rev, updated_at, updated_by, deleted }`, the same in the hub's SQLite and in the web app's IndexedDB. `rev` is one counter for every change. Clients fetch everything changed after the last `rev` they saw.

| Collection | What it holds | Who writes it |
| --- | --- | --- |
| `sources` | streams to record (public fields only) | editors |
| `schedules` | when meetings happen, one-off or recurring | editors |
| `recorders` | machines that record | recorders |
| `recordings` | each recorded meeting: its occurrence, parts, times, status, title | recorders, editors |
| `transcript_chunks` | transcript lines a few minutes at a time, quick (live) or final | recorders (written once) |
| `stills` | pictures from a recording, by media hash | recorders (written once) |
| `marks` | review marks: speakers, chapters, votes, views, boosts, meeting name, word edits, playlist, people | editors, recorders |
| `settings` | public settings (never secrets) | editors |

Anyone can read. Writing needs a key, sent as the `X-Streamscribe-Key` header.

**When two writers change the same record:** each change says which `rev` it was based on. If the record has changed since, the hub answers with a conflict and the current version. The client merges the two (`src/sync/merge.js`), keeping both sides' changes item by item, and sends the result again. For example, two people adding chapters at the same time both keep theirs.

**Retries are safe:**
- Every batch of changes has an `op_id`, so a retried batch gets the same answer instead of being applied twice.
- Transcript chunks and stills have fixed ids, so sending one again does nothing.
- Pictures are stored under their SHA-256 hash, so uploading one again is skipped.

## Schedules

A schedule says when a meeting happens, in its own time zone, so a 6 pm meeting stays at 6 pm when daylight saving changes:

```json
{ "title": "Board of Supervisors", "sourceKey": "warren-county-va", "timeZone": "America/New_York",
  "start": "2026-01-06T13:00", "durationMinutes": 300, "rrule": "FREQ=MONTHLY;BYDAY=1TU",
  "exdates": ["2026-07-07T13:00"], "overrides": { "2026-12-01T13:00": { "start": "2026-12-02T14:00" } },
  "leadMinutes": 10, "overrun": { "standbyMinutes": 10, "idleMinutes": 15, "capMinutes": 240 },
  "preferredRecorder": "office-mac" }
```

- **`rrule`:** a subset of the iCalendar repeat rule. Leave it empty for a single meeting.
  - `FREQ=WEEKLY;BYDAY=TU`: every Tuesday.
  - `FREQ=MONTHLY;BYDAY=1TU`: the first Tuesday of each month.
  - `FREQ=MONTHLY;BYDAY=-1TH`: the last Thursday of each month.
  - Also supported: `INTERVAL=2` (every other), `COUNT=10`, and `UNTIL=20271231` (inclusive).
- **Cancellations and moves:** `exdates` cancels single meetings and `overrides` moves or shortens one. Both name the meeting by its original start.
- **`overrun`** (optional): when the recorder stops after the scheduled end, in place of its own `recorder.overrun` settings (docs/recorder/recorder.md).
- **`preferredRecorder`** (optional): a recorder id. That recorder starts at the lead time; others wait until the scheduled start and take the meeting only if it hasn't.

Recorders and the web app work out the dates (`src/sync/recurrence.js`); the hub only stores schedules.

## The web app as a static site

The web app also runs without a recorder behind it, from any static host. It shows the hub's meetings (stills and transcripts), the live page and schedules, and has a Settings page. Each browser keeps its own copy in IndexedDB and syncs with the hub every 30 seconds (every 10 on the live page).

- **GitHub Pages:** `.github/workflows/pages.yml` builds and publishes it. In the repository's settings, under Pages, choose "GitHub Actions" as the source, then run the workflow from the Actions tab. To publish on every push to main, add `push: { branches: [main] }` under `on:`.
- **Elsewhere:** build with `VITE_BASE=/folder/ VITE_ROUTER=hash npm run build` and copy `web/dist` there.
- **Connecting:** add the site's address to `allowed_origins` in the hub's `config.php`. Then, under Settings in the site, enter the hub address (ending in `api.php`). Reading needs nothing more. To change schedules, also enter an editor key. It stays in that browser only.
- **Offline:** changes made while the hub can't be reached wait in the browser and go on the next sync. If someone else changed the same schedule meanwhile, the two are merged; where both changed the same field, the browser's change wins.
- **Marks:** speakers, chapters, votes and the rest are edited on a recorder's review page, next to the video. The static site shows them but doesn't edit them.
- **Refused changes:** a change the hub won't take (a key that can't write it, a record over 256 KB) is dropped and listed under Settings, so it doesn't hold up the rest.

## Moving to a new hub

Settings → Export saves everything the browser holds as JSON. To fill a new hub with it:

```bash
php tools/import.php streamscribe-2026-10-08.json config.php
```

Then copy the old hub's `media/` folder across; pictures are named by their hash, so the records find them. Importing from Settings instead only brings what an editor key may write (schedules, sources, marks and settings), not what recorders made. When a browser switches to a different hub address, it drops its copy of the old hub and syncs the new one from the start.

## Upkeep

Deleted records stay in the database as markers, so every client learns about the deletion. To clear old ones now and then, from cron for example:

```bash
php tools/purge-deleted.php config.php 90
```

That clears deletions older than 90 days. A client that last synced before then is told to sync again from the start, and does so automatically.

## Testing

`npm test` runs the hub's tests against a temporary `php -S` server with shared-hosting limits: 2 MB uploads, 8 MB posts and 30-second requests. To run them against a real hub instead, set `HUB_URL`, `HUB_EDITOR_KEY` and `HUB_RECORDER_KEY`.
