# The hub

The hub is a small PHP API with a SQLite database (`hub-php/`). Recorders report to it: what they're recording, live thumbnails and quick transcripts, then the final transcript and stills. The web app syncs with it, whether it's served by a recorder, by the hub's own server, or by a static host such as GitHub Pages. Video stays on the recorders.

The site is an independent archive. Its meetings are private: recordings, transcripts, stills, marks, the live view, and the audio and video files are visible only to signed-in people whose group may see meetings. What you publish is for everyone: notes, summaries, transcript excerpts and clips. Each links to the official recording when one is known. People sign in to change things, and their group decides what their changes may do (see People, groups, and layers below). Recorders and scripts use keys.

## Install

You need PHP 8 with `pdo_sqlite`, which most hosts have, and HTTPS. [deploy.md](deploy.md) covers it: the deploy script puts the hub and the web app on your server together and keeps them up to date from GitHub Actions. By hand, it comes down to:

1. **Upload** `hub-php/` (to `https://example.com/hub/`, say).
2. **Configure:** copy `config.example.php` to `config.php` and edit it. It documents every setting.
3. **Make the admin:** `php tools/new-user.php YOUR-NAME --admin`.
4. **Check:** open `…/api.php/info`.

Recorders and the web app use `https://example.com/hub/api.php` as the hub address. It needs no URL rewriting: routes are `api.php/changes`, `api.php/records` and so on, or `api.php?r=changes` where a host doesn't pass the path through.

**Keys** are for recorders and scripts: the Agents page makes them for agents it installs. Otherwise, `php tools/new-key.php recorder "Office Mac"` (or `editor "Import script"`) prints a key once, plus the line for `keys` in `config.php`; the hub keeps only its hash. People don't use keys: they sign in. More hub tools, run in `hub-php/` on the server:

| Tool                                                             | What it does                                           |
| ---------------------------------------------------------------- | ------------------------------------------------------ |
| `tools/migrate.php`                                              | brings the database up to date (deploys run it)        |
| `tools/new-user.php NAME [--admin \| --group NAME] [--name "…"]` | makes an account, or resets its password               |
| `tools/new-key.php recorder\|editor "Name"`                      | makes a key                                            |
| `tools/import.php export.json`                                   | loads an export into the hub (see Moving to a new hub) |
| `tools/purge-deleted.php config.php 90`                          | clears old deletion markers (see Upkeep)               |

## What's stored

Every record is `{ collection, id, data, rev, updated_at, updated_by, deleted, owner, layer }`, the same in the hub's SQLite and in the web app's IndexedDB. `rev` is one counter for every change. Clients fetch everything changed after the last `rev` they saw.

| Collection          | What it holds                                                                                                           | Who writes it                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `sources`           | streams to record (public fields only)                                                                                  | Edit sources permission                                  |
| `schedules`         | when meetings happen, one-off or recurring                                                                              | Edit schedules permission                                |
| `settings`          | public settings (never secrets)                                                                                         | Edit sources permission                                  |
| `recorders`         | machines that record                                                                                                    | recorders                                                |
| `recordings`        | each recorded meeting: its occurrence, parts, times, status, title, official sources                                    | recorders                                                |
| `transcript_chunks` | transcript lines a few minutes at a time, quick (live) or final                                                         | recorders (written once)                                 |
| `stills`            | pictures from a recording                                                                                               | recorders (written once)                                 |
| `media`             | a recording's private audio and silent video on the hub                                                                 | recorders                                                |
| `marks`             | review marks: speakers, chapters, votes, views, boosts, meeting name and official sources, word edits, playlist, people | recorders (shared); people (their own layers, see below) |
| `publications`      | what's published for everyone: notes, transcript excerpts, clips                                                        | the Publish permission; agents (a clip's files)          |
| `directory`         | the public directory of people: who is listed, and their public photo                                                   | the Publish permission                                   |
| `jobs`              | work for agents: clips to cut, recordings to encode                                                                     | the Publish permission; agents (progress)                |

Anyone can read schedules, sources, settings, recorders, and publications. Meetings (`recordings`, `transcript_chunks`, `stills`, `media`, `marks`) and the work queue (`jobs`) go only to keys and to people whose group may see meetings. Everyone else's browser gets them as deleted. Writing needs a key (the `X-Streamscribe-Key` header) or a signed-in person (the `X-Streamscribe-Token` header, which the web app sends) whose group allows it.

## People, groups, and layers

**Accounts.** Anyone can make an account in the web app (Account, at the top right), unless an admin closes sign-ups. Passwords are stored as PHP password hashes; after 10 wrong passwords in 15 minutes from one address or for one username, sign-ins wait. A sign-in lasts 30 days from the last visit.

**Groups.** Every person is in one group, and the group's permissions say what their changes may do. Admins change them on the Accounts page (only admins and reviewers see it).

