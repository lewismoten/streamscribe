# The hub

The hub is a small PHP API with a SQLite database (`hub-php/`). Recorders report to it: what they're recording, live thumbnails and quick transcripts, then the final transcript and stills. The web app syncs with it, whether it's served by a recorder, by the hub's own server, or by a static host such as GitHub Pages. Video stays on the recorders.

The site is an independent archive. Its meetings are private: recordings, transcripts, stills, marks, the live view, and the audio and video files are visible only to signed-in people whose group may see meetings. What you publish is for everyone: notes, summaries, transcript excerpts and clips. Each links to the official recording when one is known. People sign in to change things, and their group decides what their changes may do (see People, groups, and layers below). Recorders and scripts use keys.

## Install on shared hosting

You need PHP 8 with `pdo_sqlite`, which most hosts have, and HTTPS. The easiest way is the deploy script, which puts the hub and the web app on your server together and keeps them up to date from GitHub Actions: see [deploy.md](deploy.md). To install by hand instead:

1. Upload the `hub-php/` folder, for example as `https://example.com/streamscribe/`.
2. Copy `config.example.php` to `config.php` and edit it:
   - `allowed_origins`: the web addresses allowed to call the hub from a browser, such as `https://your-name.github.io`.
   - `database` and `media_dir`: where the SQLite file and uploaded pictures go. Keep the database outside the web root if your host allows it. Otherwise the included `.htaccess` blocks `data/` from the web.
   - `keys`: one line per recorder (and per script that edits schedules). Make each one with:

     ```bash
     php tools/new-key.php recorder "Office Mac"
     php tools/new-key.php editor "Import script"
     ```

     Each run prints the key once, to give to that recorder or script, and the line to paste into `config.php`. The hub stores only the key's hash. People don't need keys: they sign in.
3. Make your own account, as the admin: `php tools/new-user.php YOUR-NAME --admin` (it asks for a password).
4. Open `https://example.com/streamscribe/api.php/info`. It should answer with the hub's name.

Your recorders and the web app use `https://example.com/streamscribe/api.php` as the hub address. It works without URL rewriting: routes are `api.php/changes`, `api.php/records`, and so on, or `api.php?r=changes` where a host doesn't pass the path through.

## What's stored

Every record is `{ collection, id, data, rev, updated_at, updated_by, deleted, owner, layer }`, the same in the hub's SQLite and in the web app's IndexedDB. `rev` is one counter for every change. Clients fetch everything changed after the last `rev` they saw.

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

Anyone can read schedules, sources, settings, recorders, and publications. Meetings (`recordings`, `transcript_chunks`, `stills`, `media`, `marks`) and the work queue (`jobs`) go only to keys and to people whose group may see meetings. Everyone else's browser gets them as deleted. Writing needs a key (the `X-Streamscribe-Key` header) or a signed-in person (the `X-Streamscribe-Token` header, which the web app sends) whose group allows it.

## People, groups, and layers

**Accounts.** Anyone can make an account in the web app (Account, at the top right), unless an admin closes sign-ups. Passwords are stored as PHP password hashes; after 10 wrong passwords in 15 minutes from one address or for one username, sign-ins wait. A sign-in lasts 30 days from the last visit.

**Groups.** Every person is in one group, and the group's permissions say what their changes may do. Admins change them on the People page (only admins and reviewers see it).

| Permission | Admin | Editor | Reporter | Member | Limited |
| --- | --- | --- | --- | --- | --- |
| Correct transcript words | ✓ | ✓ | ✓ | ✓ | |
| Choose who is speaking, and add people | ✓ | ✓ | ✓ | ✓ | |
| Chapters and the meeting name | ✓ | ✓ | ✓ | | |
| Votes | ✓ | ✓ | ✓ | | |
| Camera views, audio boosts, and clips | ✓ | ✓ | | | |
| Edit schedules | ✓ | ✓ | | | |
| Edit sources and site settings | ✓ | ✓ | | | |
| Review people (see untrusted changes, mark people trusted or not) | ✓ | ✓ | | | |
| See full meetings (private) | ✓ | | | | |
| Publish clips and transcripts | ✓ | | | | |
| Manage people and groups | ✓ | | | | |

