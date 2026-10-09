# Features

What Stream Scribe does, area by area, and where each part is explained in depth. Most of the web app's features
need [a hub](hub/hub.md) (accounts, private meetings, publishing); capture and transcription run
[on your computer](../README.md#on-your-computer) or on [agents](recorder/recorder.md).

## Recording meetings

- **Capture livestreams**, recovering the minutes before you started and any gaps from network drops
  ([capture](capture/capture.md)).
- **Recorders on a schedule**: agents claim each meeting, start early, follow a meeting that runs long, and stop after
  the standby slide or when the stream goes quiet ([recorders and agents](recorder/recorder.md)).
- **Schedules**: one-off and repeating meetings in their own time zone, with three month calendars, holidays,
  elections, and meetings held without a livestream (listed so they're known, never recorded)
  ([schedules](hub/hub.md#schedules)).
- **Live view**: the latest picture and quick transcript of each meeting being recorded.
- **Full meetings from the archive**: join the official recording and your capture into one meeting, lined up so links
  to the official video land at the same moment ([build-meeting](archive/build-meeting.md)).

## Transcripts

- **Transcribed on your own machine** with Whisper; corrections typed once apply to every transcript
  ([transcription](transcription/transcribe.md), [corrections](transcription/transcript-corrections.md)).
- **Who is speaking**: speaker turns saved at the exact word, a picture and name heading each block (kept in view
  while scrolling), and rings for voting members, staff, and elected officials.
- **Word by word**: click a word to correct it or say who is speaking from there.
- **Select words** for a menu of what to do with them:
  - link them: a web page, a meeting document, a place, a Bible passage;
  - save them as a clip for a video;
  - annotate them: a **note** (with links to moments of any meeting), a **topic** with the speaker's stance, a
    **quote** (attributed to, actually said by), or a **law or document** cited
    ([notes, topics, quotes, and laws](hub/hub.md#notes-topics-quotes-and-laws)).
- **The official video** at each line's moment, kept lined up by sync points even when the archive leaves out a recess
  ([official sources](hub/hub.md#official-sources)).

## Reviewing a meeting

- **The review page** (on the machine with the video): play the capture, with the clock, meeting name, chapter,
  speakers, and votes drawn on it; mark chapters, votes, and speakers; magnify whoever is speaking; boost quiet
  speakers and transcribe them again; save frames; download clips with or without the overlays
  ([the review page](review/extract-thumbnails.md)).
- **Slides** shown during the meeting, saved as pictures, their text read by a vision model, shown on the meeting's
  page (and beside each chapter), found by their words ([extract-slides](media/extract-slides.md),
  [ocr-slides](media/ocr-slides.md)).
- **Camera views**: zoom areas for each seat, which voting members each view shows, shared with every meeting in the
  same room.
- **The meeting page** (web app): the transcript, chapters, consent agenda, attendance, prayer, official sources,
  clips, and publishing.

## Public bodies and people

- **Organizations, bodies, and terms**: who served on which board, as what, and when; districts; officers year by
  year; staff and interim staff; candidates ([public bodies](hub/hub.md#public-bodies)).
- **Elections**: one page per election day, its races, candidates, and results, with notes such as "first woman
  elected".
- **People**: grouped by their service (elected, appointed, staff of each organization, former), with formal names,
  nicknames, employer, links to other sites, attendance, and every meeting they spoke in ([people](hub/hub.md#people)).
- **Rooms** where meetings are held, and **Locations** mentioned in meetings: addresses, roads drawn on a map (or found
  on OpenStreetMap by name or route number), areas, parcels, and GPS points ([rooms](hub/hub.md#rooms),
  [locations](hub/hub.md#locations)).

## Research

- **Topics**: each topic's meetings, with up to five chapters, speakers (vendors, then voting members, staff, and
  residents), and moments, and the stances taken.
- **Quotes**: every quote used in a meeting, who it was attributed to, who really said it, and who quoted it.
- **Laws and documents**: federal, state, county, and town laws, acts, bills, ordinances, and documents cited, grouped
  by level or kind, each with where it was cited and where to read it.
- **Maps** of the state, the county's districts and precincts, its roads and water, and the town, drawn from public
  data with credits; more can be added as SVGs or pictures ([maps](maps/maps.md)).
- **Religion** (internal): who led prayer, counted by tradition, denomination, and church, and the passages named.
- **Tasks** with a language model on your network (Ollama): summaries, minutes, articles, YouTube descriptions,
  analysis, playlists of public comments; run from a meeting, or after every meeting
  ([tasks](hub/hub.md#tasks-language-models)).
- **Checking transcripts** a minute at a time (speakers, then words), with what's left to check on each meeting.
- **Search** across transcripts (on your computer).

## Videos

- **A movie editor** for clips of any meetings: a timeline with thumbnails, trimming, splitting, a sound track with
  volume, and who is speaking ([clips and videos](hub/hub.md#clips-and-videos)).
- **Overlays**: who is speaking, the body, the chapter, the time of day, and votes, fading in and out as they change.
- **Layers** with keyframes: QR codes (from a library of links and the meetings' documents, with a title, colors, and
  error correction), a QR code to the official video that changes each second, pictures panned and zoomed, picture in
  picture, and blurred, pixelated, or blacked-out areas (as for children in the audience).
- **Rendering** by an agent from the original recordings: 720p for the web or 1080p production, to the hub as a public
  page or to a folder on the agent; a notification says when it's ready.

## Publishing and sharing

- **Meetings stay private** on the hub, for the people you allow; publish notes, summaries, transcript excerpts, clips,
  and videos for everyone, each linked to the official sources ([publishing](hub/hub.md#publishing)).
- **Podcast** of meetings' audio ([publish-media](media/publish-media.md)).
- **Accounts and groups** with permissions; contributions from trusted people show for everyone, others' only for
  them; an admin can preview the site as the public sees it ([people, groups, and layers](hub/hub.md#people-groups-and-layers)).
- **A static site** on GitHub Pages, alone (data in each visitor's browser) or connected to a hub
  ([the web app as a static site](hub/hub.md#the-web-app-as-a-static-site)).