| Permission                                                        | Admin | Editor | Reporter | Member | Limited |
| ----------------------------------------------------------------- | ----- | ------ | -------- | ------ | ------- |
| Correct transcript words                                          | ✓     | ✓      | ✓        | ✓      |         |
| Choose who is speaking, and add people                            | ✓     | ✓      | ✓        | ✓      |         |
| Chapters and the meeting name                                     | ✓     | ✓      | ✓        |        |         |
| Votes                                                             | ✓     | ✓      | ✓        |        |         |
| Camera views, audio boosts, and clips                             | ✓     | ✓      |          |        |         |
| Edit schedules                                                    | ✓     | ✓      |          |        |         |
| Edit sources and site settings                                    | ✓     | ✓      |          |        |         |
| Review people (see untrusted changes, mark people trusted or not) | ✓     | ✓      |          |        |         |
| See full meetings (private)                                       | ✓     |        |          |        |         |
| Publish clips and transcripts                                     | ✓     |        |          |        |         |
| Manage people and groups                                          | ✓     |        |          |        |         |

Only Admin sees full meetings at first. Tick "See full meetings" for any group that should see them. Without it, the other permissions (correcting words, speakers) have nothing to act on.

Admin always has every permission and can't be removed, and the last admin can't be demoted or turned off. Other groups can be renamed, removed (their people move to a group you choose), or added. New accounts join Member and are trusted; both are settings on the Accounts page.

**Layers.** A signed-in person's changes to a meeting don't overwrite anything. Each person's changes to a mark (the word corrections of one recording, its speakers, a source's people) are a record of their own, `<mark id>~<user id>`, holding what they saw without their changes and with them. What each person sees is built in the browser (`src/sync/layers.js`):

1. The shared mark from the recorder.
2. Everyone else's public layers, oldest change first.
3. Admins' layers, so an admin's changes win over everyone else's.
4. Your own layer, so you always see your own changes.

Each layer carries only what that person changed, so removing it removes only their changes.

**Who sees a layer:**

- **Public layers.** If the person's group has the permission for that kind of change (correcting words, say), their layer is public: everyone sees it, while the person is trusted.
- **Private layers.** If not, the same change is kept for them alone, and the page says so ("only you see this").
- **Untrusted people.** Unticking Trusted on the Accounts page hides all of someone's layers from everyone else straight away. On their next sync, other browsers drop them. Reviewers still see them, marked untrusted.
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

## Official sources

This archive is independent, but it points to the originals. Each meeting keeps its official sources (`src/sync/official.js`), and every link is built from their ids:

| Source                  | Links                                                                                                                                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Official video (Swagit) | the video page (`/videos/<id>`), the page at a moment (`?ts=<seconds>`), the embed code (`/embed`, with `?autoplay=0` unless you choose autoplay), download (`/download`), the transcript with the video (`#transcript`), the transcript download (`/transcript`), the agenda with the video (`#full-agenda`) |
| Documents (CivicClerk)  | the meeting overview (`/event/<id>/overview`), the agenda and the full packet (`/event/<id>/files/agenda/<file>`)                                                                                                                                                                                             |
| Calendar (CivicPlus)    | the calendar entry                                                                                                                                                                                                                                                                                            |
| Per chapter             | files such as draft minutes (`/event/<id>/files/attachment/<file>`), added with "+ file" on a chapter                                                                                                                                                                                                         |

**Where they come from.** A meeting built from the archive (`build-meeting`) brings its Swagit video, and `publish-library` sends it. People who may edit chapters can add or change any of them on the meeting page: under Official sources, paste the official addresses and the ids are taken from them.

**Times.** The official video's clock isn't this archive's. A capture may start earlier, or include material the archive left out (the Oct 6 meeting has about 11 minutes of it). For a built meeting, the alignment `build-meeting` made becomes a list of matching points, so official links "at this moment" land on the same words. Otherwise, set the seconds the official video is ahead of this one. With neither, links go to the start of the video rather than claim a time.

**Where they show:**