Only Admin sees full meetings at first. Tick "See full meetings" for any group that should see them. Without it, the other permissions (correcting words, speakers) have nothing to act on.

Admin always has every permission and can't be removed, and the last admin can't be demoted or turned off. Other groups can be renamed, removed (their people move to a group you choose), or added. New accounts join Member and are trusted; both are settings on the People page.

**Layers.** A signed-in person's changes to a meeting don't overwrite anything. Each person's changes to a mark (the word corrections of one recording, its speakers, a source's people) are a record of their own, `<mark id>~<user id>`, holding what they saw without their changes and with them. What each person sees is built in the browser (`src/sync/layers.js`):

1. The shared mark from the recorder.
2. Everyone else's public layers, oldest change first.
3. Admins' layers, so an admin's changes win over everyone else's.
4. Your own layer, so you always see your own changes.

Each layer carries only what that person changed, so removing it removes only their changes.

**Who sees a layer:**
- **Public layers.** If the person's group has the permission for that kind of change (correcting words, say), their layer is public: everyone sees it, while the person is trusted.
- **Private layers.** If not, the same change is kept for them alone, and the page says so ("only you see this").
- **Untrusted people.** Unticking Trusted on the People page hides all of someone's layers from everyone else straight away. On their next sync, other browsers drop them. Reviewers still see them, marked untrusted.
- **Removed accounts.** Removing someone removes their layers.

The recorder's own review page still edits the shared marks directly; people's layers show in the web app, on top of them.

**When two writers change the same record:** each change says which `rev` it was based on. If the record has changed since, the hub answers with a conflict and the current version. The client merges the two (`src/sync/merge.js`), keeping both sides' changes item by item, and sends the result again. For example, two people adding chapters at the same time both keep theirs.

**Retries are safe:**
- Every batch of changes has an `op_id`, so a retried batch gets the same answer instead of being applied twice.
- Transcript chunks and stills have fixed ids, so sending one again does nothing.
- Pictures are stored under their SHA-256 hash, so uploading one again is skipped.

## Private files

The meetings' files live outside the web folder: in `private_dir` in `config.php`, by default a folder named `private` beside the database.
- **Audio and silent video:** `npm run publish-media`, or an agent's encode job.
- **Stills and live pictures:** recorders.

They're served only through `api.php/file/private/…`, with a signature that expires after 12 hours. Browsers of people who may see meetings fetch it from `GET file-key` and add it to each file's address. The hub answers byte-range requests, so a player fetches only what it plays.

Hubs from before meetings were private had these files in `media/`. The first deploy after the upgrade moves them, through `tools/migrate.php`. Their records then point at the new place, and browsers that may no longer see them drop them.

## Publishing

