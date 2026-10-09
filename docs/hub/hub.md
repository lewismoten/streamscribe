# The hub

The hub is a small PHP API with a SQLite database (`hub-php/`). Recorders report to it: what they're recording, live thumbnails and quick transcripts, then the final transcript and stills. The web app syncs with it, whether it's served by a recorder, by the hub's own server, or by a static host such as GitHub Pages. Video stays on the recorders.

The site is an independent archive. Its meetings are private: recordings, transcripts, stills, marks, the live view, and the audio and video files are visible only to signed-in people whose group may see meetings. What you publish is for everyone: notes, summaries, transcript excerpts and clips. Each links to the official recording when one is known. People sign in to change things, and their group decides what their changes may do (see People, groups, and layers below). Recorders and scripts use keys.

## Install

You need PHP 8 with `pdo_sqlite`, which most hosts have, and HTTPS. [deploy.md](deploy.md) covers it: the deploy script puts the hub and the web app on your server together and keeps them up to date from GitHub Actions. By hand, it comes down to:

1. **Upload** `hub-php/` (to `https://example.com/hub/`, say).
2. **Make the admin:** open the web app (or `…/api.php/info` to check first). A hub with no accounts asks its first visitor for a username and password, and that account is the admin, so do this right after uploading.
3. **Settings:** under Accounts (admins): the hub's name, other sites allowed to use it from a browser (GitHub Pages), public addresses, upload and clip limits, podcast details, and keys. They're kept in the database (`hub-php/lib/config.php` lists them). No config file is needed: the database goes in `data/` and published files in `media/` beside `api.php`. An optional `config.php` (from `config.example.php`) only says where files live; settings an older `config.php` holds keep working until an admin saves them in the web app.

Recorders and the web app use `https://example.com/hub/api.php` as the hub address. It needs no URL rewriting: routes are `api.php/changes`, `api.php/records` and so on, or `api.php?r=changes` where a host doesn't pass the path through.

**Keys** are for recorders and scripts: the Agents page makes them for agents it installs. Otherwise, make one under Accounts → Keys, or with `php tools/new-key.php recorder "Office Mac"` (or `editor "Import script"`). Either shows the key once; the hub keeps only its hash, in the database. People don't use keys: they sign in. More hub tools, run in `hub-php/` on the server:

| Tool                                                             | What it does                                                |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `tools/migrate.php`                                              | brings the database up to date (deploys run it)             |
| `tools/new-user.php NAME [--admin \| --group NAME] [--name "…"]` | makes an account (such as an admin), or resets its password |
| `tools/new-key.php recorder\|editor "Name"`                      | makes a key                                                 |
| `tools/import.php export.json`                                   | loads an export into the hub (see Moving to a new hub)      |
| `tools/purge-deleted.php 90`                                     | clears old deletion markers (see Upkeep)                    |

## What's stored

Every record is `{ collection, id, data, rev, updated_at, updated_by, deleted, owner, layer }`, the same in the hub's SQLite and in the web app's IndexedDB. `rev` is one counter for every change. Clients fetch everything changed after the last `rev` they saw.