- **The meeting page:** the Official sources panel: the links, "from the player's moment", and the embed code. Each chapter gets a ↗ to the official video at its moment, plus its files.
- **Publications:** the official player embedded, "watch this part on the official site" at the same moment, the links, and each chapter's official moment and files.
- **The podcast:** each episode's notes link to the official video at the clip's start.

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
- **Uploads.** Agents upload through the API with their own key, in pieces (`upload-begin`, `upload-chunk`, `upload-finish`). Each piece is at most `upload_chunk_bytes` (4 MB by default, under the host's `post_max_size`). An interrupted upload resumes, and the result is checked against its SHA-256. Agents may only put files in the meetings' private `recordings/` and the public `published/`.

**Adding an agent.** On the Agents page, an admin gets a one-line install command for a Raspberry Pi or another Debian or Ubuntu machine ([../recorder/recorder.md](../recorder/recorder.md#installing-an-agent-raspberry-pi-debian-ubuntu)).

- **The key:** installing trades the command's one-time token for the agent's own key. The hub keeps only its hash, in its database, beside any keys in `config.php`.
- **Revoking:** Revoke stops a key at once.
- **The agent's code:** deploys put it in `hub/agent/`. It downloads only with an install token or an agent's key.

## People

The People page lists the people in meetings. It draws on each source's roster from the review page (names, roles, groups), the photos `publish-library` sends (to the private folder), and what each person has said. Speaking time and appearances come from the meetings' speaker marks, counting each turn until the next one. A person's page links each meeting at the moment they first spoke (`/meetings/<id>?part=…&t=…` opens a meeting there), and speaker names in transcripts link to their person.

**Who sees what:**

- **People who may see meetings:** everyone on the rosters, with their speaking time.
- **People who may publish:** also choose, person by person, who is **Public** (listed on the public People page, usually the public body and its officials) and whose **photo** is public.
- **Everyone else:** the public directory, and on each person's page, the published items they speak in.

**How the public directory works:**

- **Where it lives:** a public record per source (collection `directory`).
- **Photos:** a public photo is a copy of the private one in `media/people/<source>/`, removed when it stops being public.
- **Published transcripts:** show a public photo beside the speaker's name.

**Previewing the public view:** an admin sees a small 👁️ button in the corner of every page. It switches the site to what a signed-out visitor sees (a separate signed-out copy in the browser, with no private files), and the button (now 🙈) stays to switch back. The preview lasts for that browser tab, and ends on sign-out.

## Schedules

A schedule says when a meeting happens, in its own time zone, so a 6 pm meeting stays at 6 pm when daylight saving changes:

```json
{
  "title": "Board of Supervisors",
  "sourceKey": "warren-county-va",
  "timeZone": "America/New_York",
  "start": "2026-01-06T13:00",
  "durationMinutes": 300,
  "rrule": "FREQ=MONTHLY;BYDAY=1TU",
  "exdates": ["2026-07-07T13:00"],
  "overrides": { "2026-12-01T13:00": { "start": "2026-12-02T14:00" } },
  "leadMinutes": 10,
  "overrun": { "standbyMinutes": 10, "idleMinutes": 15, "capMinutes": 240 },
  "preferredRecorder": "office-mac"
}
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

The web app also runs without a recorder behind it, from any static host. Each browser keeps its own copy in IndexedDB and syncs with a hub every 30 seconds (every 10 on the live and agents pages).

- **Signed out:** Published, Schedules, Settings and Account.
- **Signed in:** whatever your group allows. That's Meetings, People, Live and Agents with "See full meetings", and Accounts for reviewers and admins.
- **Without any hub:** the browser keeps everything to itself. Schedules work, and Export/Import under Settings moves its data. Nothing is shared and nobody signs in.

- **On the hub's server:** `bin/deploy-hub.sh` puts the site beside the hub, already pointed at it ([deploy.md](deploy.md)).
- **GitHub Pages:** `.github/workflows/pages.yml` builds and publishes it ([deploy.md](deploy.md)).
- **Elsewhere:** build with `VITE_BASE=/folder/ VITE_ROUTER=hash VITE_HUB_URL=https://example.com/streamscribe/api.php npm run build` and copy `web/dist` there.
- **Connecting:** add the site's address to `allowed_origins` in the hub's `config.php`. Build it with the hub's address (the `PAGES_HUB_URL` variable, see deploy.md), or enter the address under Settings (ending in `api.php`). Reading needs nothing more. To change things, sign in (Account). The session stays in that browser only.
- **Offline:** changes made while the hub can't be reached wait in the browser and go on the next sync. If someone else changed the same schedule meanwhile, the two are merged; where both changed the same field, the browser's change wins.
- **Marks:** signed in, click a word of the final transcript to correct it or to say who is speaking from there (adding someone new if needed). Chapter files and official sources are edited on the meeting page. Chapters themselves, votes, and the rest are edited on a recorder's review page, next to the video; the site shows them.
- **Refused changes:** a change the hub won't take (a group or key that can't write it, a record over 256 KB) is dropped and listed under Settings, so it doesn't hold up the rest.
- **Signing in or out** fetches the browser's copy again from the start, since what the hub shows depends on who's asking.

## Moving to a new hub

Settings → Export saves everything the browser holds as JSON. To fill a new hub with it:

```bash
php tools/import.php streamscribe-2026-10-08.json config.php
```

Then copy the old hub's `media/` folder (published files) and its private folder (`private_dir`, by default `private/` beside the database: meetings' pictures, audio, and video) across, keeping their paths, so the records find them. Accounts and groups aren't in the export: copy the old hub's database file instead to keep them. Importing from Settings instead only brings what that browser may write (with an editor key: schedules, sources and settings), not what recorders made. When a browser switches to a different hub address, it drops its copy of the old hub and syncs the new one from the start.

## Upkeep

Deleted records stay in the database as markers, so every client learns about the deletion. To clear old ones now and then, from cron for example:

```bash
php tools/purge-deleted.php config.php 90
```

That clears deletions older than 90 days. A client that last synced before then is told to sync again from the start, and does so automatically.

## Testing

`npm test` runs the hub's tests (`test/hub-*.test.js`, with the helper in `test/hub/server.js`) against temporary `php -S` servers with shared-hosting limits: 2 MB uploads, 8 MB posts and 30-second requests. They cover syncing, files and uploads, accounts and layers, publishing and the podcast, and agents. To run them against a real hub instead, set `HUB_URL`, `HUB_EDITOR_KEY` and `HUB_RECORDER_KEY`; tests that need the hub's folder are then skipped.
