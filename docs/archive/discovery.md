# Finding past meetings

Agents can find a source's past (and coming) meetings, put them on the schedule, and start making them workable,
without downloading whole videos. Everything about a place is configuration: each source's record on the hub says where
its meetings are found. The code knows only kinds of feeds.

## Setting it up

On the **Sources** page (Manage menu, for people who may edit sources), add a source (its name and time zone) and its
**feeds**:

| Feed            | Settings                                                                                                                    | Finds                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Swagit archive  | the site (`https://<name>.new.swagit.com`) and its archive view numbers (the `/views/<n>/` page a government's site frames) | every archived video: its title, category, date, and length                                          |
| YouTube channel | the channel's address and a pattern for titles (`Trustee\|Meeting`)                                                         | the channel's videos whose titles match (all of them with `yt-dlp` on the agent, else the latest 15) |
| Calendar (iCal) | the calendar's iCal address and a pattern for event names (`Committee\|Board`)                                              | the matching events, with their times                                                                |
| Dates on a page | the page, the meeting's name, and the words the schedule follows (`Board Meetings`)                                         | each date written on the page                                                                        |

Every feed can also say the usual time (for meetings found without one), a category (to match a public body by), and
**Not streamed live** (for bodies that post recordings later, or never stream). **Find meetings now** queues the work
for an agent.

## What agents do

- **`discover`** reads the source's feeds. Each meeting found becomes a one-off schedule on its day (once: corrections
  to it are kept), matched to a public body by the bodies' meeting rules (the source, and words in the title or
  category), at the body's usual time when the feed didn't say. A meeting with a video elsewhere also gets a meeting
  record (status **Official video**), linked to that video, and its follow-up jobs.
- **`official-transcript`** reads the video's page: the provider's automated captions become the meeting's transcript
  (kind `official`, put in sentence case when written in capitals), its index becomes the meeting's chapters, and its
  agenda is linked.
- **`first-segment`** downloads only the first piece of the video's stream (about 10 seconds) and saves a picture from
  it, so the meeting has a still and its room and camera can be seen.

Requests go through the usual robots.txt check and rate limits. A meeting's page shows the provider's captions until a
transcript of its own is made; the Schedules page pages back through the months (**‹ Earlier**).

Files: `src/discovery/` (the feeds), `src/recorder/discovery.js` (the jobs).