| Collection          | What it holds                                                                                                                       | Who writes it                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `sources`           | streams to record (public fields only)                                                                                              | Edit sources permission                                  |
| `schedules`         | when meetings happen, one-off or recurring                                                                                          | Edit schedules permission                                |
| `settings`          | public settings (never secrets)                                                                                                     | Edit sources permission                                  |
| `recorders`         | machines that record                                                                                                                | recorders                                                |
| `recordings`        | each recorded meeting: its occurrence, parts, times, status, title, official sources                                                | recorders                                                |
| `transcript_chunks` | transcript lines a few minutes at a time, quick (live) or final                                                                     | recorders (written once)                                 |
| `stills`            | pictures from a recording                                                                                                           | recorders (written once)                                 |
| `media`             | a recording's private audio and silent video on the hub                                                                             | recorders                                                |
| `marks`             | review marks: speakers, chapters, votes, views, boosts, meeting name and official sources, word edits, playlist, people, attendance | recorders (shared); people (their own layers, see below) |
| `publications`      | what's published for everyone: notes, transcript excerpts, clips                                                                    | the Publish permission; agents (a clip's files)          |
| `directory`         | the public directory of people: who is listed, and their public photo                                                               | the Publish permission                                   |
| `clips`             | stretches of meetings saved to build videos from (private)                                                                          | the Camera views, audio boosts, and clips permission     |
| `videos`            | videos put together from clips of any meetings, in order (private until published)                                                  | the Camera views, audio boosts, and clips permission     |
| `jobs`              | work for agents: clips to cut, recordings to encode                                                                                 | the Publish permission; agents (progress)                |
| `organizations`     | counties, towns, school divisions, nonprofits with public bodies; their districts                                                   | Edit public bodies permission                            |
| `bodies`            | public bodies (boards, committees, staff): how members are chosen, which meetings are theirs                                        | Edit public bodies permission                            |
| `locations`         | places mentioned in meetings: a name, an address, GPS coordinates, a tax map id, and shapes on a map                                | the Chapters and the meeting name permission             |
| `rooms`             | where meetings are held: a room in a building, its address, and the camera views its meetings share                                 | Edit public bodies permission                            |
| `elections`         | an organization's elections: the day, a name, general, special, or primary                                                          | Edit public bodies permission                            |
| `profiles`          | a person's formal name, nicknames, and ids on other sites (such as state election results)                                          | Edit public bodies permission                            |
| `terms`             | who served on a body, as what, and when: elected, appointed, officer, staff, interim, candidate                                     | Edit public bodies permission                            |

Anyone can read schedules, sources, settings, recorders, publications, the directory, and public bodies. Meetings (`recordings`, `transcript_chunks`, `stills`, `media`, `marks`) and the work queue (`jobs`) go only to keys and to people whose group may see meetings. Everyone else's browser gets them as deleted. Writing needs a key (the `X-Streamscribe-Key` header) or a signed-in person (the `X-Streamscribe-Token` header, which the web app sends) whose group allows it.

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
| Edit public bodies (members, officers, staff, candidates)         | ✓     | ✓      |          |        |         |
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

The meetings' files live outside the web folder: in `private_dir` (`config.php`, optional), by default a folder named `private` beside the database.

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
- **`video`:** cut each clip of a published video (from recordings this agent has, all of them), join them into one MP4 (each scaled to 1280×720, at 30 frames a second) and an M4A, and upload them to the video's publication.
- **`encode`:** make and upload a recording's private audio and silent video. A recorder queues one for itself after each meeting it records. The meeting page's "Make audio and video for the hub" queues one for a recording that has none.

How agents share the work:

- **Picking jobs.** An idle agent takes the oldest queued job it can do: it must have that recording, and a job meant for a particular agent waits for that one.
- **Claiming.** It claims the job on the hub, so no other agent takes it, and renews the claim while it works. It writes its progress into the job.
- **Stopping.** Cancelling stops the job. An agent that shuts down mid-job puts the job back in the queue.
- **Uploads.** Agents upload through the API with their own key, in pieces (`upload-begin`, `upload-chunk`, `upload-finish`). Each piece is at most `upload_chunk_bytes` (4 MB by default, under the host's `post_max_size`). An interrupted upload resumes, and the result is checked against its SHA-256. Agents may only put files in the meetings' private `recordings/` and the public `published/`.

**Adding an agent.** On the Agents page, an admin gets a one-line install command for a Raspberry Pi or another Debian or Ubuntu machine ([../recorder/recorder.md](../recorder/recorder.md#installing-an-agent-raspberry-pi-debian-ubuntu)).

- **The key:** installing trades the command's one-time token for the agent's own key. The hub keeps only its hash, in its database, beside the keys made under Accounts.
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

## Public bodies

The Bodies page lists public bodies by the organization they belong to: a county, a town, a school division, or a nonprofit whose meetings are public (such as a library whose trustees are chosen by the board itself). It's public; people whose group may edit public bodies (Editors, by default) change it.

- **Organizations** have districts (such as Fork, Happy Creek, North River, Shenandoah, South River).
- **Bodies** belong to an organization, or sit under another body (a committee). Each says how its members are chosen (elected, appointed, chosen by the body itself, mixed, or hired staff) and which recordings are its meetings: a source's meetings, or those whose title contains some words, when one source streams several bodies.
- **Members are called** something on each body (such as Supervisor): new members' terms get that title, and the kind of term follows how its members are chosen, so neither needs choosing each time.
- **＋ Members** on a body's page shows the people heard in its meetings as pictures and names: pick everyone who has ever served, and each is added with dates not known yet (listed under "Also served"); dates, districts, and elections can follow one at a time. **＋ One term** adds a single term with everything.
- **Terms** say who served on a body, as what, and from when to when (blank until it ends), with a district and how it ended (term ended, resigned, replaced…). A person has as many as they need:
  - **Elected** or **Appointed** to a seat (appointed before an election, or after someone resigns), **Chosen by the body** (a seat the body fills itself, such as library trustees elected by their board, not by the public), a **Citizen appointee**, or **Ex officio**.
  - An **Officer** of the body, such as Chair or Vice Chair, usually a year at a time. Each body lists its offices (Chair and Vice Chair unless you change them). Its page has an **Officers** grid, a row per year back to the earliest year anyone is known to have served: pick the member who held each office that year. A year's officers are chosen on one day, the same for every office: the body's first meeting that year (when its meetings are known; members usually choose officers there), else January 1. Change it once beside the year and every office that year moves with it. When an officer leaves during the year, "Filled a vacancy…" in that cell says why they left, from when, and who took over; both show in the cell, in order. A body whose officers are more than that can name them ("Its officers together are": the Executive Committee, say), and its offices can be any list (President, Vice President, Secretary, Treasurer, At-Large). An office is held by a member: its term has no district or election of its own.
  - **Staff** or **Interim** staff, such as the County Administrator or County Attorney; someone moving between Interim County Administrator and Assistant to the County Administrator has one term for each stretch.
  - A **Candidate** running for a seat, with the election they ran in and its result (won, lost, withdrew), whether or not they're elected.

- **Elections** have a page of their own (Elections, collection `elections`): every election by year, one per day and kind (one ballot, with races for any body: supervisors, the sheriff, a school board, a town council), each with its day, kind (general, special, primary), and when those elected take office (January 1 after it, unless given). An election's page has its **races**, a body's seat in a district or at large: add a race once, with all its candidates, how each did, and a note about any of them (such as "First woman elected Sheriff"). People show with their photo where there is one (the public photo, for visitors). Marking someone **won** gives them their seat as well, from the day those elected take office for the body's term length ("Elected seats last", 4 years unless the body says). A term form can still choose an election, or add one.
- **An office of one**, such as a sheriff's office, can be an organization with no bodies: in a term form it's offered as "(the office itself)", and saving makes it a body of its own.

People in terms are the ones on each source's roster. Saving a term lists the person in the public directory (for people who may publish), since a public official's name is public; their photo stays as chosen on the People page.

**The People page** groups people by their terms: elected officials, appointed and board-chosen members, candidates, staff of each organization (county, town…), former elected officials, former appointees and board members, and former staff; then everyone else by their roster group (Residents, Vendors…). Someone is in every group that fits (a former county appointee who is now a library trustee is in both), each card saying what puts them there; earlier terms on a body someone still serves on aren't "former".

**Names, work, and links.** A person's page has "Change name, work, and links…" (for people who may edit public bodies). Their **name** in parts (title, first, middle, last, suffix) and nicknames shows at the top of their page as Title First “Nick” Last, Suffix (else the roster's name); every name is found by the People page's search. Their **work**: the roster's position and group (for people who may also see meetings; saved to the roster), and the organization they work for, which lists them with its staff on the People page when no staff term does. Their **links**: an id for each kind of link (the settings record `person-links`: its name and the address before the id, such as `https://historical.elections.virginia.gov/candidate/` or a staff directory's `…/employee?eid=`), and any other links (Facebook and the like, named for their site). Adding a link of a known kind keeps its id; "Use for others like it" makes a kind of link from one that ends in an id, in its path or its query. These live in the public collection `profiles` (id `<source>:<roster id>`).

**Person pages** show a person's public service body by body, then (for people who may see meetings) the meetings they presided at, attended, or missed, or were expected at (on the body that day) and spoke in.

**Attendance.** A meeting's Attendance panel lists the people on its body that day (from their terms) and anyone who spoke, to mark present or absent, and who presided. It's a mark (`<recording>:attendance`) with layers like the others, made public by the "Choose who is speaking" permission. When a recording isn't matched to the right body, choose it there.

## Rooms

The Rooms page lists where meetings are held, by building (with its address and a map): a room (the Board Room) in a building (the Warren County Government Center). A room keeps the **camera views** its meetings share (a view is a camera angle with a zoom area for each seat, as the review page makes them).

**A meeting's room** is the one chosen on its page (its Where panel; saved in its meeting-info mark), else its schedule's **Location**, else the room its body **usually meets in** (on the body's form). A schedule's location starts as its body's usual room. On a meeting's page, **Save this meeting's camera views to the room** shares them (people who may edit public bodies), and a meeting with none can **Use the room's camera views** (copied into its own views, so the review page has them too). A room's page shows its views, the bodies that usually meet there, what's coming up there, and (for people who may see meetings) the meetings held there.

## Locations

Selecting words in a meeting's transcript offers **Mark as a place…**: a dialog to choose a place already known (found by its name, address, or tax map id) or add one. Everything about a place is optional, as long as something is given: a name (a business, an area, an HOA), a street address (town, county, state, ZIP), GPS coordinates, a tax map id, a note, and on a map (OpenStreetMap; **Find** moves it to an address) a marker, an approximate area (a circle: its middle, then its edge), outlined areas, and roads (a click for each point, then Finish). The words get a 📍 link to the place, here and in published transcripts.

A place is called by its name, else its street address (with its town, county, and ZIP when they aren't the meeting room's), else its coordinates, else its tax map id. The **Locations** tab shows every place on a map and in a list, with how often each has come up; a place's page has its details, its map, and each time it was mentioned (for people who may see meetings), linked to that moment. Places are the public collection `locations`; the links are the transcript's `links` marks.

## Consent agenda and documents

A meeting's **Consent agenda** panel lists its consent items in agenda order (I.1, I.2 … I.10, II.1), each with its files, usually approved together; an item **pulled for discussion** is marked, with when it was discussed. **＋ Documents** (or a chapter's **＋ file**) opens a dialog that stays open while you copy from another window: paste a document's name as copied from the agenda ("I.1. Authorization to Advertise … - Cover Sheet": the item's number, its title, and which file it is) and its address, and **Add** files it under its consent item (found by number, or a new one) or a chapter, ready for the next. The consent agenda is the meeting's `consent` mark (made public by "Chapters and the meeting name").

Selecting words in the transcript also offers **Link to a meeting document…**: any of its consent items' or chapters' files, or its official documents, so the document is at hand when it's discussed.

## Clips and videos

**Clips** are stretches of meetings saved to build videos from: on a meeting's page, select words in its transcript and choose **Save as a clip…** (its title starts as those words; its start and end can be adjusted). A meeting's **Clips** panel lists its clips (each plays from its start, can be changed or removed, or added to a video), and brings in the review page's playlist (**Bring in N clips…**) for clips there that aren't clips yet.

**Videos** (the Videos page) are clips of any meetings in order. The editor has every clip on one side (found by title or meeting, by meeting) and the video's clips on the other: **Add →** or drag a clip in, drag the video's clips into order (or use their arrows), ✕ to take one out. **Play the video** previews it from each meeting's audio and video on the hub. **Publish** (the Publish permission) makes a public page for it, saying which meetings its clips come from, and queues a `video` job for an agent that has those recordings, which joins the clips into one video for it; publishing again replaces it. Clips and videos are private, like the meetings; a video keeps its own copy of each clip's range, so changing a clip later doesn't change a video.

## Links, prayer, and the Religion page

**Who is speaking** heads each block of a meeting's transcript where someone starts (their picture and name, linking to their page; on this private page their photo shows whether or not it's public), and stays at the top of the transcript while their lines scroll by. Someone starting mid-line is named there, and heads a block of their own from the next line. A ring around a speaker's picture says what they were that day, from their terms: a voting member of the body meeting (green), staff (blue), or an elected official serving elsewhere (violet), with a key over the transcript. Saying who is speaking from a word saves the change at that word's time and replaces only a change on that same word, so quick exchanges (a roll call) keep each word's speaker. Clicking a word (or Enter on it) opens its editor in a dialog: correct, delete, or restore it, say who is speaking from it, or link a phrase from it.

**Links in transcripts.** Signed in, selecting words of a meeting's transcript (with the mouse, or Shift and the arrow keys) opens a menu under them: **Mark Bible passage…** or **Link to a web page…**, each opening a dialog for those words. Selecting words that are already linked offers **Change** and **Remove** instead; each link's ✎ (beside its ↗) does the same. A word's editor (a click on it, or Enter) can also link a phrase from that word through a later one. A link goes to a web page, or names a Bible passage (a book, and chapters and verses such as `121-122` or `3:16-18`). The phrase is underlined and followed by a ↗ link. Links are each part's `links` mark (made public by "Correct transcript words"); publishing a transcript excerpt carries them, so the phrase is a link on the public page too (the hub keeps only web addresses that fit the line).

**Where passages link** is a setting (the settings record `scripture`): a web address with `{passage}` where the passage goes, `https://www.biblegateway.com/passage/?search={passage}` unless changed on the Religion page. Published transcripts keep the address they were published with.

**Prayer.** A meeting's Prayer panel says who led prayer (a prayer, an invocation, a moment of silence, a reading), when, and their church, denomination, and tradition (Front Royal Church of the Nazarene, Church of the Nazarene, Christian). A person's church is kept once for the source (its `faith` mark) and filled in the next time they pray; a denomination already known fills in its tradition. Each meeting's prayers are its `prayers` mark. Both are private, like the meetings.

**The Religion page** is an internal reference, only for people who may see meetings and edit public bodies (never shown to the public): every prayer, counted by tradition, denomination, church, and person so a rotation shows, filtered by body and year; every passage named in a transcript, by book; and where passages link.

## Schedules

The Schedules page has small block calendars of this month and the next two across the top, their days marked for meetings, US federal holidays (as observed), and elections (a marked day says what's on it; a click goes to that day in the list); then one list, month by month, of meetings by day and time, holidays, and elections. **＋ Meeting** opens a dialog: choose the public body (its name and source come with it) and the day; a body that has met before brings its usual time, length, and recording settings, from its latest schedule. A meeting's ✎ opens its schedule in the same dialog, to change it, cancel (or restore) that one meeting of a repeating schedule, or delete it. A schedule's `bodyId` names its body.

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
- **Connecting:** add the site's address under Accounts → Hub settings ("Other sites that may use this hub"). Build it with the hub's address (the `PAGES_HUB_URL` variable, see deploy.md), or enter the address under Settings (ending in `api.php`). Reading needs nothing more. To change things, sign in (Account). The session stays in that browser only.
- **Offline:** changes made while the hub can't be reached wait in the browser and go on the next sync. If someone else changed the same schedule meanwhile, the two are merged; where both changed the same field, the browser's change wins.
- **Marks:** signed in, click a word of the final transcript to correct it or to say who is speaking from there (adding someone new if needed). Chapter files and official sources are edited on the meeting page. Chapters themselves, votes, and the rest are edited on a recorder's review page, next to the video; the site shows them.
- **Refused changes:** a change the hub won't take (a group or key that can't write it, a record over 256 KB) is dropped and listed under Settings, so it doesn't hold up the rest.
- **Signing in or out** fetches the browser's copy again from the start, since what the hub shows depends on who's asking.

## Moving to a new hub

Settings → Export saves everything the browser holds as JSON. To fill a new hub with it:

```bash
php tools/import.php streamscribe-2026-10-08.json
```

Then copy the old hub's `media/` folder (published files) and its private folder (`private_dir`, by default `private/` beside the database: meetings' pictures, audio, and video) across, keeping their paths, so the records find them. Accounts and groups aren't in the export: copy the old hub's database file instead to keep them. Importing from Settings instead only brings what that browser may write (with an editor key: schedules, sources and settings), not what recorders made. When a browser switches to a different hub address, it drops its copy of the old hub and syncs the new one from the start.

## Upkeep

Deleted records stay in the database as markers, so every client learns about the deletion. To clear old ones now and then, from cron for example:

```bash
php tools/purge-deleted.php 90
```

That clears deletions older than 90 days. A client that last synced before then is told to sync again from the start, and does so automatically.

## Testing

`npm test` runs the hub's tests (`test/hub-*.test.js`, with the helper in `test/hub/server.js`) against temporary `php -S` servers with shared-hosting limits: 2 MB uploads, 8 MB posts and 30-second requests. They cover syncing, files and uploads, accounts and layers, publishing and the podcast, and agents. To run them against a real hub instead, set `HUB_URL`, `HUB_EDITOR_KEY` and `HUB_RECORDER_KEY`; tests that need the hub's folder are then skipped.