On a meeting page, people whose group may publish see a Publish panel:
- **Title, and notes or a summary.** Notes can stand alone.
- **A stretch of the meeting.** Pick it with From/To, "now" (the player's time), "whole meeting", or one of your playlist clips.
- **Transcript of that stretch.** It goes out as shown: corrections applied, speaker names in.
- **Clip.** The stretch's video and audio.

What happens next:
- **Text and transcript.** The hub saves them at once as public files in `media/published/<id>/`: `transcript.json`, `transcript.txt`, `captions.srt`, and a cover picture from the meeting's stills. The publication carries the link to the official recording.
- **Clip.** It's queued as a job, and an agent with the video cuts it: an MP4 with sound at 720p, 30 fps, plus the sound alone as M4A. The agent uploads both to that folder. Until then the publication's page says the clip is being prepared.
- **The Published page.** It lists everything for everyone, and each item has its own page.
- **Unpublishing.** Its page has Unpublish, which removes the publication and its files.
- **The podcast.** `api.php/podcast/<source>.xml` lists published clips, with chapters and captions. Full meetings never appear in it.

## Agents and their work

The hub only keeps the queue. Agents do the work: the recorder service (`npm run recorder`) on machines that have the video. Each agent has a short id and a name (`recorder.id`, `recorder.name` in its `config.local.js`), and reports every few seconds.

The Agents page, for people who may see meetings, shows:
- **Each agent:** online or not, last heard from, version, free disk, and what it's recording or working on.
- **The queue:** jobs in progress (with progress bars), waiting, and recently finished or failed. People who may publish can Cancel or Retry a job.

Job types:
- **`clip`:** cut a published clip, upload it, and mark it ready.
- **`encode`:** make and upload a recording's private audio and silent video. A recorder queues one for itself after each meeting it records. The meeting page's "Make audio and video for the hub" queues one for a recording that has none.

How agents share the work:
- **Picking jobs.** An idle agent takes the oldest queued job it can do: it must have that recording, and a job meant for a particular agent waits for that one.
- **Claiming.** It claims the job on the hub, so no other agent takes it, and renews the claim while it works. It writes its progress into the job.
- **Stopping.** Cancelling stops the job. An agent that shuts down mid-job puts the job back in the queue.
- **Uploads.** Agents upload over SSH with the deploy settings (`deploy.local.env`, see deploy.md), so each agent machine needs those and an SSH key the server accepts.

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

The web app also runs without a recorder behind it, from any static host. It shows the hub's meetings (stills and transcripts), the live page and schedules, and has Account, People and Settings pages. Each browser keeps its own copy in IndexedDB and syncs with the hub every 30 seconds (every 10 on the live page).

- **On the hub's server:** `bin/deploy-hub.sh` puts the site beside the hub, already pointed at it ([deploy.md](deploy.md)).
- **GitHub Pages:** `.github/workflows/pages.yml` builds and publishes it ([deploy.md](deploy.md)).
- **Elsewhere:** build with `VITE_BASE=/folder/ VITE_ROUTER=hash VITE_HUB_URL=https://example.com/streamscribe/api.php npm run build` and copy `web/dist` there.
- **Connecting:** add the site's address to `allowed_origins` in the hub's `config.php`. Build it with the hub's address (the `PAGES_HUB_URL` variable, see deploy.md), or enter the address under Settings (ending in `api.php`). Reading needs nothing more. To change things, sign in (Account). The session stays in that browser only.
- **Offline:** changes made while the hub can't be reached wait in the browser and go on the next sync. If someone else changed the same schedule meanwhile, the two are merged; where both changed the same field, the browser's change wins.
- **Marks:** signed in, click a word of the final transcript to correct it or to say who is speaking from there (adding someone new if needed). Chapters, votes and the rest are edited on a recorder's review page, next to the video; the site shows them.
- **Refused changes:** a change the hub won't take (a group or key that can't write it, a record over 256 KB) is dropped and listed under Settings, so it doesn't hold up the rest.
- **Signing in or out** fetches the browser's copy again from the start, since what the hub shows depends on who's asking.

## Moving to a new hub

Settings → Export saves everything the browser holds as JSON. To fill a new hub with it:

```bash
php tools/import.php streamscribe-2026-10-08.json config.php
```

Then copy the old hub's `media/` folder across; pictures are named by their hash, so the records find them. Accounts and groups aren't in the export: copy the old hub's database file instead to keep them. Importing from Settings instead only brings what that browser may write (with an editor key: schedules, sources and settings), not what recorders made. When a browser switches to a different hub address, it drops its copy of the old hub and syncs the new one from the start.

## Upkeep

Deleted records stay in the database as markers, so every client learns about the deletion. To clear old ones now and then, from cron for example:

```bash
php tools/purge-deleted.php config.php 90
```

That clears deletions older than 90 days. A client that last synced before then is told to sync again from the start, and does so automatically.

## Testing

`npm test` runs the hub's tests against a temporary `php -S` server with shared-hosting limits: 2 MB uploads, 8 MB posts and 30-second requests. To run them against a real hub instead, set `HUB_URL`, `HUB_EDITOR_KEY` and `HUB_RECORDER_KEY`.
