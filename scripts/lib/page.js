import path from 'path';
import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { LOCALE, SOURCES } from './runtime-config.js';
import { loadSessionSegments } from './session.js';
import { loadJson } from './fs-utils.js';
import { formatPosition } from './transcript.js';

// Thumbnail file name for a video position: HH-MM-SS.jpg, with milliseconds when the position isn't whole.
export function thumbnailFileName(position) {
  const fraction = Math.round((position % 1) * 1000);
  return `${formatPosition(position).replace(/:/g, '-')}${fraction ? `.${String(fraction).padStart(3, '0')}` : ''}.jpg`;
}

const serverPort = 4873;

// Writes {session}/playback.m3u8 (an HLS playlist of the captured segments, for the page's player) and
// {session}/thumbnails/index.html.
export async function writeThumbnailsPage(sessionDir, thumbnails) {
  // Camera and slide changes found by extract-thumbnails (thumbnails/scenes.json), if any.
  const sceneIndex = await loadJson(path.join(sessionDir, 'thumbnails', 'scenes.json'), null);
  const scenes = (sceneIndex?.scenes || []).map((scene) => [scene.positionSeconds, scene.fileName]);
  const session = await loadSessionSegments(sessionDir);
  const maxDuration = Math.ceil(Math.max(1, ...session.retained.map((item) => item.durationSeconds)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${maxDuration}`, '#EXT-X-MEDIA-SEQUENCE:0'];
  session.retained.forEach((item, index) => {
    // A missed or discarded moment breaks the stream's timestamps, which players need flagged (as does each
    // switch between the live capture and the archive in a meeting built by build-meeting).
    if (index > 0 && (item.sequence !== session.retained[index - 1].sequence + 1 || item.discontinuity)) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push(`#EXTINF:${item.durationSeconds.toFixed(3)},`, `segments/${encodeURIComponent(item.fileName)}`);
  });
  lines.push('#EXT-X-ENDLIST');
  await writeFile(path.join(sessionDir, 'playback.m3u8'), `${lines.join('\n')}\n`);

  const segments = session.retained.map((item) => [Number(item.audioStart.toFixed(3)), Number(item.videoStart.toFixed(3)), item.durationSeconds]);
  // When each stretch's position zero aired, in milliseconds: [[start position, ms], ...].
  const clocks = session.clockRuns.filter((run) => run.zero !== null).map((run) => [Number(run.start.toFixed(3)), Math.round(run.zero * 1000)]);
  // The final transcript, built into the page; served pages also load the latest one at runtime.
  const transcript = await loadJson(path.join(sessionDir, 'transcripts', 'latest.json'), null);
  const transcriptLines = (transcript?.lines || []).map((line) => [Number(Number(line.startSeconds).toFixed(2)), Number(Number(line.endSeconds).toFixed(2)), line.text, line.retranscribed ? 1 : 0]);
  // Speaker marks for this session, and the roster of people (shared by every meeting from the source).
  const peopleDir = findPeopleDir(sessionDir);
  const speakers = await loadJson(path.join(sessionDir, 'speakers.json'), null);
  const meetingInfo = await loadJson(path.join(sessionDir, 'meeting-info.json'), null);
  const agenda = await loadJson(path.join(sessionDir, 'agenda.json'), null);
  const votes = await loadJson(path.join(sessionDir, 'votes.json'), null);
  const views = await loadJson(path.join(sessionDir, 'views.json'), null);
  const audioBoosts = await loadJson(path.join(sessionDir, 'audio-boosts.json'), null);
  const roster = await loadJson(path.join(peopleDir, 'people.json'), null);
  const peopleUrl = path.relative(path.join(sessionDir, 'thumbnails'), peopleDir).split(path.sep).map(encodeURIComponent).join('/');
  // A session that is part of a full meeting links to it; a full meeting describes where its video comes from.
  const fullMeeting = await loadJson(path.join(sessionDir, 'full-meeting.json'), null);
  const fullMeetingUrl = fullMeeting?.meetingDir
    ? path.relative(path.join(sessionDir, 'thumbnails'), path.join(fullMeeting.meetingDir, 'thumbnails', 'index.html')).split(path.sep).map(encodeURIComponent).join('/')
    : '';
  await writeFile(path.join(sessionDir, 'thumbnails', 'index.html'), renderScrubber(thumbnails, sessionDir, {
    segments, serverUrl: findServerUrl(sessionDir), transcriptLines, scenes, clocks,
    turns: speakers?.turns || [], people: roster?.people || [], peopleGroups: roster?.groups || null, peopleUrl, fullMeetingUrl, boosts: audioBoosts?.boosts || [], meetingName: meetingInfo?.name || '', agenda: agenda?.items || [], votes: { members: votes?.members || [], votes: votes?.votes || [], seats: votes?.seats ?? null, needed: votes?.needed ?? null }, views: { views: views?.views || [], sceneViews: views?.sceneViews || {} }
  }));
}


function findSource(sessionDir) {
  return SOURCES.find((item) => !path.relative(item.storageDir, sessionDir).startsWith('..'));
}

// {source storage}/people: names, roles, and face crops of the people who speak at its meetings.
export function findPeopleDir(sessionDir) {
  const source = findSource(sessionDir);
  return source ? path.join(source.storageDir, 'people') : path.join(sessionDir, 'people');
}

// The same page on `npm run serve`, where the player can load the segments (browsers block that on file://).
function findServerUrl(sessionDir) {
  const source = findSource(sessionDir);
  if (!source) {
    return '';
  }
  const slug = String(source.key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const relative = path.relative(source.storageDir, sessionDir).split(path.sep).map(encodeURIComponent).join('/');
  return `http://127.0.0.1:${serverPort}/${slug}/${relative}/thumbnails/index.html`;
}

const escapeText = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The thumbnails page: a player (with the slider as its scrubber), a grid at a chosen density, and a clip builder.
// Move to a moment (play, drag the slider, or click a thumbnail), press "Clip start", move again, press "Clip end",
// and the `npm run extract-clip` command for that range appears, ready to copy.
export function renderScrubber(thumbnails, sessionDir = '', playback = { segments: [], serverUrl: '', transcriptLines: [] }) {
  const clock = (iso) => (iso
    ? new Intl.DateTimeFormat('en-US', { timeZone: LOCALE.timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso))
    : '');
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sessionArg = sessionDir ? path.relative(repoRoot, sessionDir) || '.' : '<session folder>';
  // Clock time for any position: from the session's clock origins, or else the first thumbnail's clock time minus
  // its position.
  const anchor = thumbnails.find((item) => item.clockTime);
  const clocks = playback.clocks?.length ? playback.clocks : (anchor ? [[0, Date.parse(anchor.clockTime) - (anchor.positionSeconds * 1000)]] : []);
  const data = JSON.stringify({
    thumbs: thumbnails.map((item) => ({ f: item.fileName, s: item.positionSeconds, c: clock(item.clockTime), l: item.level })),
    segments: playback.segments,
    serverUrl: playback.serverUrl,
    transcript: playback.transcriptLines || [],
    scenes: playback.scenes || [],
    turns: playback.turns || [],
    boosts: playback.boosts || [],
    meetingName: playback.meetingName || '',
    agenda: playback.agenda || [],
    votes: playback.votes || { members: [], votes: [] },
    views: playback.views || { views: [], sceneViews: {} },
    people: playback.people || [],
    peopleGroups: playback.peopleGroups || null,
    peopleUrl: playback.peopleUrl || '../people',
    sessionArg,
    clocks,
    timeZone: LOCALE.timeZone
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${playback.meetingName ? escapeText(playback.meetingName) : 'Meeting Thumbnails'}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f4; --fg: #1d1d1b; --muted: #66665f; --card: #ffffff; --line: #d9d9d3;
    --start: #1f7a4d; --end: #b3261e; --code: #ecece8; --note: #fff4d6; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --fg: #ececea; --muted: #a2a29b; --card: #222220; --line: #3a3a37;
    --start: #4fbf87; --end: #f07167; --code: #2b2b29; --note: #3a3222; } }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 16px 48px; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
  main { max-width: 1560px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 1.4rem; }
  .sub { margin: 0 0 16px; color: var(--muted); }
  .stage { position: relative; max-width: 960px; aspect-ratio: 16 / 9; background: #000; border-radius: 6px; overflow: hidden; container-type: inline-size; }
  /* Clicking the video plays or pauses it; hovering shows which, except over the overlays that do something else. */
  .stage { cursor: pointer; }
  .stage-play { position: absolute; left: 50%; top: 50%; width: 72px; height: 72px; margin: -36px 0 0 -36px; display: flex; align-items: center;
    justify-content: center; border-radius: 50%; background: rgba(0, 0, 0, 0.5); color: #fff; font-size: 30px; opacity: 0; transition: opacity 0.15s ease;
    pointer-events: none; z-index: 1; }
  .stage:hover .stage-play { opacity: 0.9; }
  .stage:has(.vote-overlay:hover, .title-overlay:hover, .agenda-overlay:hover, .speaker-cards:hover, .overlay:hover) .stage-play { opacity: 0; }
  /* Overlays can be dragged anywhere on the video; their text size scales with the video (and the size set in 🎛). */
  .movable { cursor: move; touch-action: none; z-index: 2; }
  .movable.dragging { outline: 2px dashed rgba(255, 255, 255, 0.8); outline-offset: 2px; cursor: grabbing; }
  .stage > img, .stage > video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  /* Magnifier: chosen squares of the picture drawn larger in place, over the video (the rest stays visible). */
  .magnifier { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }
  .zoom-select { position: absolute; border: 2px dashed #fff; background: rgba(255, 255, 255, 0.12); pointer-events: none; z-index: 3; }
  .zoom-select[hidden] { display: none; }
  .stage.selecting { cursor: crosshair; }
  .view-chip { position: absolute; left: 6px; top: 6px; max-width: calc(100% - 12px); padding: 1px 4px; border-radius: 4px; border: 0; font-size: 0.75rem;
    color: #fff; background: rgba(0, 0, 0, 0.65); }
  #zoom-canvas { display: block; width: 100%; height: auto; margin: 8px 0; cursor: crosshair; touch-action: none; border-radius: 6px; background: #000; }
  .zoom-people { display: flex; flex-wrap: wrap; gap: 6px; }
  .zoom-people button { display: inline-flex; align-items: center; gap: 6px; padding: 3px 8px 3px 3px; border-radius: 999px; }
  .zoom-people button .avatar { width: 24px; height: 24px; font-size: 0.6rem; }
  #zoom-edit-source.on, #zoom-edit-copy.on { border-color: #ffd166; background: color-mix(in srgb, #ffd166 22%, var(--card)); font-weight: 600; }
  .zoom-people button.on { border-color: #ffd166; background: color-mix(in srgb, #ffd166 22%, var(--card)); }
  .zoom-people button.has-area::after { content: '▢'; color: var(--start); }
  #zoom-dialog { width: min(900px, calc(100vw - 32px)); }
  #zoom-toggle.on { border-color: var(--start); color: var(--start); }
  .stage > video[hidden], .stage > img[hidden] { display: none; }
  .overlay { position: absolute; right: 2.5%; bottom: 3.5%; padding: 0.3em 0.6em; background: rgba(0, 0, 0, 0.65); color: #fff;
    border-radius: 4px; font: 600 calc(clamp(9px, 2.3cqw, 22px) * var(--s, 1))/1.25 system-ui, sans-serif; font-variant-numeric: tabular-nums; text-align: right; }
  .overlay small { display: block; font-weight: 400; opacity: 0.8; font-size: 0.75em; }
  .overlay small.alone { font-weight: 600; opacity: 1; font-size: 1em; }
  .overlay [hidden] { display: none; }
  .overlay[hidden] { display: none; }
  /* The video up to 960px; the transcript takes the rest of a wide window (at least 420px). */
  .player-layout { display: grid; grid-template-columns: minmax(0, 960px) minmax(420px, 1fr); gap: 16px; align-items: stretch; }
  .player-main { min-width: 0; }
  /* Beside the video: as tall as the window and pinned while the page scrolls, so long agenda or vote lists under the
     video don't stretch it. */
  .transcript { position: sticky; top: 8px; align-self: start; height: calc(100vh - 16px); max-height: calc(100vh - 16px); min-height: 320px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .transcript[hidden] { display: none; }
  .transcript-head { display: flex; gap: 6px; align-items: center; padding: 8px; border-bottom: 1px solid var(--line); }
  .transcript-head input { flex: 1; min-width: 0; }
  .transcript-body { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .transcript-list { flex: 1; min-height: 0; overflow-y: auto; padding: 0 0 4px; }
  .now-scene { position: relative; flex: 0 0 auto; margin: 0; background: #000; border-bottom: 1px solid var(--line); cursor: pointer; }
  .now-scene[hidden] { display: none; }
  .now-scene img { display: block; width: 100%; height: auto; }
  .now-scene figcaption { position: absolute; left: 6px; bottom: 6px; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem; color: #fff; background: rgba(0, 0, 0, 0.65); font-variant-numeric: tabular-nums; }
  .transcript-list p { margin: 0; padding: 4px 10px; cursor: pointer; border-left: 3px solid transparent; }
  .transcript-list p:hover { background: color-mix(in srgb, var(--fg) 6%, transparent); }
  .transcript-list p.active { background: color-mix(in srgb, var(--start) 16%, transparent); border-left-color: var(--start); }
  .transcript-list p.match { box-shadow: inset 0 0 0 2px var(--end); }
  .transcript-list section { position: relative; }
  .transcript-list figure { position: relative; width: 160px; margin: 6px 10px; cursor: pointer; }
  .transcript-list figure img { display: block; width: 100%; height: auto; border-radius: 4px; background: #000; }
  .transcript-list figcaption { position: absolute; left: 4px; bottom: 4px; padding: 1px 5px; border-radius: 4px; font-size: 0.7rem; color: #fff; background: rgba(0, 0, 0, 0.65); font-variant-numeric: tabular-nums; }
  .transcript-list p.has-who { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 8px; }
  .transcript-list p.has-who > time, .transcript-list p.has-who > span:not(.who) { grid-column: 1; }
  .who { grid-column: 2; grid-row: 1 / span 2; display: flex; gap: 4px; align-self: start; }
  .who > span { display: flex; flex-direction: column; align-items: center; width: 52px; }
  .who .avatar { width: 36px; height: 36px; }
  .who-person, .figure-speakers .avatar { cursor: pointer; }
  .who-person:hover .avatar, .figure-speakers .avatar:hover { outline: 2px solid var(--end); outline-offset: 1px; }
  .who small { max-width: 52px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.7rem; color: var(--muted); }
  .avatar.icon { background: color-mix(in srgb, var(--fg) 14%, #445); font-size: 1.15em; line-height: 1; }
  .avatar { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; width: 32px; height: 32px; border-radius: 50%;
    object-fit: cover; background: color-mix(in srgb, var(--start) 35%, #777); color: #fff; font-size: 0.8em; font-weight: 600; }
  .title-overlay, .agenda-overlay { position: absolute; left: 2.5%; top: 3.5%; max-width: 38%; padding: 0.3em 0.7em; background: rgba(0, 0, 0, 0.65);
    color: #fff; border-radius: 4px; font: 600 calc(clamp(9px, 2.1cqw, 20px) * var(--s, 1))/1.25 system-ui, sans-serif; }
  .agenda-overlay { font-weight: 400; font-size: calc(clamp(8px, 1.8cqw, 17px) * var(--s, 1)); }
  .title-overlay[hidden], .agenda-overlay[hidden] { display: none; }
  .title-overlay.placeholder { font-weight: 400; font-style: italic; opacity: 0.75; }
  /* Text on the video that can be edited in place: hinted on hover. */
  .editable-text { cursor: text; }
  .editable-text:hover { text-decoration: underline dotted; text-underline-offset: 0.2em; }
  .editable-text:hover::after { content: ' ✎'; opacity: 0.8; }
  .inline-edit { width: 100%; min-width: 12em; font: inherit; color: #fff; background: rgba(0, 0, 0, 0.6); border: 1px solid #fff; border-radius: 3px; padding: 0 0.2em; }
  .speaker-cards { position: absolute; left: 2.5%; bottom: 3.5%; display: flex; flex-direction: column; align-items: flex-start; gap: 0.4em;
    font: calc(clamp(9px, 2.1cqw, 20px) * var(--s, 1))/1.2 system-ui, sans-serif; }
  .speaker-cards[hidden] { display: none; }
  .speaker-card { display: flex; align-items: center; gap: 0.5em; padding: 0.3em 0.9em 0.3em 0.3em; background: rgba(0, 0, 0, 0.65); color: #fff; border-radius: 999px; }
  .speaker-card .avatar { width: 2.4em; height: 2.4em; font-size: 1em; }
  .speaker-card strong { display: block; }
  .speaker-card small { display: block; opacity: 0.8; font-size: 0.75em; }
  .speakers-panel { max-width: 960px; margin: 8px 0; padding: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .speakers-panel[hidden] { display: none; }
  .people { display: flex; flex-direction: column; gap: 8px; margin: 8px 0; }
  .people-section { padding: 6px 8px; border: 1px dashed var(--line); border-radius: 8px; }
  .people-section.voting { border: 2px solid var(--start); background: color-mix(in srgb, var(--start) 8%, var(--card)); }
  .people-section.drop { border-style: solid; border-color: var(--end); background: color-mix(in srgb, var(--end) 8%, var(--card)); }
  .people-section h3 { display: flex; gap: 6px; align-items: center; margin: 0 0 6px; font-size: 0.85rem; color: var(--muted); }
  .people-section h3 .group-name { cursor: text; }
  .people-section h3 .group-name:hover { text-decoration: underline dotted; }
  .people-section h3 button { padding: 0 6px; font-size: 0.75rem; }
  .people-chips { display: flex; flex-wrap: wrap; gap: 6px; min-height: 36px; }
  .people-chips:empty::after { content: 'Drag people here'; color: var(--muted); font-size: 0.8rem; align-self: center; }
  .person-chip { display: inline-flex; position: relative; cursor: grab; }
  /* Icons: each group is a compact block (its name above its circles), side by side. */
  .people.icons-only { flex-direction: row; flex-wrap: wrap; align-items: flex-start; }
  .people.icons-only .people-section { flex: 0 0 auto; max-width: 100%; padding: 4px 6px; }
  .people.icons-only .people-section h3 { margin-bottom: 4px; white-space: nowrap; }
  .people.icons-only .people-chips { gap: 4px; min-height: 30px; min-width: 60px; }
  .people.icons-only .people-chips:empty::after { content: 'Drag here'; }
  .people.icons-only .person .person-text { display: none; }
  .people.icons-only .person { padding: 3px; border-radius: 50%; }
  .people.icons-only .person-chip .edit { display: none; position: absolute; right: -6px; top: -6px; padding: 0 5px; border-radius: 999px; border-left: 1px solid var(--line); font-size: 0.7rem; z-index: 1; }
  .people.icons-only .person-chip:hover .edit { display: inline-block; }
  .people-toolbar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .people-toolbar button.on { border-color: var(--start); color: var(--start); font-weight: 600; }
  .person { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px 4px 4px; border-radius: 999px 0 0 999px; text-align: left; }
  .person small { display: block; color: var(--muted); font-size: 0.75rem; }
  .person[aria-pressed=true] { border-color: var(--start); background: color-mix(in srgb, var(--start) 18%, var(--card)); }
  .person-chip .edit { border-left: 0; border-radius: 0 999px 999px 0; padding: 4px 10px; color: var(--muted); }
  .person-chip .times { border-left: 0; border-radius: 0; padding: 4px 8px; color: var(--muted); }
  .people.icons-only .person-chip .times { display: none; position: absolute; left: -6px; top: -6px; padding: 0 5px; border-radius: 999px; border-left: 1px solid var(--line); font-size: 0.7rem; z-index: 1; }
  .people.icons-only .person-chip:hover .times { display: inline-block; }
  #spoke-dialog { position: fixed; inset: 72px 16px auto auto; margin: 0; width: min(560px, calc(100vw - 32px)); max-height: 80vh; overflow: auto; z-index: 20;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); }
  .spoke-bar { position: relative; height: 18px; margin: 8px 0; background: color-mix(in srgb, var(--fg) 8%, var(--card)); border-radius: 4px; overflow: hidden; cursor: pointer; }
  .spoke-bar span { position: absolute; top: 0; bottom: 0; min-width: 2px; background: var(--start); }
  .spoke-bar span.now { background: var(--end); }
  .spoke-bar i { position: absolute; top: -2px; bottom: -2px; width: 2px; background: var(--fg); }
  #spoke-list li.current { background: color-mix(in srgb, var(--end) 14%, transparent); }
  #spoke-list .spoke-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 0.85rem; }
  dialog { max-width: min(900px, calc(100vw - 32px)); width: 100%; background: var(--card); color: var(--fg); border: 1px solid var(--line); border-radius: 10px; }
  dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
  dialog h2 { margin: 0 0 8px; font-size: 1.1rem; }
  dialog input[type=text] { min-width: 16em; }
  #crop-canvas { display: block; width: 100%; height: auto; margin: 8px 0; cursor: move; touch-action: none; border-radius: 6px; }
  #crop-canvas[hidden], #person-photo[hidden] { display: none; }
  #person-photo { display: block; width: 128px; height: 128px; margin: 8px 0; border-radius: 50%; }
  .figure-speakers { position: absolute; right: 6px; bottom: 6px; display: flex; gap: 4px; }
  .figure-speakers .avatar { width: 48px; height: 48px; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.6); font-size: 1rem; }
  .transcript-list p.retranscribed time::after { content: '  🔊 re-transcribed'; }
  #boost-dialog .row label { display: inline-flex; gap: 6px; align-items: center; }
  #boost-dialog input[type=text] { width: 7.5em; min-width: 0; font-variant-numeric: tabular-nums; }
  #boost-dialog input[type=range] { width: 220px; margin: 0; }
  #boost-dialog audio { width: 100%; margin: 6px 0; }
  #boost-dialog audio[hidden] { display: none; }
  .wave { margin: 6px 0; }
  .wave canvas { display: block; width: 100%; height: 110px; background: #111; border-radius: 6px; cursor: ew-resize; touch-action: none; }
  .wave-labels { display: flex; justify-content: space-between; gap: 8px; font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .wave button { margin-top: 4px; padding: 2px 8px; font-size: 0.8rem; }
  .transcript-list p { position: relative; }
  .line-boost { display: none; margin-left: 6px; padding: 0 6px; font-size: 0.75rem; line-height: 1.4; vertical-align: baseline; }
  .transcript-list p:hover .line-boost { display: inline-block; }
  .portions { margin: 6px 0 0; padding: 0; list-style: none; font-size: 0.9rem; }
  .portions li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 4px 0; border-top: 1px solid var(--line); }
  .transcript-list h3.agenda-heading { margin: 10px 10px 2px; padding: 6px 10px; font-size: 0.95rem; background: color-mix(in srgb, var(--end) 12%, var(--card));
    border-left: 4px solid var(--end); border-radius: 4px; cursor: pointer; }
  .transcript-list h3.agenda-heading small { display: block; font-weight: 400; font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .agenda-panel[hidden] { display: none; }
  .agenda-panel { max-width: 960px; margin: 8px 0; padding: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .agenda-panel h2 { margin: 0 0 6px; font-size: 1.05rem; }
  .agenda-list { position: relative; max-height: 40vh; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
  .agenda-list li { display: flex; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 4px; }
  .agenda-list li.current { background: color-mix(in srgb, var(--end) 14%, transparent); }
  .agenda-list li > button.go { flex: 1; text-align: left; border: 0; background: none; padding: 4px 2px; }
  #vote-list li > button.go { display: flex; gap: 8px; align-items: center; }
  .agenda-list .vote-text { flex: 1; min-width: 0; }
  .vote-faces { display: inline-flex; flex: 0 0 auto; gap: 5px; padding: 4px 7px; border: 2px dashed var(--line); border-radius: 999px; }
  .vote-faces.passed { border: 2px solid #2e9d5b; }
  .vote-faces.failed { border: 2px dotted #d33b2f; }
  .vote-face { position: relative; display: inline-flex; }
  .vote-face .avatar { width: 26px; height: 26px; font-size: 0.65rem; }
  .vote-face.absent { opacity: 0.35; }
  .vote-face.pending { opacity: 0.6; }
  .vote-face .vote-badge { right: -4px; bottom: -4px; top: auto; width: 13px; height: 13px; font-size: 8px; border-width: 1px; }
  .vote-order { position: absolute; top: -6px; right: -6px; display: flex; align-items: center; justify-content: center; min-width: 13px; height: 13px;
    padding: 0 2px; border: 1px solid #000; border-radius: 999px; background: #fff; color: #000; font-size: 8px; font-weight: 700; line-height: 1; }
  .agenda-list li > button.go time { display: inline-block; min-width: 5.5em; color: var(--muted); font-variant-numeric: tabular-nums; }
  .agenda-list li > button.small { padding: 2px 8px; }
  #agenda-list { max-height: 28vh; }
  #agenda-list li { padding: 1px 6px; }
  #agenda-list li > button.go { display: flex; gap: 8px; align-items: baseline; padding: 2px; }
  #agenda-list .chapter-title { flex: 1; min-width: 0; }
  .chapter-length { flex: 0 0 auto; color: var(--muted); font-size: 0.8rem; font-variant-numeric: tabular-nums; }
  .agenda-panel form input[type=text] { flex: 1; min-width: 12em; }
  .agenda-panel form input.time { flex: 0 0 7.5em; min-width: 0; font-variant-numeric: tabular-nums; }
  .transcript-list .vote-row { margin: 6px 10px; padding: 5px 10px; font-size: 0.9rem; border-left: 4px solid var(--start); border-radius: 4px; cursor: pointer;
    background: color-mix(in srgb, var(--start) 10%, var(--card)); }
  .vote-overlay { position: absolute; right: 2.5%; top: 3.5%; max-width: 56%; transition: opacity 1s ease; padding: 0.4em 0.6em; background: rgba(0, 0, 0, 0.72); color: #fff; border-radius: 6px;
    font: calc(clamp(8px, 1.6cqw, 16px) * var(--s, 1))/1.2 system-ui, sans-serif; z-index: 2; }
  .vote-overlay[hidden] { display: none; }
  .vote-overlay.fading { opacity: 0; }
  .vote-overlay .vote-member, .vote-overlay .credits > span { cursor: pointer; }
  .vote-overlay .vote-member:hover .avatar, .vote-overlay .credits > span:hover .avatar { outline: 2px solid #fff; outline-offset: 1px; }
  .vote-modes { display: none; flex-wrap: wrap; gap: 0.3em; align-items: center; margin-bottom: 0.35em; font-size: 0.7em; width: 0; min-width: 100%; }
  .vote-overlay:hover .vote-modes, .vote-overlay.editing .vote-modes { display: flex; }
  .vote-modes button { padding: 0.1em 0.6em; color: #fff; background: rgba(255, 255, 255, 0.12); border: 1px solid rgba(255, 255, 255, 0.45); border-radius: 999px; font-size: 1em; }
  .vote-modes button.on { color: #000; background: #fff; }
  /* The row of members sets the panel's width; the motion and other text wrap within it instead of widening it. */
  .vote-overlay .motion { font-weight: 600; margin-bottom: 0.35em; width: 0; min-width: 100%; overflow-wrap: anywhere;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }
  .vote-overlay .motion.editing-inline { display: block; -webkit-line-clamp: none; }
  .vote-overlay .members { display: flex; flex-wrap: nowrap; gap: 0.55em; }
  .vote-member { display: flex; flex-direction: column; align-items: center; min-width: 3em; }
  .vote-member .face { position: relative; display: inline-flex; }
  .vote-member .avatar { width: 2.3em; height: 2.3em; font-size: 0.85em; }
  .vote-member.absent { opacity: 0.4; }
  .vote-member small { white-space: nowrap; font-size: 0.72em; line-height: 1.15; }
  .vote-member small.district { font-size: 0.62em; opacity: 0.8; }
  .vote-badge { position: absolute; right: -0.45em; bottom: -0.3em; display: flex; align-items: center; justify-content: center; width: 1.25em; height: 1.25em;
    border-radius: 50%; border: 2px solid #000; color: #fff; font-size: 0.75em; font-weight: 700; }
  .vote-badge.choice-for { background: #2e9d5b; }
  .vote-badge.choice-against { background: #d33b2f; }
  .vote-badge.choice-abstain { background: #888; }
  .vote-overlay .outcome { margin-top: 0.35em; font-weight: 700; width: 0; min-width: 100%; }
  .vote-overlay .outcome.passed { color: #7ee2a1; }
  .vote-overlay .outcome.failed { color: #ff9c94; }
  .member-list { margin: 6px 0 0; padding: 0; list-style: none; }
  .member-list li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 4px 0; border-top: 1px solid var(--line); }
  .member-list label { display: inline-flex; gap: 8px; align-items: center; min-width: 16em; }
  .member-list button { padding: 2px 8px; }
  .seat-order { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; padding: 0; list-style: none; }
  .seat-order li { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 4px 6px; border: 1px solid var(--line); border-radius: 6px; min-width: 88px; }
  .seat-order li small { color: var(--muted); font-size: 0.72rem; }
  .seat-order li div { display: flex; gap: 4px; }
  .seat-order button { padding: 0 8px; }
  #members-panel[hidden] { display: none; }
  #vote-members { margin: 8px 0; display: flex; flex-wrap: wrap; gap: 8px; }
  .vote-toggle { display: flex; flex-direction: column; align-items: center; gap: 2px; width: 118px; padding: 6px 4px; position: relative; }
  .vote-toggle .avatar { width: 44px; height: 44px; font-size: 1rem; }
  .vote-toggle strong { font-size: 0.85rem; }
  .vote-toggle small { font-size: 0.72rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  .vote-toggle.choice-for { border-color: #2e9d5b; background: color-mix(in srgb, #2e9d5b 18%, var(--card)); }
  .vote-toggle.choice-against { border-color: #d33b2f; background: color-mix(in srgb, #d33b2f 18%, var(--card)); }
  .vote-toggle.choice-abstain { border-color: #888; background: color-mix(in srgb, #888 18%, var(--card)); }
  .vote-toggle.choice-absent { opacity: 0.55; }
  .vote-member.pending { opacity: 0.7; }
  .vote-overlay .outcome.pending { color: #ffe08a; }
  .vote-member-undo { padding: 0 6px; font-size: 0.75rem; }
  .vote-member-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 4px 0; border-top: 1px solid var(--line); }
  .vote-member-row > span { display: inline-flex; gap: 8px; align-items: center; min-width: 14em; }
  .vote-member-row label { display: inline-flex; gap: 4px; align-items: center; }
  #vote-dialog input[type=number] { width: 5em; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 6px; }
  #vote-dialog input.time { width: 7.5em; min-width: 0; }
  #vote-motion { width: 100%; }
  #vote-dialog { position: fixed; inset: auto 16px 16px auto; margin: 0; width: min(720px, calc(100vw - 32px)); max-height: 85vh; overflow: auto;
    z-index: 10; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); }
  .vote-overlay .credits { display: flex; flex-wrap: wrap; gap: 0.3em 0.8em; align-items: center; margin-bottom: 0.4em; font-size: 0.8em; opacity: 0.95; width: 0; min-width: 100%; }
  .vote-overlay .credits span { display: inline-flex; align-items: center; gap: 0.3em; }
  .vote-overlay .credits .avatar { width: 1.6em; height: 1.6em; font-size: 0.75em; }
  .transcript-list time { display: block; font-size: 0.75rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  @media (max-width: 1100px) {
    .player-layout { grid-template-columns: minmax(0, 1fr); }
    .transcript { position: relative; top: auto; height: 360px; }
  }
  .freeze { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .freeze[hidden] { display: none; }
  .frames-panel { max-width: 960px; margin: 8px 0; padding: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
  .frames-panel[hidden] { display: none; }
  .frames { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 6px; scroll-snap-type: x proximity; }
  .frames button { flex: 0 0 auto; width: 150px; padding: 0; overflow: hidden; scroll-snap-align: center; text-align: center; font-size: 0.75rem; color: var(--muted); }
  .frames canvas { display: block; width: 150px; height: auto; background: #000; }
  .frames span { display: block; padding: 2px 4px; font-variant-numeric: tabular-nums; }
  .frames button.current { outline: 3px solid var(--start); }
  input[type=range] { width: 100%; max-width: 960px; margin: 12px 0 4px; }
  .scrub { display: flex; gap: 8px; align-items: center; max-width: 960px; margin: 8px 0 2px; }
  .scrub input[type=range] { width: 100%; margin: 0; }
  .scrub .track { flex: 1; min-width: 0; }
  /* Chapter scope: markers above the scrubber (inset by the slider thumb's radius so they line up with it). */
  .scrub-marks { margin: 0 8px -5px; }
  .scrub-marks[hidden] { display: none; }
  .scrub-marks .lane { position: relative; }
  .speakers-lane { height: 22px; margin-bottom: -16px; }
  .events-lane { height: 16px; }
  .events-lane .scrub-mark { bottom: 4px; }
  .scrub-mark { position: absolute; bottom: 0; transform: translateX(-50%); display: inline-flex; align-items: center; padding: 0; border: 0; background: none;
    cursor: pointer; line-height: 1; }
  .scrub-mark .avatar { width: 20px; height: 20px; font-size: 0.55rem; box-shadow: 0 0 0 1px var(--card); }
  .scrub-mark .more { margin-left: -4px; padding: 0 3px; border-radius: 999px; background: var(--fg); color: var(--bg); font-size: 0.6rem; }
  .scrub-mark.event { font-size: 0.85rem; }
  .scrub-mark.vote-mark { padding: 1px; border-radius: 50%; border: 2px dashed var(--line); }
  .scrub-mark.vote-mark.passed { border: 2px solid #2e9d5b; }
  .scrub-mark.vote-mark.failed { border: 2px dotted #d33b2f; }
  .scrub button { flex: 0 0 auto; padding: 3px 8px; font-size: 0.8rem; white-space: nowrap; }
  /* The clip range on the scrubber: a highlight between the start and end, and a marker above each. Positions are
     inset by the slider thumb's radius (8px) so they line up with the track. */
  .slider-wrap { position: relative; }
  .cut-band { position: absolute; top: 50%; height: 6px; margin-top: -3px; border-radius: 3px; background: rgba(255, 209, 102, 0.75); pointer-events: none; z-index: 1; }
  .cut-band[hidden], .cut-mark[hidden] { display: none; }
  .cut-mark { position: absolute; top: -12px; transform: translateX(-50%); padding: 0; border: 0; background: none; font-size: 11px; line-height: 1; cursor: pointer; z-index: 2; }
  .cut-mark.start-mark { color: var(--start); }
  .cut-mark.end-mark { color: var(--end); }
  #set-start { color: var(--start); }
  #set-end { color: var(--end); }
  /* In chapter scope the scrubber takes a different color, so it's clear it covers only the chapter. */
  #slider.chapter-scope { accent-color: #7c5cff; }
  .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
  /* One row of player controls under the slider; scrolls sideways instead of wrapping on narrow screens. */
  .toolbar { display: flex; flex-wrap: nowrap; gap: 4px; align-items: center; max-width: 960px; margin: 2px 0 6px; overflow-x: auto; }
  .toolbar button { flex: 0 0 auto; min-width: 36px; padding: 5px 8px; line-height: 1.2; }
  .toolbar button[hidden] { display: none; }
  .button-group { display: inline-flex; flex: 0 0 auto; }
  .button-group button { border-radius: 0; min-width: 28px; }
  .button-group button + button { border-left: 0; }
  .button-group button:first-child { border-radius: 6px 0 0 6px; }
  .button-group button:last-child { border-radius: 0 6px 6px 0; }
  .find-buttons button { padding: 4px 8px; }
  .transcript-empty { margin: 10px; color: var(--muted); font-size: 0.9rem; }
  .toolbar .sep { flex: 0 0 1px; align-self: stretch; margin: 2px 4px; background: var(--line); }
  .toolbar .position { min-width: 0; flex: 0 0 auto; }
  .toolbar .boost-active { flex: 0 0 auto; font-size: 0.85rem; }
  .toolbar .status { flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85rem; }
  .settings { display: grid; gap: 8px; margin: 4px 0 12px; }
  .settings label { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .settings .hint { font-size: 0.8rem; }
  .settings input[type=range] { width: 110px; margin: 0; }
  .settings .size { font-size: 0.8rem; color: var(--muted); min-width: 3.2em; font-variant-numeric: tabular-nums; }
  /* Not modal: opens in the top right corner without dimming the page, so overlays can be watched (and dragged) while
     adjusting them. Every dialog can be moved by dragging its heading. */
  /* Resizable with the mouse (bottom-right corner). */
  #clip-dialog { position: fixed; inset: 72px 16px auto auto; margin: 0; width: min(720px, calc(100vw - 32px)); max-width: calc(100vw - 16px); min-width: 420px;
    z-index: 20; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); resize: both; overflow: auto; }
  .wave canvas.strip { height: 54px; margin-bottom: 4px; background: #111; cursor: ew-resize; }
  #clip-dialog input.time { width: 7.5em; min-width: 0; font-variant-numeric: tabular-nums; }
  #display-dialog { position: fixed; inset: 72px 16px auto auto; margin: 0; max-width: 520px; width: min(520px, calc(100vw - 32px)); z-index: 20;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); }
  dialog h2.drag-handle { cursor: move; user-select: none; touch-action: none; }
  dialog h2.drag-handle::after { content: '  ⠿'; color: var(--muted); font-weight: 400; }
  .label { color: var(--muted); font-variant-numeric: tabular-nums; }
  .position { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 5.5em; }
  button, select, input[type=text] { font: inherit; color: inherit; background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; }
  button { cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: default; }
  button.start { border-color: var(--start); color: var(--start); font-weight: 600; }
  button.end { border-color: var(--end); color: var(--end); font-weight: 600; }
  .note { max-width: 960px; margin: 8px 0; padding: 8px 12px; background: var(--note); border-radius: 6px; font-size: 0.9rem; overflow-wrap: anywhere; }
  .note code { font-size: 0.85rem; }
  pre { margin: 10px 0 6px; padding: 10px; background: var(--code); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.85rem; }
  .hint { color: var(--muted); font-size: 0.85rem; margin: 0; }
  h2.grid-title { font-size: 1.05rem; margin: 24px 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
  .grid button { padding: 0; overflow: hidden; text-align: left; color: var(--muted); font-size: 0.8rem; }
  .grid img { display: block; width: 100%; height: auto; }
  .grid span { display: block; padding: 3px 6px; font-variant-numeric: tabular-nums; }
  .grid button.in-range { outline: 2px solid color-mix(in srgb, var(--start) 45%, transparent); }
  .grid button.is-start { outline: 3px solid var(--start); }
  .grid button.is-end { outline: 3px solid var(--end); }
</style>
</head>
<body>
<main>
<div class="player-layout">
<div class="player-main">
<div class="stage" id="stage">
  <img id="frame" alt="">
  <video id="video" hidden playsinline preload="none"></video>
  <canvas class="freeze" id="freeze" hidden></canvas>
  <div class="stage-play" id="stage-play" aria-hidden="true">▶︎</div>
  <canvas class="magnifier" id="magnifier"></canvas>
  <div class="zoom-select" id="zoom-select" hidden></div>
  <div class="title-overlay movable" id="title-overlay" hidden></div>
  <div class="agenda-overlay movable" id="agenda-overlay" hidden></div>
  <div class="vote-overlay movable" id="vote-overlay" hidden></div>
  <div class="speaker-cards movable" id="speaker-cards" hidden></div>
  <div class="overlay movable" id="overlay" hidden><span id="overlay-clock"></span><small id="overlay-position"></small></div>
</div>
<div class="scrub">
  <button type="button" id="scope-toggle" title="The scrubber covers the whole meeting: click to cover only the current chapter">↔ All</button>
  <div class="track">
    <div class="scrub-marks" id="scrub-marks" hidden>
      <div class="lane speakers-lane" id="marks-speakers"></div>
      <div class="lane events-lane" id="marks-events"></div>
    </div>
    <div class="slider-wrap">
      <div class="cut-band" id="cut-band" hidden></div>
      <button type="button" class="cut-mark start-mark" id="cut-start-mark" hidden>▼</button>
      <button type="button" class="cut-mark end-mark" id="cut-end-mark" hidden>▼</button>
      <input id="slider" type="range" min="0" value="0" step="0.1" aria-label="Video position">
    </div>
  </div>
</div>
<div class="toolbar" id="toolbar" role="toolbar" aria-label="Player">
  <button type="button" id="play" title="Play or pause (Space)" aria-label="Play">▶︎</button>
  <span class="position" id="position">00:00:00</span>
  <button type="button" id="prev-frame" title="Previous frame (,)" aria-label="Previous frame" hidden>◀</button>
  <button type="button" id="next-frame" title="Next frame (.)" aria-label="Next frame" hidden>▶</button>
  <span class="sep"></span>
  <span class="button-group">
    <button id="set-start" type="button" title="Clip starts here" aria-label="Clip start">✂⟦</button>
    <button type="button" id="clip-open" title="Refine the clip and download it" aria-label="Download clip">🎬</button>
    <button id="set-end" type="button" title="Clip ends here" aria-label="Clip end">⟧✂</button>
  </span>
  <button type="button" id="boost-open" title="Boost the volume of the clip (or the next 30 seconds) and transcribe it again" aria-label="Boost and re-transcribe">🔊</button>
  <span class="sep"></span>
  <button type="button" id="snapshot" title="Save this frame as an image" aria-label="Save this frame as an image">📷</button>
  <button type="button" id="frames-toggle" title="Show the frames around this moment" aria-label="Frames around this moment" hidden>🎞</button>
  <span class="sep"></span>
  <span class="button-group">
    <button type="button" id="speaker-prev" title="Previous speaker change" aria-label="Previous speaker change">◀</button>
    <button type="button" id="speakers-toggle" title="Mark who is speaking" aria-label="Speakers">🗣️</button>
    <button type="button" id="speaker-next" title="Next speaker change" aria-label="Next speaker change">▶</button>
  </span>
  <span class="button-group">
    <button type="button" id="chapter-prev" title="Previous chapter" aria-label="Previous chapter">◀</button>
    <button type="button" id="chapters-toggle" title="Show or hide the chapters" aria-label="Chapters">📑</button>
    <button type="button" id="chapter-next" title="Next chapter" aria-label="Next chapter">▶</button>
  </span>
  <span class="button-group">
    <button type="button" id="vote-prev" title="Previous vote" aria-label="Previous vote">◀</button>
    <button type="button" id="votes-toggle" title="Show or hide the votes" aria-label="Votes">🗳</button>
    <button type="button" id="vote-next" title="Next vote" aria-label="Next vote">▶</button>
  </span>
  <button type="button" id="zoom-toggle" title="Magnify: drag a square on the video to show it larger in place (press again to remove it)" aria-label="Magnify">🔍</button>
  <button type="button" id="display-open" title="What to show on the video, and playback settings" aria-label="Display settings">🎛</button>
  <span class="label boost-active" id="boost-active"></span>
  <span class="label status" id="snapshot-status" role="status"></span>
</div>
<div class="frames-panel" id="frames-panel" hidden>
  <div class="row">
    <label for="frame-spacing" class="label">Frames around this moment, spaced</label>
    <select id="frame-spacing">
      <option value="1">1 frame apart</option>
      <option value="5">5 frames apart</option>
      <option value="15">15 frames apart (½ second)</option>
    </select>
    <button type="button" id="frames-refresh">Re-center here</button>
    <span class="label" id="frames-status" role="status"></span>
  </div>
  <div class="frames" id="frames"></div>
  <p class="hint">Click a frame to jump to it, then press 📷 to save it. ◀ ▶ (or the , and . keys) step one frame.</p>
</div>
<div class="speakers-panel" id="speakers-panel" hidden title="Click people to mark who is speaking from this moment on (click again to unmark). Drag them onto a section to group them; dropping on Voting members makes them vote in this meeting.">
  <div class="people-toolbar">
    <strong>Speaking:</strong> <span id="speakers-now"></span>
    <span style="flex: 1"></span>
    <button type="button" id="people-names" title="Show names and titles">🪪 Names</button>
    <button type="button" id="people-icons" title="Show photos only">🙂 Icons</button>
    <button type="button" id="group-add" title="Add a group, such as VDOT">➕ Group</button>
  </div>
  <div class="people" id="people"></div>
  <p class="hint" id="people-empty">No people yet. Pause on someone while they speak and press Add person.</p>
  <div class="row">
    <button type="button" id="person-add">➕ Add person</button>
    <button type="button" id="speaker-none">Nobody</button>
    <button type="button" id="speaker-remove">Remove the change here</button>
    <span class="label" id="speakers-status" role="status"></span>
  </div>
</div>
<section class="agenda-panel" id="agenda-panel" aria-labelledby="agenda-title">
  <h2 id="agenda-title">Chapters</h2>
  <ol class="agenda-list" id="agenda-list"></ol>
  <p class="hint" id="agenda-empty">No chapters yet. Move to where one starts (an agenda item, for example), type its title, and press Add.</p>
  <form class="row" id="agenda-form">
    <input type="text" id="agenda-time" class="time" placeholder="HH:MM:SS" aria-label="Chapter start time">
    <button type="button" id="agenda-now" title="Use the current position">⏱ Now</button>
    <input type="text" id="agenda-title-input" placeholder="Chapter title, such as 4. Public Comment Period" aria-label="Chapter title">
    <button type="submit" class="start" id="agenda-save">Add</button>
    <button type="button" id="agenda-cancel" hidden>Cancel</button>
    <span class="label" id="agenda-status" role="status"></span>
  </form>
</section>
<section class="agenda-panel" id="votes-panel" aria-labelledby="votes-title">
  <h2 id="votes-title">Votes</h2>
  <ol class="agenda-list" id="vote-list"></ol>
  <p class="hint" id="votes-empty">No votes yet. Check the voting members first, then move to a vote and press Record a vote here.</p>
  <div class="row">
    <button type="button" class="start" id="vote-start" title="A vote starts now: then click members on the video as they vote">🗳＋ Vote starts now</button>
    <button type="button" id="vote-add">✎ Record a vote here</button>
    <button type="button" id="members-toggle">Voting members…</button>
    <span class="label" id="votes-status" role="status"></span>
  </div>
  <div id="members-panel" hidden>
    <p class="hint">Check the people who vote in this meeting (add people with 🗣️ Speakers first). If someone leaves early, move to that moment and press Left here; votes after it start them as absent (Arrived here does the same for someone who comes late).</p>
    <ul class="member-list" id="member-list"></ul>
    <h3 class="label">Seating order, left to right as they appear on camera</h3>
    <ol class="seat-order" id="seat-order"></ol>
    <div class="row">
      <label class="label">Seats <input type="number" id="vote-seats" min="1" max="50" placeholder="auto"></label>
      <label class="label">Ayes needed to pass <input type="number" id="vote-needed" min="1" max="50" placeholder="auto"></label>
      <span class="hint" id="vote-rule"></span>
    </div>
  </div>
</section>
<div class="note" id="file-note" hidden></div>
${playback.fullMeetingUrl ? `<p class="hint">This is one part of the meeting as it was captured live. <a href="${escapeText(playback.fullMeetingUrl)}">Open the full meeting</a> (live capture joined with the county's archive).</p>` : ''}
</div>
<aside class="transcript" id="transcript" aria-label="Transcript" hidden>
  <div class="transcript-body">
  <figure class="now-scene" id="now-scene" hidden title="Go to this camera or slide change">
    <img id="now-scene-image" alt="">
    <select class="view-chip" id="view-select" title="Which camera view this is (zoom areas belong to a view)" aria-label="Camera view"></select>
    <figcaption id="now-scene-time"></figcaption>
    <div class="figure-speakers" id="now-speakers"></div>
  </figure>
  <div class="transcript-head">
    <input type="text" id="find" placeholder="Find in transcript" aria-label="Find in transcript" title="Enter for the next result, Shift+Enter for the previous">
    <span class="button-group find-buttons">
      <button type="button" id="find-prev" title="Previous result (Shift+Enter)" aria-label="Previous result">◀</button>
      <button type="button" id="find-next" title="Next result (Enter)" aria-label="Next result">▶</button>
    </span>
    <span class="label" id="find-status"></span>
  </div>
  <div class="transcript-list" id="transcript-list"></div>
  </div>
</aside>
</div>


<div class="row">
  <h2 class="grid-title">Thumbnails</h2>
  <label for="density" class="label">Show</label>
  <select id="density">
    <option value="0">every 5 minutes</option>
    <option value="1" selected>every 2.5 minutes</option>
    <option value="2">every 75 seconds</option>
    <option value="3">every 37.5 seconds</option>
    <option value="99">all</option>
  </select>
</div>
<div class="grid" id="grid"></div>
</main>
<dialog id="boost-dialog">
  <form id="boost-form">
    <h2>Boost the audio and transcribe again</h2>
    <p class="hint">For stretches where the speaker's microphone was off and others barely picked them up. Adjust and listen, then send it to the local server, which applies the same adjustment and transcribes the portion again. The new lines replace the old ones in that range (the original transcript is kept, and Undo puts it back).</p>
    <div class="row">
      <label>From <input type="text" id="boost-from" placeholder="HH:MM:SS"></label>
      <label>To <input type="text" id="boost-to" placeholder="HH:MM:SS"></label>
      <span class="label" id="boost-length"></span>
    </div>
    <div class="wave">
      <canvas id="boost-wave" height="110" aria-label="Waveform of the portion: drag the edges to refine it"></canvas>
      <div class="wave-labels"><span id="wave-start"></span><span id="wave-status" class="hint">Drag the green (start) and red (end) edges to refine the portion; click elsewhere to move the nearer edge.</span><span id="wave-end"></span></div>
      <button type="button" id="wave-reload" title="Load the waveform around the current range">↻ Waveform</button>
    </div>
    <div class="row">
      <label>Volume boost <input type="range" id="boost-gain" min="-6" max="36" step="1" value="12"> <span id="boost-gain-value" class="position">+12 dB</span></label>
    </div>
    <div class="row">
      <label><input type="checkbox" id="boost-normalize" checked> Even out loudness (quiet voices up, loud ones down)</label>
    </div>
    <div class="row">
      <label><input type="checkbox" id="boost-highpass" checked> Cut low rumble (below 120 Hz)</label>
      <label><input type="checkbox" id="boost-denoise"> Reduce steady background noise (heard in the server's version only)</label>
    </div>
    <div class="row">
      <button type="button" id="boost-preview">▶ Listen here</button>
      <button type="button" id="boost-render">🎧 Hear the server's version</button>
      <span class="label">Listen here plays the video with the boost applied live (close to the result); the server's version is exact.</span>
    </div>
    <audio id="boost-audio" controls hidden></audio>
    <div class="row">
      <label>Transcription <select id="boost-quality"><option value="thorough">thorough</option><option value="quick">quick</option></select></label>
      <button type="submit" class="start" id="boost-send">Re-transcribe this portion</button>
      <label><input type="checkbox" id="boost-keep" checked> and boost it during playback</label>
      <button type="button" id="boost-save">💾 Only save as a playback boost</button>
      <button type="button" id="boost-close">Close</button>
    </div>
    <p class="label" id="boost-status" role="status"></p>
    <h2>Playback boosts</h2>
    <p class="hint">Played wherever they apply while "Boost quiet speakers" (beside the video) is checked.</p>
    <ul class="portions" id="boost-saved"></ul>
    <h2>Re-transcribed portions</h2>
    <ul class="portions" id="boost-portions"></ul>
  </form>
</dialog>
<dialog id="display-dialog">
  <form method="dialog">
    <h2>On the video</h2>
    <div class="settings">
      <label>🕐 <select id="overlay-mode" aria-label="Clock and video time">
        <option value="none">no clock</option>
        <option value="clock">clock</option>
        <option value="position">video time</option>
        <option value="both">clock and video time</option>
      </select> <input type="range" min="50" max="250" step="10" value="100" data-size="clock" aria-label="Clock text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-name"> 🏷 Meeting name <input type="range" min="50" max="250" step="10" value="100" data-size="title" aria-label="Meeting name text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-agenda"> 📑 Chapter <input type="range" min="50" max="250" step="10" value="100" data-size="chapter" aria-label="Chapter text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-speakers"> 🗣️ Speakers <input type="range" min="50" max="250" step="10" value="100" data-size="speakers" aria-label="Speakers text size"> <span class="size"></span></label>
      <label><input type="checkbox" id="show-votes"> 🗳 Votes <input type="range" min="50" max="250" step="10" value="100" data-size="votes" aria-label="Votes text size"> <span class="size"></span></label>
    </div>
    <p class="hint">Drag any overlay on the video to move it. Click the meeting name, chapter, or a vote's motion to edit it.</p>
    <div class="row"><button type="button" id="layout-reset">Reset sizes and positions</button></div>
    <h2>Playback</h2>
    <div class="settings">
      <label><input type="checkbox" id="play-boosts"> 🔊 Boost quiet speakers <span class="hint">where boosts were saved in Boost &amp; re-transcribe</span></label>
      <label><input type="checkbox" id="auto-zoom"> 🔍 Magnify whoever is speaking <span class="hint">where the camera view has zoom areas</span></label>
    </div>
    <div class="row"><button value="done" class="start">Done</button></div>
  </form>
</dialog>
<dialog id="spoke-dialog">
  <h2 id="spoke-title">When they spoke</h2>
  <div class="row">
    <span class="button-group">
      <button type="button" id="spoke-prev" title="Previous time they spoke">◀</button>
      <button type="button" id="spoke-next" title="Next time they spoke">▶</button>
    </span>
    <span class="label" id="spoke-summary"></span>
  </div>
  <div class="spoke-bar" id="spoke-bar" title="Their speaking across the meeting: click to jump"></div>
  <ol class="agenda-list" id="spoke-list"></ol>
  <div class="row"><button type="button" id="spoke-close">Close</button></div>
</dialog>
<dialog id="clip-dialog">
  <form method="dialog" onsubmit="return false">
    <h2>Download clip</h2>
    <div class="row">
      <label class="label">From <input type="text" id="clip-from" class="time" placeholder="HH:MM:SS"></label>
      <label class="label">To <input type="text" id="clip-to" class="time" placeholder="HH:MM:SS"></label>
      <span class="label" id="clip-length"></span>
    </div>
    <div class="wave">
      <canvas id="clip-strip" class="strip" height="54" aria-label="Frames across the same stretch: drag the edges to refine the clip"></canvas>
      <canvas id="clip-wave" height="110" aria-label="Waveform of the clip: drag the edges to refine it"></canvas>
      <div class="wave-labels"><span id="clip-wave-start"></span><span id="clip-wave-status" class="hint"></span><span id="clip-wave-end"></span></div>
      <div class="row">
        <span class="button-group">
          <button type="button" id="clip-zoom-out" title="Zoom out (or scroll down over the waveform)" aria-label="Zoom out">−</button>
          <button type="button" id="clip-zoom-in" title="Zoom in around the clip (or scroll up over the waveform)" aria-label="Zoom in">+</button>
        </span>
        <button type="button" id="clip-wave-reload" title="Load the waveform around the current range">↻ Waveform</button>
      </div>
    </div>
    <div class="row">
      <button type="button" id="clip-preview">▶ Play clip</button>
      <label class="label" title="When playback reaches the end of the clip, start again from the beginning"><input type="checkbox" id="clip-loop"> 🔁 Loop</label>
      <label class="label"><input type="checkbox" id="clip-accurate"> Frame-exact (slower)</label>
      <label class="label" title="Plays the clip and records it with the overlays drawn on, as shown on the video (takes as long as the clip)"><input type="checkbox" id="clip-overlays"> Include the overlays</label>
      <span style="flex: 1"></span>
      <button type="button" class="start" id="clip-download">⬇ Download</button>
      <button type="button" id="clip-close">Close</button>
    </div>
    <p class="label" id="clip-status" role="status"></p>
  </form>
</dialog>
<dialog id="zoom-dialog">
  <form id="zoom-form">
    <h2 id="zoom-title">Zoom areas</h2>
    <div class="row">
      <label class="label">View <input type="text" id="zoom-view-name" autocomplete="off"></label>
      <button type="button" class="end" id="zoom-view-delete">Delete this view</button>
    </div>
    <p class="hint">Pick a person and drag a square around where they sit; a larger copy appears. Switch between ▢ Where they sit and ⧉ Larger copy to move (drag inside) or resize (drag a corner or edge) either one. With 🔍 Magnify whoever is speaking turned on (in 🎛), their larger copy fades in while they talk whenever the camera is on this view, and fades out a few seconds after they stop.</p>
    <div class="zoom-people" id="zoom-people"></div>
    <div class="row">
      <span class="label">Editing</span>
      <span class="button-group">
        <button type="button" id="zoom-edit-source" title="The square around where they sit (drag on an empty spot to draw a new one)">▢ Where they sit</button>
        <button type="button" id="zoom-edit-copy" title="The larger copy shown while they speak">⧉ Larger copy</button>
      </span>
      <span class="hint">Drag inside the box to move it; drag a corner or edge to resize it.</span>
    </div>
    <canvas id="zoom-canvas"></canvas>
    <div class="row">
      <button type="button" id="zoom-area-remove">Remove this person's box</button>
      <button type="button" id="zoom-frame">📷 Use the current video frame</button>
      <span style="flex: 1"></span>
      <button type="submit" class="start">Save</button>
      <button type="button" id="zoom-cancel">Cancel</button>
      <span class="label" id="zoom-status" role="status"></span>
    </div>
  </form>
</dialog>
<dialog id="vote-dialog">
  <form id="vote-form">
    <h2 id="vote-dialog-title">Record a vote</h2>
    <div class="row">
      <label class="label">Time <input type="text" id="vote-time" class="time" placeholder="HH:MM:SS"></label>
      <button type="button" id="vote-now">⏱ Now</button>
      <label class="label">Show on the video for <input type="number" id="vote-show" min="3" max="600" value="20"> seconds</label>
    </div>
    <div class="row"><label class="label" style="flex: 1">Motion <input type="text" id="vote-motion" placeholder="Motion to approve the consent agenda" autocomplete="off"></label></div>
    <div class="row">
      <label class="label">Moved by <select id="vote-moved-by"></select></label>
      <label class="label">at <input type="text" id="vote-moved-at" class="time" placeholder="HH:MM:SS"></label>
      <button type="button" id="vote-moved-now">⏱ Now</button>
    </div>
    <div class="row">
      <label class="label">Seconded by <select id="vote-seconded-by"></select></label>
      <label class="label">at <input type="text" id="vote-seconded-at" class="time" placeholder="HH:MM:SS"></label>
      <button type="button" id="vote-seconded-now">⏱ Now</button>
    </div>
    <p class="hint">This panel stays open while you play or scrub the video: find the motion or second and press ⏱ Now. Picking a person fills in when they last started speaking before the vote.</p>
    <p class="hint">Roll call: as each member votes, pause or play to that moment and click them. Each click records their vote at that moment, cycling aye → nay → abstain → absent → not voted (clicks within a couple of seconds change the same entry).</p>
    <div id="vote-members"></div>
    <div class="row">
      <button type="button" id="vote-all-for">Everyone present: aye, now</button>
      <label class="label">Outcome <select id="vote-outcome">
        <option value="auto">automatic</option>
        <option value="passed">passed</option>
        <option value="failed">failed</option>
      </select></label>
    </div>
    <p><strong id="vote-tally"></strong></p>
    <div class="row">
      <button type="submit" class="start">Save</button>
      <button type="button" id="vote-cancel">Cancel</button>
      <button type="button" class="end" id="vote-delete" hidden>Remove this vote</button>
      <span class="label" id="vote-dialog-status" role="status"></span>
    </div>
  </form>
</dialog>
<dialog id="person-dialog">
  <form id="person-form">
    <h2 id="person-title">Add a person</h2>
    <div class="row">
      <label class="label">Name <input type="text" id="person-name" autocomplete="off"></label>
      <label class="label"><input type="checkbox" id="person-unknown"> Name not known <span class="hint">(shows the role instead)</span></label>
      <label class="label">Role <input type="text" id="person-role" list="roles" placeholder="Supervisor, Fork District" autocomplete="off"></label>
      <label class="label">Group <input type="text" id="person-group" list="group-list" placeholder="Residents" autocomplete="off"></label>
      <label class="label" title="An emoji shown instead of a photo, for an entry that stands for several people (such as everyone reciting the Pledge)">Icon <input type="text" id="person-icon" maxlength="8" placeholder="👥" autocomplete="off" style="width: 4em; min-width: 0"></label>
      <datalist id="group-list"></datalist>
    </div>
    <datalist id="roles">
      <option value="Chair"><option value="Vice Chair"><option value="Supervisor"><option value="County Administrator">
      <option value="Deputy County Administrator"><option value="County Attorney"><option value="Clerk"><option value="Sheriff">
      <option value="Staff"><option value="Presenter"><option value="Public speaker"><option value="Mayor"><option value="Town Council">
    </datalist>
    <img id="person-photo" alt="Current photo" hidden>
    <canvas id="crop-canvas" hidden></canvas>
    <div class="row">
      <button type="button" id="crop-capture">📷 Use the current video frame</button>
      <button type="button" id="photo-none" title="For someone who isn't on screen: no photo, just initials">🚫 No photo</button>
      <label class="label">Circle size <input type="range" id="crop-size" min="16" max="540" value="90"></label>
    </div>
    <p class="hint">Drag the circle onto their face (or click where it should go); the slider or mouse wheel resizes it. Pause on a clear view of them first.</p>
    <div class="row">
      <button type="submit" class="start" id="person-save">Save</button>
      <button type="button" id="person-cancel">Cancel</button>
      <button type="button" class="end" id="person-delete" hidden>Remove from the list</button>
      <span class="label" id="person-status" role="status"></span>
    </div>
  </form>
</dialog>
<script>
  const page = ${data};
  const thumbs = page.thumbs;
  const segments = page.segments;
  const $ = (id) => document.getElementById(id);
  const fmt = (seconds) => {
    const total = Math.max(0, Math.floor(seconds));
    return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map((part) => String(part).padStart(2, '0')).join(':');
  };
  const fmtPrecise = (seconds) => {
    const fraction = Math.round((Math.max(0, seconds) % 1) * 1000);
    return fmt(seconds) + (fraction ? '.' + String(fraction).padStart(3, '0') : '');
  };
  const parse = (value) => {
    const parts = String(value || '').trim().split(':').map(Number);
    if (!value || parts.some((part) => !Number.isFinite(part))) return null;
    return parts.reduce((total, part) => total * 60 + part, 0);
  };
  // Milliseconds since the epoch when a position aired (approximate), or null when unknown.
  const clockMs = (seconds) => {
    let zero = null;
    for (const [start, ms] of page.clocks) { if (zero === null || start <= seconds + 0.001) zero = ms; }
    return zero === null ? null : zero + seconds * 1000;
  };
  const clockFormat = new Intl.DateTimeFormat('en-US', { timeZone: page.timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  // The overlay shows only the time of day (the date belongs in the meeting name), plus the weekday and date once a
  // meeting runs past midnight.
  const overlayFormat = new Intl.DateTimeFormat('en-US', { timeZone: page.timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const overlayDayFormat = new Intl.DateTimeFormat('en-US', { timeZone: page.timeZone, weekday: 'short', month: 'short', day: 'numeric' });
  const dayKeyFormat = new Intl.DateTimeFormat('en-US', { timeZone: page.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  function overlayClock(ms) {
    const startMs = clockMs(0);
    const nextDay = startMs !== null && dayKeyFormat.format(new Date(ms)) !== dayKeyFormat.format(new Date(startMs));
    return (nextDay ? overlayDayFormat.format(new Date(ms)) + ', ' : '') + overlayFormat.format(new Date(ms));
  }
  const last = thumbs[thumbs.length - 1];
  const endSeconds = segments.length ? segments[segments.length - 1][1] + segments[segments.length - 1][2] : (last ? last.s : 0);

  // Video position (counts missed moments, like the transcript) <-> player time (only captured video).
  function toPlayerTime(position) {
    for (const [audioStart, videoStart, duration] of segments) {
      if (position < videoStart) return audioStart;
      if (position < videoStart + duration) return audioStart + (position - videoStart);
    }
    return segments.length ? segments[segments.length - 1][0] + segments[segments.length - 1][2] : 0;
  }
  function toPosition(playerTime) {
    let match = segments[0];
    for (const segment of segments) {
      if (segment[0] <= playerTime) match = segment; else break;
    }
    return match ? match[1] + (playerTime - match[0]) : playerTime;
  }
  function nearestThumb(position) {
    let low = 0, high = thumbs.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (thumbs[middle].s <= position) low = middle; else high = middle - 1;
    }
    return low;
  }

  let position = 0;
  let start = null;
  let end = null;
  let playerReady = false;
  const video = $('video');
  const slider = $('slider');
  slider.max = endSeconds;

  function showPosition(seconds, { seek = true } = {}) {
    position = Math.max(0, Math.min(endSeconds, seconds));
    updateSliderRange();
    slider.value = position;
    $('position').textContent = fmt(position);
    updateOverlay();
    syncTranscript();
    updateNowScene();
    updateSpeakerUi();
    updatePlaybackBoost();
    updateAgendaCurrent();
    updateVoteOverlay();
    if ($('vote-dialog').open) renderVoteMembers();
    updateSpokeCurrent();
    updateZoom();
    scheduleQueryUpdate();
    if (playerReady) {
      if (seek && Math.abs(toPosition(video.currentTime) - position) > 0.5) video.currentTime = toPlayerTime(position);
    } else if (thumbs.length) {
      $('frame').src = thumbs[nearestThumb(position)].f;
    }
  }
  slider.addEventListener('input', () => {
    // In agenda-item scope, stop just short of the next item (beyond the quarter second an item counts from early) so
    // dragging doesn't switch items mid-drag.
    const value = Number(slider.value);
    showPosition(sliderScope === 'agenda' && value >= Number(slider.max) && Number(slider.max) < endSeconds ? Number(slider.max) - 0.3 : value);
  });
  // The scrubber covers the whole meeting, or only the agenda item being played (from its start to the next one's).
  let sliderScope = 'meeting';
  try { sliderScope = localStorage.getItem('thumbnails.sliderScope') === 'agenda' ? 'agenda' : 'meeting'; } catch {}
  let sliderRangeKey = '';
  // The transcript shows only the current chapter while the scrubber is limited to one (null: everything).
  let transcriptRange = null;
  let pageReady = false;
  function updateSliderRange() {
    const items = typeof agendaItems === 'undefined' ? [] : agendaItems;
    let min = 0;
    let max = endSeconds;
    let title = '';
    if (sliderScope === 'agenda' && items.length) {
      const index = agendaIndexAt(position);
      if (index < 0) { max = items[0].at; title = 'Before the first chapter'; } else {
        min = items[index].at;
        max = index + 1 < items.length ? items[index + 1].at : endSeconds;
        title = items[index].title;
      }
      if (max - min < 1) { min = Math.max(0, min - 0.5); max = Math.min(endSeconds, min + 1); }
    }
    const key = sliderScope + ':' + min + ':' + max + ':' + title;
    if (key === sliderRangeKey) return;
    sliderRangeKey = key;
    transcriptRange = sliderScope === 'agenda' && items.length ? { min, max } : null;
    if (pageReady) { renderTranscript(); renderScrubMarks(); }
    slider.min = min;
    slider.max = max;
    renderCutMarks();
    const agendaScope = sliderScope === 'agenda' && items.length > 0;
    slider.classList.toggle('chapter-scope', agendaScope);
    slider.title = agendaScope ? title + ' (' + fmt(min) + ' to ' + fmt(max) + ')' : 'Video position';
    $('scope-toggle').textContent = sliderScope === 'agenda' ? '📑 Chapter' : '↔ All';
    $('scope-toggle').title = sliderScope === 'agenda'
      ? (items.length ? 'The scrubber covers this chapter: click to cover the whole meeting' : 'Add chapters to scrub within one: click to cover the whole meeting')
      : 'The scrubber covers the whole meeting: click to cover only the current chapter';
  }
  $('scope-toggle').addEventListener('click', () => {
    sliderScope = sliderScope === 'agenda' ? 'meeting' : 'agenda';
    try { localStorage.setItem('thumbnails.sliderScope', sliderScope); } catch {}
    sliderRangeKey = '';
    updateSliderRange();
    slider.value = position;
  });

  // The player loads the session's playlist (../playback.m3u8): natively in Safari, with hls.js elsewhere.
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src; script.onload = resolve; script.onerror = reject;
      document.head.appendChild(script);
    });
  }
  // Resolves once the video's metadata (duration, size) is known, or rejects with the reason. It deliberately
  // doesn't wait for a frame at the current time: the stitched stream's buffer can start a fraction of a second
  // in, and the player only steps over that gap once playback is running.
  function waitForMetadata(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 1) { resolve(); return; }
      const done = (fn, value) => { clearTimeout(timer); video.removeEventListener('loadedmetadata', onReady); video.removeEventListener('error', onError); fn(value); };
      const onReady = () => done(resolve);
      const onError = () => done(reject, new Error(describeMediaError(video.error)));
      const timer = setTimeout(() => done(reject, new Error('the video did not start loading within ' + Math.round(timeoutMs / 1000) + ' seconds')), timeoutMs);
      video.addEventListener('loadedmetadata', onReady);
      video.addEventListener('error', onError);
    });
  }
  function describeMediaError(error) {
    if (!error) return 'unknown media error';
    const kinds = { 1: 'loading was aborted', 2: 'a network error stopped loading', 3: 'the video could not be decoded', 4: 'this browser cannot play the stream' };
    return kinds[error.code] || ('media error ' + error.code);
  }
  // The play button shows ▶︎ / ⏸ (⏳ while loading); loading messages go to the status line.
  function setStatus(text) {
    if (text === 'Play') {
      $('play').textContent = video.paused ? '▶︎' : '⏸';
      if ($('snapshot-status').textContent.startsWith('Loading')) $('snapshot-status').textContent = '';
    } else {
      $('play').textContent = '⏳';
      $('snapshot-status').textContent = text;
    }
  }

  async function initPlayer() {
    const source = '../playback.m3u8';
    // preload must allow loading, or Safari waits for play() before fetching anything.
    video.preload = 'auto';
    let hlsError = null;
    // Prefer hls.js wherever it works (Chrome, Edge, Firefox, desktop Safari). Some browsers report native HLS
    // support but can't play these MPEG-TS segments, so native playback is only the fallback (iPhone Safari).
    setStatus('Loading player...');
    const hlsLoaded = await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js').then(() => true, () => false);
    const useHls = hlsLoaded && window.Hls && window.Hls.isSupported();
    if (!useHls) {
      if (!video.canPlayType('application/vnd.apple.mpegurl')) {
        throw new Error(hlsLoaded ? 'this browser cannot play HLS video' : 'could not load the hls.js player (no internet connection?)');
      }
      setStatus('Loading video...');
      video.src = source;
      video.load();
    } else {
      setStatus('Loading playlist...');
      // Start loading at the current position instead of the beginning of the session.
      const hls = new window.Hls({ startPosition: toPlayerTime(position) });
      hls.on(window.Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          hlsError = (data.details || data.type) + (data.response && data.response.code ? ' (HTTP ' + data.response.code + ')' : '');
          video.dispatchEvent(new Event('error'));
        }
      });
      hls.on(window.Hls.Events.MANIFEST_PARSED, () => setStatus('Loading video...'));
      hls.loadSource(source);
      hls.attachMedia(video);
    }
    try {
      await waitForMetadata(20000);
    } catch (error) {
      throw new Error(hlsError || error.message);
    }
    if (!useHls) {
      video.currentTime = toPlayerTime(position);
    }
    video.hidden = false;
    $('frame').hidden = true;
    playerReady = true;
    ['prev-frame', 'next-frame', 'frames-toggle'].forEach((id) => { $(id).hidden = false; });
  }
  video.addEventListener('timeupdate', () => showPosition(toPosition(video.currentTime), { seek: false }));
  video.addEventListener('play', () => { $('play').textContent = '⏸'; $('play').setAttribute('aria-label', 'Pause'); $('stage-play').textContent = '⏸'; });
  video.addEventListener('pause', () => { $('play').textContent = '▶︎'; $('play').setAttribute('aria-label', 'Play'); $('stage-play').textContent = '▶︎'; });
  async function togglePlay() {
    try {
      if (!playerReady) {
        $('play').disabled = true;
        await initPlayer();
        $('play').disabled = false;
        setStatus('Play');
      }
      if (video.paused) await video.play(); else video.pause();
    } catch (error) {
      $('play').disabled = false;
      $('play').textContent = '▶︎';
      if ($('snapshot-status').textContent.startsWith('Loading')) $('snapshot-status').textContent = '';
      showFileNote(true, error.message);
    }
  }
  $('play').addEventListener('click', togglePlay);
  // Beside the video, the transcript is as tall as the video with its scrubber and toolbar (not the whole window).
  function sizeTranscript() {
    const panel = $('transcript');
    if (!panel.style || !$('stage').getBoundingClientRect) return;
    if (window.innerWidth <= 1100) { panel.style.height = ''; return; }
    const height = $('toolbar').getBoundingClientRect().bottom - $('stage').getBoundingClientRect().top;
    panel.style.height = Math.max(320, Math.round(height)) + 'px';
  }
  window.addEventListener('resize', sizeTranscript);
  if (window.ResizeObserver) new ResizeObserver(sizeTranscript).observe($('stage'));
  // Clicking the video itself (but not the overlays that are clicked to edit or record) plays or pauses it.
  $('stage').addEventListener('click', (event) => {
    if (event.target.closest('.vote-overlay, .title-overlay, .agenda-overlay, .inline-edit, .view-chip') || zoomSelecting || Date.now() - zoomSelectedAt < 300) return;
    togglePlay();
  });
  document.addEventListener('keydown', (event) => {
    if (event.code === 'Space' && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(event.target.tagName)) {
      event.preventDefault();
      togglePlay();
    }
  });

  function showFileNote(failed, detail = '') {
    const note = $('file-note');
    if (location.protocol !== 'file:' && !failed) return;
    const link = page.serverUrl ? ' Then open <a href="' + page.serverUrl + '">' + page.serverUrl + '</a>.' : '';
    const onDisk = location.protocol === 'file:';
    note.innerHTML = (failed ? 'The video could not be loaded' + (detail ? ' (' + detail + ')' : '') + '. ' : 'Playing video needs the local server, because browsers block it on pages opened from disk. ')
      + (onDisk ? 'Run <code>npm run serve</code> in the repository folder.' + link : 'Check that <code>npm run serve</code> is still running, then reload this page.');
    note.hidden = false;
  }
  if (location.protocol === 'file:') showFileNote(false);

  $('display-open').addEventListener('click', () => { if ($('display-dialog').open) $('display-dialog').close(); else $('display-dialog').show(); });
  // Overlay on the video: the date and time of day the moment aired (approximate), the video position, or both.
  let overlayMode = 'none';
  function updateOverlay() {
    if ($('overlay').hidden) return;
    const showClock = overlayMode === 'clock' || overlayMode === 'both';
    const showPosition = overlayMode === 'position' || overlayMode === 'both';
    $('overlay-clock').hidden = !showClock;
    $('overlay-position').hidden = !showPosition;
    $('overlay-clock').textContent = clockMs(position) === null ? 'Time of day unknown' : overlayClock(clockMs(position));
    $('overlay-position').textContent = fmt(position);
    // Alone, the video time is shown at full size.
    $('overlay-position').classList.toggle('alone', !showClock);
  }
  function setOverlay(mode) {
    overlayMode = ['clock', 'position', 'both'].includes(mode) ? mode : 'none';
    $('overlay-mode').value = overlayMode;
    $('overlay').hidden = overlayMode === 'none';
    try { localStorage.setItem('thumbnails.overlay', overlayMode); } catch {}
    updateOverlay();
  }
  $('overlay-mode').addEventListener('change', () => setOverlay($('overlay-mode').value));
  try {
    // Earlier pages had a single "Show clock" checkbox, which showed both.
    setOverlay(localStorage.getItem('thumbnails.overlay') || (localStorage.getItem('thumbnails.showClock') === '1' ? 'both' : 'none'));
  } catch {}

  // Saves the current frame as a full-resolution PNG (the browser already has it decoded, so no server work is
  // needed). With the clock shown, the date and time are drawn into the image too.
  async function saveFrame() {
    const status = $('snapshot-status');
    try {
      $('snapshot').disabled = true;
      if (!playerReady) {
        status.textContent = 'Loading video...';
        await initPlayer();
        setStatus('Play');
        $('play').disabled = false;
      }
      if (!video.paused) video.pause();
      await waitForFrame(15000);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      // Magnified squares, at the video's full resolution.
      paintMagnified(context, video, canvas.width, canvas.height, magnifiedAt(position));
      paintOverlays(context, canvas.width);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('the browser could not encode the image');
      const fraction = Math.round((position % 1) * 1000);
      const fileName = 'frame-' + fmt(position).replace(/:/g, '-') + (fraction ? '.' + String(fraction).padStart(3, '0') : '') + '.png';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10000);
      status.textContent = 'Saved ' + fileName;
    } catch (error) {
      status.textContent = 'Could not save the frame: ' + error.message;
      if (location.protocol === 'file:') showFileNote(false);
    } finally {
      $('snapshot').disabled = false;
    }
  }

  // Resolves once a frame at the current time is decoded. If the buffer starts just after the current time
  // (common at segment gaps), steps forward to its start.
  function waitForFrame(timeoutMs) {
    return new Promise((resolve, reject) => {
      if (video.readyState >= 2) { resolve(); return; }
      if (video.buffered.length && video.buffered.start(0) > video.currentTime) {
        video.currentTime = video.buffered.start(0) + 0.05;
      }
      const done = (fn, value) => { clearTimeout(timer); video.removeEventListener('loadeddata', onReady); video.removeEventListener('seeked', onReady); video.removeEventListener('canplay', onReady); fn(value); };
      const onReady = () => { if (video.readyState >= 2) done(resolve); };
      const timer = setTimeout(() => done(reject, new Error('the frame did not load within ' + Math.round(timeoutMs / 1000) + ' seconds')), timeoutMs);
      video.addEventListener('loadeddata', onReady);
      video.addEventListener('seeked', onReady);
      video.addEventListener('canplay', onReady);
    });
  }

  $('snapshot').addEventListener('click', saveFrame);

  // Frame stepping and the frame strip. The stream runs at 29.97 frames per second.
  const frameSeconds = 1001 / 30000;
  const framesEachSide = 12;
  function seekTo(playerTime, timeoutMs = 6000) {
    const target = Math.max(0, playerTime);
    return new Promise((resolve) => {
      if (Math.abs(video.currentTime - target) < frameSeconds / 4 && video.readyState >= 2) { resolve(); return; }
      const done = () => { clearTimeout(timer); video.removeEventListener('seeked', done); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      video.addEventListener('seeked', done);
      video.currentTime = target;
    });
  }
  function stepFrame(count) {
    if (!playerReady) return;
    video.pause();
    seekTo(video.currentTime + count * frameSeconds);
  }
  $('prev-frame').addEventListener('click', () => stepFrame(-1));
  $('next-frame').addEventListener('click', () => stepFrame(1));
  document.addEventListener('keydown', (event) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName)) return;
    if (event.key === ',') { event.preventDefault(); stepFrame(-1); }
    if (event.key === '.') { event.preventDefault(); stepFrame(1); }
  });

  let buildingStrip = false;
  async function buildFrameStrip() {
    if (buildingStrip) return;
    buildingStrip = true;
    const strip = $('frames');
    const status = $('frames-status');
    try {
      if (!playerReady) await initPlayer();
      video.pause();
      await waitForFrame(15000);
      const center = video.currentTime;
      const spacing = Number($('frame-spacing').value);
      // Hold the current picture on screen while the player steps through the neighboring frames.
      const freeze = $('freeze');
      freeze.width = video.videoWidth;
      freeze.height = video.videoHeight;
      freeze.getContext('2d').drawImage(video, 0, 0, freeze.width, freeze.height);
      freeze.hidden = false;
      strip.textContent = '';
      status.textContent = 'Loading frames...';
      for (let offset = -framesEachSide; offset <= framesEachSide; offset += 1) {
        const time = center + offset * spacing * frameSeconds;
        if (time < 0) continue;
        await seekTo(time);
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = Math.round(320 * video.videoHeight / Math.max(1, video.videoWidth));
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.time = String(video.currentTime);
        if (offset === 0) button.classList.add('current');
        const label = document.createElement('span');
        const framesAway = offset * spacing;
        label.textContent = (offset === 0 ? 'current' : (framesAway > 0 ? '+' : '') + framesAway + ' fr') + ' · ' + fmt(toPosition(video.currentTime)) + '.' + String(Math.round((toPosition(video.currentTime) % 1) * 1000)).padStart(3, '0');
        button.append(canvas, label);
        button.addEventListener('click', async () => {
          strip.querySelectorAll('button').forEach((item) => item.classList.toggle('current', item === button));
          await seekTo(Number(button.dataset.time));
        });
        strip.appendChild(button);
      }
      await seekTo(center);
      freeze.hidden = true;
      status.textContent = '';
      strip.querySelector('.current')?.scrollIntoView({ inline: 'center', block: 'nearest' });
    } catch (error) {
      status.textContent = 'Could not load frames: ' + error.message;
      $('freeze').hidden = true;
    } finally {
      buildingStrip = false;
    }
  }
  $('frames-toggle').addEventListener('click', () => {
    const panel = $('frames-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) buildFrameStrip();
  });
  $('frames-refresh').addEventListener('click', buildFrameStrip);
  $('frame-spacing').addEventListener('change', buildFrameStrip);

  $('set-start').addEventListener('click', () => { start = position; update(); });
  $('set-end').addEventListener('click', () => { end = position; update(); });
  // Markers above the scrubber at the clip's start and end, and a highlight between them (within the scrubber's range).
  function renderCutMarks() {
    let from = start;
    let to = end;
    if (from !== null && to !== null && to < from) [from, to] = [to, from];
    const min = Number(slider.min) || 0;
    const max = Number(slider.max) || endSeconds;
    const span = Math.max(0.001, max - min);
    const at = (seconds) => 'calc(8px + (100% - 16px) * ' + ((seconds - min) / span).toFixed(5) + ')';
    const inRange = (seconds) => seconds !== null && seconds >= min && seconds <= max;
    [['cut-start-mark', from, 'Clip start'], ['cut-end-mark', to, 'Clip end']].forEach(([id, seconds, label]) => {
      const mark = $(id);
      mark.hidden = !inRange(seconds);
      if (mark.hidden) return;
      mark.style.left = at(seconds);
      mark.title = label + ' ' + fmt(seconds) + ' (click to go there)';
    });
    const band = $('cut-band');
    band.hidden = from === null || to === null || to <= min || from >= max;
    if (!band.hidden) {
      const left = Math.max(from, min);
      const right = Math.min(to, max);
      band.style.left = at(left);
      band.style.width = 'calc((100% - 16px) * ' + ((right - left) / span).toFixed(5) + ')';
    }
  }
  $('cut-start-mark').addEventListener('click', () => { if (start !== null) showPosition(Math.min(start, end ?? start)); });
  $('cut-end-mark').addEventListener('click', () => { if (end !== null) showPosition(Math.max(end, start ?? end)); });
  // The clip range (set with ✂⟦ ⟧✂, refined and downloaded with 🎬): shown on the toolbar buttons' tooltips and on
  // the thumbnails, and kept in the address bar.
  function update() {
    let from = start;
    let to = end;
    if (from !== null && to !== null && to < from) [from, to] = [to, from];
    const ready = from !== null && to !== null && Math.floor(to) > Math.floor(from);
    $('set-start').title = 'Clip starts here' + (from !== null ? ' (now ' + fmt(from) + ')' : '');
    $('set-end').title = 'Clip ends here' + (to !== null ? ' (now ' + fmt(to) + ')' : '');
    $('clip-open').title = ready ? 'Refine and download the clip ' + fmt(from) + '-' + fmt(to) : 'Refine the clip and download it';
    renderCutMarks();
    scheduleQueryUpdate();
    document.querySelectorAll('.grid button').forEach((button) => {
      const seconds = Number(button.dataset.seconds);
      button.classList.toggle('is-start', from !== null && Math.abs(seconds - from) < 0.5);
      button.classList.toggle('is-end', to !== null && Math.abs(seconds - to) < 0.5);
      button.classList.toggle('in-range', ready && seconds > from && seconds < to);
    });
  }


  function renderGrid() {
    const maxLevel = Number($('density').value);
    const grid = $('grid');
    grid.textContent = '';
    thumbs.forEach((item) => {
      if (item.l > maxLevel) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.seconds = item.s;
      button.title = 'Go to ' + fmt(item.s);
      button.innerHTML = '<img loading="lazy" alt="" src="' + item.f + '"><span>' + fmt(item.s) + (item.c ? ' · ' + item.c : '') + '</span>';
      button.addEventListener('click', () => { showPosition(item.s); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      grid.appendChild(button);
    });
    update();
  }
  // Speakers: who is talking when. The roster (names, roles, and circle-cropped face photos) is shared by every
  // meeting from this source, in {source}/people/; when each set of speakers starts is kept per session, in
  // {session}/speakers.json as turns ({ at: video position, speakers: [person ids] }). Both save through the local server.
  let people = page.people;
  let turns = page.turns;
  const mapPeople = () => new Map(people.map((person) => [person.id, person]));
  let peopleMap = mapPeople();
  let lastSpeakerKey = null;
  function turnIndexAt(seconds) {
    let found = -1;
    for (let index = 0; index < turns.length && turns[index].at <= seconds + 0.15; index += 1) found = index;
    return found;
  }
  function speakersAt(seconds) {
    const index = turnIndexAt(seconds);
    return index < 0 ? [] : turns[index].speakers;
  }
  const photoUrl = (person) => page.peopleUrl + '/' + encodeURIComponent(person.photo) + '?v=' + (person.photoVersion || 0);
  const initialsOf = (name) => String(name || '?').split(' ').filter(Boolean).map((word) => word[0]).slice(0, 2).join('').toUpperCase();
  // A name that isn't known (marked so, blank, or "Unknown") shows the person's role instead, or "Unknown".
  const isNameUnknown = (person) => Boolean(person?.nameUnknown) || !String(person?.name || '').trim() || /^unknown$/i.test(String(person?.name || '').trim());
  const shownName = (person) => (!person ? 'Unknown' : (isNameUnknown(person) ? (person.role || 'Unknown') : person.name));
  const nameAndRole = (person) => (isNameUnknown(person) ? shownName(person) : person.name + (person.role ? ', ' + person.role : ''));
  function avatar(person) {
    // A group entry (such as everyone reciting the Pledge together) shows its emoji instead of a photo.
    if (person?.icon) {
      const icon = document.createElement('span');
      icon.className = 'avatar icon';
      icon.textContent = person.icon;
      return icon;
    }
    if (person?.photo) {
      const image = document.createElement('img');
      image.className = 'avatar';
      image.alt = '';
      image.src = photoUrl(person);
      return image;
    }
    const initials = document.createElement('span');
    initials.className = 'avatar';
    initials.textContent = isNameUnknown(person) ? '?' : initialsOf(person?.name);
    return initials;
  }
  async function putFile(url, body, type) {
    if (location.protocol === 'file:') throw new Error('saving needs the local server (npm run serve)');
    const response = await fetch(url, { method: 'PUT', headers: { 'content-type': type }, body });
    if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
  }
  async function saveTurns() {
    try {
      await putFile('../speakers.json', JSON.stringify({ updatedAt: new Date().toISOString(), turns }, null, 2), 'application/json');
      $('speakers-status').textContent = 'Saved';
    } catch (error) {
      $('speakers-status').textContent = 'Not saved: ' + error.message;
    }
  }
  // Sets who is speaking from the current position on. A change within a second of an existing one edits that one
  // (so picking several people in a row makes one change), and a change that repeats the one before is dropped.
  function setSpeakersNow(ids) {
    const at = Math.round(position * 10) / 10;
    const existing = turns.find((turn) => Math.abs(turn.at - at) <= 1);
    if (existing) existing.speakers = ids; else turns.push({ at, speakers: ids });
    turns.sort((a, b) => a.at - b.at);
    turns = turns.filter((turn, index) => turn.speakers.join(',') !== (index ? turns[index - 1].speakers.join(',') : ''));
    speakersChanged();
    saveTurns();
  }
  function toggleSpeaker(id) {
    const current = speakersAt(position);
    setSpeakersNow(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  function speakersChanged() {
    if (spokePerson && $('spoke-dialog').open) renderSpoke();
    if (pageReady) renderScrubMarks();
    lastSpeakerKey = null;
    updateSpeakerUi();
    renderTranscript();
  }
  // Groups of people (saved with the roster, so every meeting shares them). Voting members of this meeting come first.
  let rosterGroups = Array.isArray(page.peopleGroups) ? page.peopleGroups : ['Elected officials', 'County staff', 'Residents', 'Vendors', 'Other organizations'];
  // Starts as compact circles grouped side by side; Names shows the full details.
  let peopleView = 'icons';
  try { peopleView = localStorage.getItem('thumbnails.peopleLayout') === 'names' ? 'names' : 'icons'; } catch {}
  function personChip(person, voting) {
    const chip = document.createElement('span');
    chip.className = 'person-chip';
    chip.draggable = true;
    chip.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', JSON.stringify({ id: person.id, voting }));
      event.dataTransfer.effectAllowed = 'move';
    });
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'person';
    button.dataset.id = person.id;
    button.title = nameAndRole(person) + (voting ? ' (votes in this meeting)' : '');
    const text = document.createElement('span');
    text.className = 'person-text';
    const name = document.createElement('strong');
    name.textContent = shownName(person);
    const role = document.createElement('small');
    role.textContent = isNameUnknown(person) ? 'name not known' : (person.role || '');
    text.append(name, role);
    button.append(avatar(person), text);
    button.addEventListener('click', () => toggleSpeaker(person.id));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'edit';
    edit.title = 'Edit ' + shownName(person);
    edit.textContent = '✎';
    edit.addEventListener('click', () => openPersonEditor(person));
    const times = document.createElement('button');
    times.type = 'button';
    times.className = 'times';
    times.title = 'When ' + shownName(person) + ' spoke';
    times.textContent = '🕑';
    times.addEventListener('click', () => openSpokeDialog(person.id));
    chip.append(button, times, edit);
    return chip;
  }
  // A section people can be dragged onto: target is { voting: true } or { group: name ('' for none) }.
  function peopleSection(title, target, list, extras) {
    const section = document.createElement('section');
    section.className = 'people-section' + (target.voting ? ' voting' : '');
    const heading = document.createElement('h3');
    heading.append(...extras(title));
    const chips = document.createElement('div');
    chips.className = 'people-chips';
    list.forEach((person) => chips.appendChild(personChip(person, Boolean(target.voting))));
    section.append(heading, chips);
    section.addEventListener('dragover', (event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; section.classList.add('drop'); });
    section.addEventListener('dragleave', (event) => { if (!section.contains(event.relatedTarget)) section.classList.remove('drop'); });
    section.addEventListener('drop', (event) => {
      event.preventDefault();
      section.classList.remove('drop');
      let dragged = null;
      try { dragged = JSON.parse(event.dataTransfer.getData('text/plain')); } catch {}
      if (dragged?.id) dropPerson(dragged, target);
    });
    return section;
  }
  async function dropPerson(dragged, target) {
    const person = peopleMap.get(dragged.id);
    if (!person) return;
    const status = $('speakers-status');
    try {
      if (target.voting) {
        if (voteData.members.some((member) => member.id === person.id)) return;
        voteData.members = [...voteData.members, { id: person.id, leftAt: null, arrivedAt: null }];
        await saveVotes(shownName(person) + ' votes in this meeting');
        status.textContent = shownName(person) + ' votes in this meeting';
      } else {
        // Out of the voting members, into a group.
        if (dragged.voting) {
          voteData.members = voteData.members.filter((member) => member.id !== person.id);
          await saveVotes(shownName(person) + ' no longer votes in this meeting');
        }
        const list = await latestPeople();
        await savePeople(list.map((item) => (item.id === person.id ? { ...item, group: target.group } : item)));
        status.textContent = shownName(person) + (target.group ? ' is in ' + target.group : ' is not in a group');
      }
    } catch (error) {
      status.textContent = 'Not saved: ' + error.message;
    }
    renderPeople();
  }
  async function saveGroups(groups, list, done) {
    // Read the latest roster first: reading it also refreshes the saved group list, which must not replace the new one.
    const fresh = list || await latestPeople();
    const before = rosterGroups;
    rosterGroups = groups;
    try {
      await savePeople(fresh);
      $('speakers-status').textContent = done;
    } catch (error) {
      rosterGroups = before;
      $('speakers-status').textContent = 'Not saved: ' + error.message;
    }
    renderPeople();
  }
  $('group-add').addEventListener('click', async () => {
    await latestPeople();
    const name = (prompt('Name of the new group (for example VDOT):') || '').trim();
    if (!name || rosterGroups.includes(name)) return;
    await saveGroups([...rosterGroups, name], null, 'Added the group ' + name);
  });
  function setPeopleView(view) {
    peopleView = view;
    try { localStorage.setItem('thumbnails.peopleLayout', view); } catch {}
    $('people').classList.toggle('icons-only', view === 'icons');
    $('people-names').classList.toggle('on', view === 'names');
    $('people-icons').classList.toggle('on', view === 'icons');
  }
  $('people-names').addEventListener('click', () => setPeopleView('names'));
  $('people-icons').addEventListener('click', () => setPeopleView('icons'));
  function renderPeople() {
    const box = $('people');
    box.textContent = '';
    setPeopleView(peopleView);
    const byName = (a, b) => a.name.localeCompare(b.name);
    const memberIds = voteData.members.map((member) => member.id);
    const voting = memberIds.map((id) => peopleMap.get(id)).filter(Boolean);
    const others = people.filter((person) => !memberIds.includes(person.id));
    const label = (text) => { const span = document.createElement('span'); span.textContent = text; return [span]; };
    box.appendChild(peopleSection('🗳 Voting members', { voting: true }, voting, label));
    // Groups in their saved order, then any group someone has that isn't listed yet.
    const groups = [...rosterGroups];
    others.forEach((person) => { if (person.group && !groups.includes(person.group)) groups.push(person.group); });
    groups.forEach((group) => {
      const members = others.filter((person) => person.group === group).sort(byName);
      box.appendChild(peopleSection(group, { group }, members, (title) => {
        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = title;
        name.title = 'Click to rename';
        name.addEventListener('click', async () => {
          const renamed = (prompt('Rename the group "' + title + '" to:', title) || '').trim();
          if (!renamed || renamed === title) return;
          const list = (await latestPeople()).map((person) => (person.group === title ? { ...person, group: renamed } : person));
          await saveGroups(rosterGroups.includes(title) ? rosterGroups.map((item) => (item === title ? renamed : item)) : [...rosterGroups, renamed], list, 'Renamed the group to ' + renamed);
        });
        const parts = [name];
        if (!members.length) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '✕';
          remove.title = 'Remove this empty group';
          remove.addEventListener('click', () => saveGroups(rosterGroups.filter((item) => item !== title), null, 'Removed the group ' + title));
          parts.push(remove);
        }
        return parts;
      }));
    });
    box.appendChild(peopleSection('Not grouped', { group: '' }, others.filter((person) => !person.group).sort(byName), label));
    $('people-empty').hidden = people.length > 0;
    lastSpeakerKey = null;
    updateSpeakerUi();
    // The voting member list and vote overlay show the same people.
    renderMembers();
    renderSeatOrder();
    voteOverlayKey = null;
    updateVoteOverlay();
  }
  function updateSpeakerUi() {
    $('speaker-remove').disabled = !turns.some((turn) => Math.abs(turn.at - position) <= 1);
    const index = turnIndexAt(position);
    const ids = index < 0 ? [] : turns[index].speakers;
    const key = index + ':' + ids.join(',');
    if (key === lastSpeakerKey) return;
    lastSpeakerKey = key;
    updateNowSpeakers(ids);
    document.querySelectorAll('#people .person').forEach((button) => button.setAttribute('aria-pressed', ids.includes(button.dataset.id) ? 'true' : 'false'));
    const names = ids.map((id) => (peopleMap.get(id) ? shownName(peopleMap.get(id)) : id));
    $('speakers-now').textContent = (names.length ? names.join(', ') : 'nobody marked') + (index >= 0 ? ' (since ' + fmt(turns[index].at) + ')' : '');
    const cards = $('speaker-cards');
    cards.textContent = '';
    ids.forEach((id) => {
      const person = peopleMap.get(id) || { id, name: id };
      const card = document.createElement('div');
      card.className = 'speaker-card';
      const text = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = shownName(person);
      text.appendChild(name);
      if (person.role && !isNameUnknown(person)) {
        const role = document.createElement('small');
        role.textContent = person.role;
        text.appendChild(role);
      }
      card.append(avatar(person), text);
      cards.appendChild(card);
    });
  }
  $('speakers-toggle').addEventListener('click', () => {
    const panel = $('speakers-panel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderPeople();
  });
  $('speaker-none').addEventListener('click', () => setSpeakersNow([]));
  $('speaker-remove').addEventListener('click', () => {
    const index = turns.findIndex((turn) => Math.abs(turn.at - position) <= 1);
    if (index < 0) return;
    turns.splice(index, 1);
    speakersChanged();
    saveTurns();
  });
  $('speaker-prev').addEventListener('click', () => {
    const previous = [...turns].reverse().find((turn) => turn.at < position - 0.5);
    if (previous) showPosition(previous.at);
  });
  $('speaker-next').addEventListener('click', () => {
    const next = turns.find((turn) => turn.at > position + 0.5);
    if (next) showPosition(next.at);
  });
  function setSpeakerOverlay(visible) {
    $('show-speakers').checked = visible;
    $('speaker-cards').hidden = !visible;
    try { localStorage.setItem('thumbnails.showSpeakers', visible ? '1' : '0'); } catch {}
  }
  $('show-speakers').addEventListener('change', () => setSpeakerOverlay($('show-speakers').checked));
  try { if (localStorage.getItem('thumbnails.showSpeakers') === '1') setSpeakerOverlay(true); } catch {}

  // Person editor: name, role, and a face photo cropped with a circle from the paused video frame (full resolution).
  let editing = null;
  let cropFrame = null;
  let removePhoto = false;
  const crop = { x: 0, y: 0, r: 0 };
  const cropCanvas = $('crop-canvas');
  function openPersonEditor(person) {
    editing = person || null;
    $('person-title').textContent = person ? 'Edit ' + shownName(person) : 'Add a person';
    $('person-unknown').checked = Boolean(person) && isNameUnknown(person);
    $('person-name').value = person && !isNameUnknown(person) ? person.name : '';
    removePhoto = false;
    $('person-role').value = person?.role || '';
    $('person-group').value = person?.group || '';
    $('person-icon').value = person?.icon || '';
    $('group-list').textContent = '';
    rosterGroups.forEach((group) => { const option = document.createElement('option'); option.value = group; $('group-list').appendChild(option); });
    $('person-status').textContent = '';
    $('person-delete').hidden = !person;
    cropFrame = null;
    cropCanvas.hidden = true;
    $('person-photo').hidden = !person?.photo;
    if (person?.photo) $('person-photo').src = photoUrl(person);
    $('person-dialog').showModal();
    if (!person) captureForCrop();
  }
  async function captureForCrop() {
    const status = $('person-status');
    try {
      status.textContent = 'Getting the current frame...';
      if (!playerReady) {
        await initPlayer();
        setStatus('Play');
        $('play').disabled = false;
      }
      if (!video.paused) video.pause();
      await waitForFrame(15000);
      cropFrame = document.createElement('canvas');
      cropFrame.width = video.videoWidth;
      cropFrame.height = video.videoHeight;
      cropFrame.getContext('2d').drawImage(video, 0, 0);
      cropCanvas.width = cropFrame.width;
      cropCanvas.height = cropFrame.height;
      // Keep the last circle (the next person is often in the same spot on the same camera).
      if (!crop.r || crop.x > cropFrame.width || crop.y > cropFrame.height) {
        crop.x = cropFrame.width / 2;
        crop.y = cropFrame.height / 3;
        crop.r = Math.round(cropFrame.height / 8);
      }
      $('crop-size').max = Math.round(cropFrame.height / 2);
      $('crop-size').value = crop.r;
      cropCanvas.hidden = false;
      $('person-photo').hidden = true;
      drawCrop();
      status.textContent = '';
    } catch (error) {
      status.textContent = 'No photo: ' + error.message;
    }
  }
  function drawCrop() {
    if (!cropFrame) return;
    const context = cropCanvas.getContext('2d');
    context.drawImage(cropFrame, 0, 0);
    context.beginPath();
    context.rect(0, 0, cropCanvas.width, cropCanvas.height);
    context.arc(crop.x, crop.y, crop.r, 0, Math.PI * 2);
    context.fillStyle = 'rgba(0, 0, 0, 0.6)';
    context.fill('evenodd');
    context.beginPath();
    context.arc(crop.x, crop.y, crop.r, 0, Math.PI * 2);
    context.lineWidth = Math.max(2, cropCanvas.width / 400);
    context.strokeStyle = '#ffffff';
    context.stroke();
  }
  function cropPoint(event) {
    const rect = cropCanvas.getBoundingClientRect();
    const scale = cropCanvas.width / rect.width;
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
  }
  function moveCrop(x, y) {
    crop.x = Math.max(0, Math.min(cropCanvas.width, x));
    crop.y = Math.max(0, Math.min(cropCanvas.height, y));
    drawCrop();
  }
  function resizeCrop(radius) {
    crop.r = Math.round(Math.max(16, Math.min(cropCanvas.height / 2, radius)));
    $('crop-size').value = crop.r;
    drawCrop();
  }
  let dragFrom = null;
  cropCanvas.addEventListener('pointerdown', (event) => {
    const point = cropPoint(event);
    // Outside the circle: put it there first, then drag from there.
    if (Math.hypot(point.x - crop.x, point.y - crop.y) > crop.r) moveCrop(point.x, point.y);
    dragFrom = { pointX: point.x, pointY: point.y, x: crop.x, y: crop.y };
    cropCanvas.setPointerCapture(event.pointerId);
  });
  cropCanvas.addEventListener('pointermove', (event) => {
    if (!dragFrom) return;
    const point = cropPoint(event);
    moveCrop(dragFrom.x + point.x - dragFrom.pointX, dragFrom.y + point.y - dragFrom.pointY);
  });
  cropCanvas.addEventListener('pointerup', () => { dragFrom = null; });
  cropCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    resizeCrop(crop.r * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
  }, { passive: false });
  $('crop-size').addEventListener('input', () => resizeCrop(Number($('crop-size').value)));
  $('crop-capture').addEventListener('click', () => { removePhoto = false; captureForCrop(); });
  $('photo-none').addEventListener('click', () => {
    removePhoto = true;
    cropFrame = null;
    cropCanvas.hidden = true;
    $('person-photo').hidden = true;
    $('person-status').textContent = 'No photo: they will show as initials (or ? when the name is not known).';
  });
  $('person-cancel').addEventListener('click', () => $('person-dialog').close());
  $('person-add').addEventListener('click', () => openPersonEditor(null));

  async function latestPeople() {
    // Start from the saved roster, so people added from another meeting's page aren't lost.
    const roster = await fetch(page.peopleUrl + '/people.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
    if (Array.isArray(roster?.groups)) rosterGroups = roster.groups;
    return roster?.people || people;
  }
  async function savePeople(list) {
    await putFile(page.peopleUrl + '/people.json', JSON.stringify({ updatedAt: new Date().toISOString(), groups: rosterGroups, people: list }, null, 2), 'application/json');
    people = list;
    peopleMap = mapPeople();
  }
  function uniqueId(name, list) {
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'person';
    let id = base;
    for (let count = 2; list.some((person) => person.id === id); count += 1) id = base + '-' + count;
    return id;
  }
  $('person-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('person-status');
    const name = $('person-name').value.trim();
    const unknown = $('person-unknown').checked || /^unknown$/i.test(name);
    if (!name && !unknown) { status.textContent = 'Enter a name, or check Name not known'; return; }
    if (unknown && !$('person-role').value.trim()) { status.textContent = 'Enter a role (it shows in place of the name)'; return; }
    $('person-save').disabled = true;
    status.textContent = 'Saving...';
    try {
      const list = await latestPeople();
      const isNew = !editing;
      const person = editing ? { ...(list.find((item) => item.id === editing.id) || editing) } : { id: uniqueId(unknown ? 'unknown ' + $('person-role').value.trim() : name, list) };
      person.name = unknown && /^unknown$/i.test(name) ? '' : name;
      person.nameUnknown = unknown;
      person.role = $('person-role').value.trim();
      person.group = $('person-group').value.trim();
      person.icon = $('person-icon').value.trim();
      if (!person.icon) delete person.icon;
      if (person.group && !rosterGroups.includes(person.group)) rosterGroups = [...rosterGroups, person.group];
      if (cropFrame) {
        const size = 256;
        const output = document.createElement('canvas');
        output.width = size;
        output.height = size;
        const context = output.getContext('2d');
        context.beginPath();
        context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        context.clip();
        context.drawImage(cropFrame, crop.x - crop.r, crop.y - crop.r, crop.r * 2, crop.r * 2, 0, 0, size, size);
        const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error('the browser could not encode the photo');
        await putFile(page.peopleUrl + '/' + person.id + '.png', blob, 'image/png');
        person.photo = person.id + '.png';
        person.photoVersion = Date.now();
        person.photoFrom = { session: page.sessionArg, positionSeconds: Number(position.toFixed(3)) };
      }
      if (removePhoto && !cropFrame) {
        delete person.photo;
        delete person.photoVersion;
        delete person.photoFrom;
      }
      person.updatedAt = new Date().toISOString();
      await savePeople([...list.filter((item) => item.id !== person.id), person]);
      $('person-dialog').close();
      renderPeople();
      // Someone just added is usually the one speaking.
      if (isNew) toggleSpeaker(person.id); else speakersChanged();
    } catch (error) {
      status.textContent = 'Not saved: ' + error.message;
    } finally {
      $('person-save').disabled = false;
    }
  });
  $('person-delete').addEventListener('click', async () => {
    if (!editing || !confirm('Remove ' + editing.name + ' from the list of people? Their marks in meetings stay, shown by id.')) return;
    try {
      await savePeople((await latestPeople()).filter((item) => item.id !== editing.id));
      $('person-dialog').close();
      renderPeople();
      speakersChanged();
    } catch (error) {
      $('person-status').textContent = 'Not removed: ' + error.message;
    }
  });
  // Clicking a face clips that person's whole stretch: from the change where they started speaking to the change
  // where they stopped (consecutive changes they stay part of, such as someone else joining in, count as one).
  // Then it opens Boost & re-transcribe for that range.
  function clipSpeaker(id, seconds) {
    const index = turnIndexAt(seconds);
    if (index < 0 || !turns[index].speakers.includes(id)) return;
    let first = index;
    while (first > 0 && turns[first - 1].speakers.includes(id)) first -= 1;
    let last = index;
    while (last + 1 < turns.length && turns[last + 1].speakers.includes(id)) last += 1;
    start = turns[first].at;
    end = last + 1 < turns.length ? turns[last + 1].at : endSeconds;
    update();
    showPosition(start);
    const person = peopleMap.get(id);
    $('boost-open').click();
    $('boost-status').textContent = 'Clip set to ' + (person ? shownName(person) : id) + ' speaking, ' + fmt(start) + '-' + fmt(end) + '. Close this to keep the clip for extracting instead.';
  }
  // Above the transcript: the camera or slide showing at the current moment (it switches the instant a change
  // happens), with the faces of whoever is speaking.
  let nowScene = -2;
  function updateNowScene() {
    const scenes = page.scenes;
    let index = -1;
    for (let next = 0; next < scenes.length && scenes[next][0] <= position + 0.05; next += 1) index = next;
    if (index === nowScene) return;
    nowScene = index;
    $('now-scene').hidden = index < 0 || !transcript.length;
    if (index < 0) return;
    $('now-scene-image').src = scenes[index][1];
    renderViewSelect();
    $('now-scene-time').textContent = fmt(scenes[index][0]) + (clockMs(scenes[index][0]) === null ? '' : '  ~' + clockFormat.format(new Date(clockMs(scenes[index][0]))));
  }
  $('now-scene').addEventListener('click', () => { if (nowScene >= 0) showPosition(page.scenes[nowScene][0]); });
  function updateNowSpeakers(ids) {
    const faces = $('now-speakers');
    faces.textContent = '';
    ids.forEach((id) => {
      const person = peopleMap.get(id) || { id, name: id };
      const face = avatar(person);
      face.title = nameAndRole(person) + ' — click to clip everything they say here';
      face.addEventListener('click', (event) => { event.stopPropagation(); clipSpeaker(id, position); });
      faces.appendChild(face);
    });
  }
  // Transcript panel: the line being spoken is highlighted and kept in view; clicking a line jumps there.
  // Served pages load the latest transcript (with current corrections); otherwise the copy built into the page.
  let transcript = page.transcript;
  let activeLine = -1;
  let userScrolledAt = 0;
  const transcriptList = $('transcript-list');
  // Lines are grouped into sections, one per camera or slide change, each opened by a small image of the change.
  let lineElements = [];
  function renderTranscript() {
    const keepScroll = transcriptList.scrollTop;
    transcriptList.textContent = '';
    lineElements = [];
    $('transcript').hidden = transcript.length === 0;
    nowScene = -2;
    const scenes = page.scenes;
    let sceneIndex = -1;
    let section = document.createElement('section');
    transcriptList.appendChild(section);
    let previousSpeakers = '';
    let agendaIndex = 0;
    let shownLines = 0;
    const range = transcriptRange;
    const inRange = (seconds) => !range || (seconds >= range.min - 0.01 && seconds < range.max);
    // Each vote puts rows in the transcript: when the motion was made, when it was seconded, and the vote itself.
    const voteEvents = [];
    voteData.votes.forEach((vote) => {
      const nameOf = (entry) => shownName(peopleMap.get(entry.id) || { id: entry.id, name: entry.id });
      if (vote.movedBy?.id && vote.movedBy.at !== null && vote.movedBy.at !== undefined) {
        voteEvents.push({ at: vote.movedBy.at, text: '✋ ' + fmt(vote.movedBy.at) + '  Motion by ' + nameOf(vote.movedBy) + (vote.motion ? ': ' + vote.motion : '') });
      }
      if (vote.secondedBy?.id && vote.secondedBy.at !== null && vote.secondedBy.at !== undefined) {
        voteEvents.push({ at: vote.secondedBy.at, text: '✋ ' + fmt(vote.secondedBy.at) + '  Seconded by ' + nameOf(vote.secondedBy) });
      }
      const decided = decidedAt(vote);
      voteEvents.push({ at: vote.at, text: '🗳 ' + fmt(vote.at) + '  Vote: ' + (vote.motion || 'motion') + ' — ' + describeTally(vote) + (decided !== null ? ' (decided ' + fmt(decided) + ')' : '') });
    });
    const sortedVotes = voteEvents.sort((left, right) => left.at - right.at);
    let voteIndex = 0;
    const voteRow = (event) => {
      const row = document.createElement('div');
      row.className = 'vote-row';
      row.textContent = event.text;
      row.addEventListener('click', () => showPosition(event.at));
      section.appendChild(row);
    };
    const agendaHeading = (item) => {
      const heading = document.createElement('h3');
      heading.className = 'agenda-heading';
      heading.textContent = item.title;
      const when = document.createElement('small');
      when.textContent = fmt(item.at) + (clockMs(item.at) === null ? '' : '  ~' + clockFormat.format(new Date(clockMs(item.at))));
      heading.appendChild(when);
      heading.addEventListener('click', () => showPosition(item.at));
      section.appendChild(heading);
      previousSpeakers = '';
    };
    const startSection = (scene) => {
      previousSpeakers = '';
      section = document.createElement('section');
      const figure = document.createElement('figure');
      const image = document.createElement('img');
      image.loading = 'lazy';
      image.alt = '';
      image.src = scene[1];
      const caption = document.createElement('figcaption');
      caption.textContent = fmt(scene[0]) + (clockMs(scene[0]) === null ? '' : '  ~' + clockFormat.format(new Date(clockMs(scene[0]))));
      figure.append(image, caption);
      figure.addEventListener('click', () => showPosition(scene[0]));
      section.appendChild(figure);
      transcriptList.appendChild(section);
    };
    transcript.forEach(([startSeconds, endSeconds, text, retranscribed], index) => {
      if (!inRange(startSeconds)) return;
      // Open a section for every scene change up to this line (the last one before the line gets its own).
      while (sceneIndex + 1 < scenes.length && scenes[sceneIndex + 1][0] <= startSeconds + 0.5) {
        sceneIndex += 1;
        if (sceneIndex + 1 < scenes.length && scenes[sceneIndex + 1][0] <= startSeconds + 0.5) continue;
        startSection(scenes[sceneIndex]);
      }
      // Agenda items that start by this line come first, as headings.
      while (agendaIndex < agendaItems.length && agendaItems[agendaIndex].at <= startSeconds + 0.5) {
        const item = agendaItems[agendaIndex++];
        if (!range || item.at >= range.min - 0.01) agendaHeading(item);
      }
      // Votes taken by this line, as a row with the result.
      while (voteIndex < sortedVotes.length && sortedVotes[voteIndex].at <= startSeconds + 0.5) {
        const event = sortedVotes[voteIndex++];
        if (!range || event.at >= range.min - 0.01) voteRow(event);
      }
      const line = document.createElement('p');
      line.dataset.index = index;
      if (retranscribed) line.classList.add('retranscribed');
      const stamp = document.createElement('time');
      stamp.textContent = fmt(startSeconds) + (clockMs(startSeconds) === null ? '' : '  ~' + clockFormat.format(new Date(clockMs(startSeconds))));
      // On hover: boost just this line (and a moment either side).
      const lineBoost = document.createElement('button');
      lineBoost.type = 'button';
      lineBoost.className = 'line-boost';
      lineBoost.textContent = '🔊';
      lineBoost.title = 'Boost this line and transcribe it again';
      lineBoost.addEventListener('click', (event) => { event.stopPropagation(); openBoostDialog(Math.max(0, startSeconds - 0.5), endSeconds + 0.5); });
      stamp.appendChild(lineBoost);
      const words = document.createElement('span');
      words.textContent = text;
      line.append(stamp, words);
      // Who is speaking, beside the first line of each speaker change (and again under each new image).
      const ids = speakersAt((startSeconds + endSeconds) / 2);
      if (ids.length && ids.join(',') !== previousSpeakers) {
        const who = document.createElement('span');
        who.className = 'who';
        ids.forEach((id) => {
          const person = peopleMap.get(id) || { id, name: id };
          const item = document.createElement('span');
          item.className = 'who-person';
          item.title = nameAndRole(person) + ' — click to clip everything they say here';
          item.addEventListener('click', (event) => { event.stopPropagation(); clipSpeaker(id, (startSeconds + endSeconds) / 2); });
          const label = document.createElement('small');
          label.textContent = lastName(person);
          item.append(avatar(person), label);
          who.appendChild(item);
        });
        line.classList.add('has-who');
        line.appendChild(who);
      }
      previousSpeakers = ids.join(',');
      line.addEventListener('click', () => { showPosition(startSeconds); });
      section.appendChild(line);
      lineElements[index] = line;
      if (index === findIndex) line.classList.add('match');
      shownLines += 1;
    });
    if (!shownLines && transcript.length) {
      const empty = document.createElement('p');
      empty.className = 'transcript-empty';
      empty.textContent = 'Nothing was said in this chapter.';
      transcriptList.appendChild(empty);
    }
    transcriptList.scrollTop = keepScroll;
    activeLine = -1;
    syncTranscript();
    updateNowScene();
  }
  // Scrolls the list so a line sits a third of the way down.
  function scrollToLine(line) {
    const offset = line.getBoundingClientRect().top - transcriptList.getBoundingClientRect().top;
    transcriptList.scrollTo({ top: Math.max(0, transcriptList.scrollTop + offset - transcriptList.clientHeight / 3), behavior: 'smooth' });
  }
  function lineAt(seconds) {
    let low = 0, high = transcript.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (transcript[middle][0] <= seconds + 0.05) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found;
  }
  function syncTranscript() {
    if (!transcript.length) return;
    const index = lineAt(position);
    if (index === activeLine) return;
    lineElements[activeLine]?.classList.remove('active');
    activeLine = index;
    const line = lineElements[index];
    if (!line) return;
    line.classList.add('active');
    // Don't pull the list away while someone is reading or scrolling it.
    if (Date.now() - userScrolledAt > 4000) {
      scrollToLine(line);
    }
  }
  ['wheel', 'touchmove', 'keydown'].forEach((type) => transcriptList.addEventListener(type, () => { userScrolledAt = Date.now(); }, { passive: true }));
  transcriptList.addEventListener('mousedown', (event) => { if (event.target === transcriptList) userScrolledAt = Date.now(); });

  // Find: results in order, except that while the transcript shows one chapter, that chapter's results come first
  // (then the rest of the meeting, from after the chapter around to before it). ◀ ▶ (or Shift+Enter / Enter) step
  // through them; a result in another chapter moves the video there so its chapter is shown.
  let findIndex = -1;
  let findOrder = [];
  let findCursor = -1;
  let findNeedle = '';
  function computeFindOrder(needle) {
    const matches = transcript.map((line, index) => (line[2].toLowerCase().includes(needle) ? index : -1)).filter((index) => index >= 0);
    const range = transcriptRange;
    if (!range) return { order: matches, inChapter: matches.length };
    const inside = matches.filter((index) => transcript[index][0] >= range.min - 0.01 && transcript[index][0] < range.max);
    const after = matches.filter((index) => transcript[index][0] >= range.max);
    const before = matches.filter((index) => transcript[index][0] < range.min - 0.01);
    return { order: [...inside, ...after, ...before], inChapter: inside.length };
  }
  let findInChapter = 0;
  function stepFind(direction) {
    const needle = $('find').value.trim().toLowerCase();
    transcriptList.querySelectorAll('.match').forEach((line) => line.classList.remove('match'));
    if (!needle) { findIndex = -1; $('find-status').textContent = ''; return; }
    if (needle !== findNeedle) {
      // A new search starts over, in the current chapter when only one is shown.
      const result = computeFindOrder(needle);
      findOrder = result.order;
      findInChapter = result.inChapter;
      findNeedle = needle;
      findCursor = direction > 0 ? -1 : 0;
    }
    if (!findOrder.length) { findIndex = -1; $('find-status').textContent = 'no matches'; return; }
    findCursor = (findCursor + direction + findOrder.length) % findOrder.length;
    findIndex = findOrder[findCursor];
    // In another chapter: move there, which shows that chapter's lines.
    if (!lineElements[findIndex]) showPosition(transcript[findIndex][0]);
    const line = lineElements[findIndex];
    if (line) {
      line.classList.add('match');
      userScrolledAt = Date.now();
      scrollToLine(line);
    }
    $('find-status').textContent = (findCursor + 1) + ' of ' + findOrder.length + (transcriptRange ? ' (' + findInChapter + ' in this chapter)' : '');
  }
  $('find').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    stepFind(event.shiftKey ? -1 : 1);
  });
  $('find').addEventListener('input', () => { findNeedle = ''; });
  $('find-next').addEventListener('click', () => stepFind(1));
  $('find-prev').addEventListener('click', () => stepFind(-1));
  function loadLatestTranscript() {
    return fetch('../transcripts/latest.json', { cache: 'no-store' })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.lines?.length) {
          transcript = data.lines.map((line) => [Number(line.startSeconds), Number(line.endSeconds), line.text, line.retranscribed ? 1 : 0]);
          renderTranscript();
        }
      })
      .catch(() => {});
  }
  if (location.protocol !== 'file:') {
    loadLatestTranscript();
    fetch('../views.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
      if (data) { viewData = { views: data.views || [], sceneViews: data.sceneViews || {} }; sceneViewCache.clear(); refreshCurrentView(); }
    }).catch(() => {});
    fetch('../votes.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
      if (data) { voteData = { members: data.members || [], votes: data.votes || [], seats: data.seats ?? null, needed: data.needed ?? null }; renderVotes(); renderTranscript(); }
    }).catch(() => {});
    fetch('../agenda.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
      if (data?.items) { agendaItems = data.items; renderAgenda(); renderTranscript(); }
    }).catch(() => {});
    fetch('../meeting-info.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
      if (data && typeof data.name === 'string') showMeetingName(data.name);
    }).catch(() => {});
    fetch('../audio-boosts.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
      if (data?.boosts) { playbackBoosts = data.boosts; boost.playingKey = null; updatePlaybackBoost(); }
    }).catch(() => {});
    Promise.all([
      fetch('../speakers.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
      fetch(page.peopleUrl + '/people.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null)
    ]).then(([speakers, roster]) => {
      if (speakers?.turns) turns = speakers.turns;
      if (roster?.people) { people = roster.people; peopleMap = mapPeople(); }
      if (Array.isArray(roster?.groups)) rosterGroups = roster.groups;
      renderPeople();
      speakersChanged();
    });
  }

  // Boost & re-transcribe: pick a portion, adjust the volume while listening, then the local server applies the same
  // adjustment with ffmpeg and transcribes the portion again (retranscribe-range).
  const boost = { from: null, to: null, previewing: false, graph: null, polling: null, playingKey: null };
  function boostSettings() {
    return {
      gainDb: Number($('boost-gain').value),
      highpassHz: $('boost-highpass').checked ? 120 : 0,
      normalize: $('boost-normalize').checked,
      denoise: $('boost-denoise').checked
    };
  }
  function readBoostRange() {
    boost.from = parse($('boost-from').value);
    boost.to = parse($('boost-to').value);
    const valid = boost.from !== null && boost.to !== null && boost.to > boost.from;
    $('boost-length').textContent = valid ? fmt(boost.to - boost.from) + ' long' : 'enter a start before the end';
    ['boost-preview', 'boost-render', 'boost-send', 'boost-save'].forEach((id) => { $(id).disabled = !valid; });
    return valid;
  }
  // Live preview: the video's sound runs through the browser's audio graph (high-pass, gain, and a compressor that
  // stands in for the server's loudness evening; with that off it only keeps loud moments from clipping).
  function ensureGraph() {
    if (boost.graph) return boost.graph;
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const source = context.createMediaElementSource(video);
    const highpass = context.createBiquadFilter();
    highpass.type = 'highpass';
    const gain = context.createGain();
    const compressor = context.createDynamicsCompressor();
    source.connect(highpass).connect(gain).connect(compressor).connect(context.destination);
    boost.graph = { context, highpass, gain, compressor };
    return boost.graph;
  }
  // Sets the audio graph to boost settings, or to pass the sound through unchanged (null).
  function setGraph(settings) {
    const graph = boost.graph;
    if (!graph) return;
    const active = Boolean(settings);
    graph.highpass.frequency.value = active && settings.highpassHz ? settings.highpassHz : 10;
    graph.gain.gain.value = active ? Math.pow(10, (settings.gainDb || 0) / 20) : 1;
    graph.compressor.threshold.value = !active ? 0 : (settings.normalize ? -45 : -3);
    graph.compressor.ratio.value = !active ? 1 : (settings.normalize ? 8 : 20);
    graph.compressor.knee.value = active && settings.normalize ? 20 : 0;
    graph.compressor.attack.value = 0.005;
    graph.compressor.release.value = 0.25;
  }
  // The dialog's settings while it's open; otherwise whatever saved boost applies at this moment.
  function applyLiveBoost(active) {
    $('boost-gain-value').textContent = (Number($('boost-gain').value) >= 0 ? '+' : '') + $('boost-gain').value + ' dB';
    if (active) setGraph(boostSettings());
    else { boost.playingKey = null; updatePlaybackBoost(); }
  }

  // Saved playback boosts ({session}/audio-boosts.json): ranges with the settings to hear them with.
  let playbackBoosts = page.boosts;
  function boostAt(seconds) {
    return playbackBoosts.find((item) => seconds >= item.from && seconds < item.to) || null;
  }
  const describeBoost = (settings) => ((settings.gainDb >= 0 ? '+' : '') + settings.gainDb + ' dB'
    + (settings.normalize ? ', evened' : '') + (settings.highpassHz ? ', rumble cut' : '') + (settings.denoise ? ', noise reduced' : ''));
  function updatePlaybackBoost() {
    if ($('boost-dialog').open) return;
    const enabled = $('play-boosts').checked;
    const found = enabled ? boostAt(position) : null;
    const key = found ? found.id : '';
    if (key === boost.playingKey && key) return;
    boost.playingKey = key;
    if (found && !boost.graph && playerReady) {
      ensureGraph().context.resume().catch(() => {});
    }
    setGraph(found);
    // Short in the toolbar; the details are in its tooltip.
    $('boost-active').textContent = found ? '🔊 ' + (found.gainDb >= 0 ? '+' : '') + found.gainDb + ' dB' : (enabled && !playbackBoosts.length ? '🔊 none saved' : '');
    $('boost-active').title = found ? 'Boosted: ' + describeBoost(found) : (enabled && !playbackBoosts.length ? 'No boosts saved yet: save one in 🔊 Boost & re-transcribe' : '');
  }
  function setPlayBoosts(enabled) {
    $('play-boosts').checked = enabled;
    try { localStorage.setItem('thumbnails.playBoosts', enabled ? '1' : '0'); } catch {}
    boost.playingKey = null;
    updatePlaybackBoost();
  }
  $('play-boosts').addEventListener('change', () => setPlayBoosts($('play-boosts').checked));
  video.addEventListener('play', () => { boost.graph?.context.resume().catch(() => {}); boost.playingKey = null; updatePlaybackBoost(); });
  async function saveBoosts() {
    if (location.protocol === 'file:') throw new Error('saving needs the local server (npm run serve)');
    const response = await fetch('../audio-boosts.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updatedAt: new Date().toISOString(), note: 'Volume boosts to play during playback; set from the thumbnails page.', boosts: playbackBoosts }, null, 2) });
    if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
  }
  // A new boost replaces whatever saved boosts covered the same stretch (the parts outside it stay).
  async function addPlaybackBoost(from, to, settings) {
    const next = [];
    for (const item of playbackBoosts) {
      if (item.to <= from || item.from >= to) { next.push(item); continue; }
      if (item.from < from) next.push({ ...item, to: from });
      if (item.to > to) next.push({ ...item, id: item.id + '-b', from: to });
    }
    next.push({ id: Date.now().toString(36), from: Number(from.toFixed(3)), to: Number(to.toFixed(3)), ...settings, createdAt: new Date().toISOString() });
    playbackBoosts = next.sort((left, right) => left.from - right.from);
    await saveBoosts();
    renderSavedBoosts();
    boost.playingKey = null;
  }
  function renderSavedBoosts() {
    const list = $('boost-saved');
    list.textContent = '';
    if (!playbackBoosts.length) {
      const empty = document.createElement('li');
      empty.textContent = 'None yet.';
      list.appendChild(empty);
      return;
    }
    playbackBoosts.forEach((item) => {
      const row = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = fmt(item.from) + '-' + fmt(item.to) + ' · ' + describeBoost(item);
      const go = document.createElement('button');
      go.type = 'button';
      go.textContent = 'Go';
      go.addEventListener('click', () => showPosition(item.from));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        const before = playbackBoosts;
        playbackBoosts = playbackBoosts.filter((other) => other !== item);
        try {
          await saveBoosts();
          renderSavedBoosts();
        } catch (error) {
          playbackBoosts = before;
          $('boost-status').textContent = 'Not removed: ' + error.message;
        }
      });
      row.append(text, go, remove);
      list.appendChild(row);
    });
  }
  $('boost-save').addEventListener('click', async () => {
    if (!readBoostRange()) return;
    try {
      await addPlaybackBoost(boost.from, boost.to, boostSettings());
      if (!$('play-boosts').checked) setPlayBoosts(true);
      $('boost-status').textContent = 'Saved: ' + fmt(boost.from) + '-' + fmt(boost.to) + ' plays boosted while "Boost quiet speakers" is checked.';
    } catch (error) {
      $('boost-status').textContent = 'Not saved: ' + error.message;
    }
  });
  function stopBoostPreview() {
    if (boost.previewing) video.pause();
    boost.previewing = false;
    $('boost-preview').textContent = '▶ Listen here';
  }
  async function toggleBoostPreview() {
    if (boost.previewing) { stopBoostPreview(); return; }
    if (!readBoostRange()) return;
    try {
      $('boost-audio').pause();
      if (!playerReady) {
        $('boost-status').textContent = 'Loading video...';
        await initPlayer();
        setStatus('Play');
        $('play').disabled = false;
      }
      const graph = ensureGraph();
      await graph.context.resume();
      applyLiveBoost(true);
      showPosition(boost.from);
      await seekTo(toPlayerTime(boost.from));
      boost.previewing = true;
      $('boost-preview').textContent = '⏹ Stop';
      $('boost-status').textContent = '';
      await video.play();
    } catch (error) {
      stopBoostPreview();
      $('boost-status').textContent = 'Could not play: ' + error.message;
    }
  }
  video.addEventListener('timeupdate', () => {
    if (boost.previewing && toPosition(video.currentTime) >= boost.to) stopBoostPreview();
  });
  video.addEventListener('pause', () => { if (boost.previewing) { boost.previewing = false; $('boost-preview').textContent = '▶ Listen here'; } });

  // Server jobs: POST ../retranscribe, then follow ../retranscribe/jobs/{job}.json until it finishes.
  async function startBoostJob(body) {
    if (location.protocol === 'file:') throw new Error('this needs the local server (npm run serve)');
    const response = await fetch('../retranscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
    const started = await response.json();
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const check = async () => {
        const job = await fetch('../' + started.statusUrl, { cache: 'no-store' }).then((reply) => (reply.ok ? reply.json() : null)).catch(() => null);
        if (job?.status === 'done') { resolve(job); return; }
        if (job?.status === 'failed') { reject(new Error(job.message || 'the job failed')); return; }
        if (job?.message) $('boost-status').textContent = job.message + ' (' + Math.round((Date.now() - startedAt) / 1000) + 's)';
        setTimeout(check, 1500);
      };
      setTimeout(check, 700);
    });
  }
  function setBoostBusy(busy) {
    ['boost-render', 'boost-send', 'boost-save'].forEach((id) => { $(id).disabled = busy; });
    if (!busy) readBoostRange();
  }
  $('boost-render').addEventListener('click', async () => {
    if (!readBoostRange()) return;
    stopBoostPreview();
    setBoostBusy(true);
    $('boost-status').textContent = 'Asking the server for the adjusted audio...';
    try {
      const job = await startBoostJob({ action: 'preview', from: boost.from, to: boost.to, ...boostSettings() });
      const audio = $('boost-audio');
      audio.src = '../retranscribe/' + job.preview;
      audio.hidden = false;
      $('boost-status').textContent = "This is the server's version of " + fmt(boost.from) + '-' + fmt(boost.to) + '.';
      await audio.play().catch(() => {});
    } catch (error) {
      $('boost-status').textContent = 'Could not make the adjusted audio: ' + error.message;
    } finally {
      setBoostBusy(false);
    }
  });
  $('boost-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!readBoostRange()) return;
    stopBoostPreview();
    setBoostBusy(true);
    $('boost-status').textContent = 'Sending to the server...';
    try {
      const job = await startBoostJob({ action: 'transcribe', from: boost.from, to: boost.to, quality: $('boost-quality').value, ...boostSettings() });
      $('boost-status').textContent = job.message;
      if ($('boost-keep').checked) {
        await addPlaybackBoost(boost.from, boost.to, boostSettings()).catch((error) => { $('boost-status').textContent += ' (playback boost not saved: ' + error.message + ')'; });
        if (!$('play-boosts').checked) setPlayBoosts(true);
      }
      await loadLatestTranscript();
      await renderPortions();
    } catch (error) {
      $('boost-status').textContent = 'Not re-transcribed: ' + error.message;
    } finally {
      setBoostBusy(false);
    }
  });
  async function renderPortions() {
    const list = $('boost-portions');
    list.textContent = '';
    const index = location.protocol === 'file:' ? null
      : await fetch('../transcripts/retranscribed.json', { cache: 'no-store' }).then((reply) => (reply.ok ? reply.json() : null)).catch(() => null);
    const portions = index?.portions || [];
    if (!portions.length) {
      const empty = document.createElement('li');
      empty.textContent = 'None yet.';
      list.appendChild(empty);
      return;
    }
    portions.forEach((portion) => {
      const item = document.createElement('li');
      const text = document.createElement('span');
      const settings = portion.settings || {};
      text.textContent = fmt(portion.from) + '-' + fmt(portion.to) + ' · ' + (settings.gainDb >= 0 ? '+' : '') + settings.gainDb + ' dB'
        + (settings.normalize ? ', evened' : '') + (settings.highpassHz ? ', rumble cut' : '') + (settings.denoise ? ', noise reduced' : '')
        + ' · ' + portion.quality + ' · ' + portion.lines.length + ' lines';
      const go = document.createElement('button');
      go.type = 'button';
      go.textContent = 'Go';
      go.addEventListener('click', () => showPosition(portion.from));
      const undo = document.createElement('button');
      undo.type = 'button';
      undo.textContent = 'Undo';
      undo.addEventListener('click', async () => {
        undo.disabled = true;
        try {
          await startBoostJob({ action: 'remove', portionId: portion.id });
          $('boost-status').textContent = 'Undone; the original lines for ' + fmt(portion.from) + '-' + fmt(portion.to) + ' are back.';
          await loadLatestTranscript();
          await renderPortions();
        } catch (error) {
          $('boost-status').textContent = 'Not undone: ' + error.message;
          undo.disabled = false;
        }
      });
      // Older portions were made before playback boosts were saved automatically.
      const keep = document.createElement('button');
      keep.type = 'button';
      keep.textContent = '🔊 Boost playback';
      keep.title = "Save this portion's settings as a playback boost";
      keep.addEventListener('click', async () => {
        try {
          await addPlaybackBoost(portion.from, portion.to, { gainDb: settings.gainDb || 0, highpassHz: settings.highpassHz || 0, normalize: Boolean(settings.normalize), denoise: Boolean(settings.denoise) });
          if (!$('play-boosts').checked) setPlayBoosts(true);
          $('boost-status').textContent = fmt(portion.from) + '-' + fmt(portion.to) + ' now plays boosted.';
        } catch (error) {
          $('boost-status').textContent = 'Not saved: ' + error.message;
        }
      });
      item.append(text, go, keep, undo);
      list.appendChild(item);
    });
  }
  $('boost-open').addEventListener('click', () => {
    // Start from the clip range, or the next 30 seconds from here.
    let from = start, to = end;
    if (from !== null && to !== null && to < from) [from, to] = [to, from];
    if (from === null || to === null || to <= from) { from = position; to = Math.min(endSeconds, position + 30); }
    openBoostDialog(from, to);
  });
  function openBoostDialog(from, to) {
    $('boost-from').value = fmtPrecise(Math.max(0, from));
    $('boost-to').value = fmtPrecise(Math.min(endSeconds, to));
    $('boost-status').textContent = location.protocol === 'file:' ? 'Listening works here once the video plays; sending needs the local server (npm run serve).' : '';
    readBoostRange();
    renderPortions();
    renderSavedBoosts();
    if (!$('boost-dialog').open) $('boost-dialog').showModal();
    applyLiveBoost(true);
    loadWaveform();
  }
  ['boost-from', 'boost-to'].forEach((id) => $(id).addEventListener('input', () => { stopBoostPreview(); readBoostRange(); }));
  ['boost-gain', 'boost-normalize', 'boost-highpass'].forEach((id) => $(id).addEventListener('input', () => applyLiveBoost(true)));
  $('boost-preview').addEventListener('click', toggleBoostPreview);
  $('boost-close').addEventListener('click', () => $('boost-dialog').close());
  $('boost-dialog').addEventListener('close', () => {
    stopBoostPreview();
    $('boost-audio').pause();
    applyLiveBoost(false);
  });
  // Edits text on the video in place: Enter (or clicking elsewhere) saves, Escape cancels.
  let inlineEditing = false;
  function inlineEdit(element, current, save) {
    if (inlineEditing) return;
    inlineEditing = true;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-edit';
    input.value = current;
    element.classList.remove('editable-text');
    element.textContent = '';
    element.appendChild(input);
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      inlineEditing = false;
      element.classList.add('editable-text');
      const value = input.value.trim();
      if (keep && value !== current) await save(value);
      else element.textContent = current;
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('blur', () => finish(true));
    input.focus();
    input.select();
  }
  // Meeting name: the page title and, with "Show meeting name", on the video, where clicking it edits it. Saved to
  // {session}/meeting-info.json through the local server.
  let meetingName = page.meetingName;
  function showMeetingName(name) {
    meetingName = name;
    document.title = name || 'Meeting Thumbnails';
    // Without a name yet, a placeholder on the video is what gets clicked to name the meeting.
    if (!inlineEditing) $('title-overlay').textContent = name || 'Meeting name';
    $('title-overlay').classList.toggle('placeholder', !name);
    $('title-overlay').hidden = !$('show-name').checked;
    stackChapter();
  }
  async function saveMeetingName(name) {
    try {
      if (location.protocol === 'file:') throw new Error('saving needs the local server (npm run serve)');
      const response = await fetch('../meeting-info.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, updatedAt: new Date().toISOString() }, null, 2) });
      if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
      showMeetingName(name);
      $('snapshot-status').textContent = 'Saved the meeting name';
      return true;
    } catch (error) {
      showMeetingName(meetingName);
      $('snapshot-status').textContent = 'Meeting name not saved: ' + error.message;
      return false;
    }
  }
  $('title-overlay').classList.add('editable-text');
  $('title-overlay').title = 'Click to edit the meeting name';
  $('title-overlay').addEventListener('click', (event) => {
    event.stopPropagation();
    inlineEdit($('title-overlay'), meetingName, saveMeetingName);
  });
  function setShowName(visible) {
    $('show-name').checked = visible;
    try { localStorage.setItem('thumbnails.showName', visible ? '1' : '0'); } catch {}
    showMeetingName(meetingName);
  }
  $('show-name').addEventListener('change', () => setShowName($('show-name').checked));
  try { if (localStorage.getItem('thumbnails.showName') === '1') $('show-name').checked = true; } catch {}
  showMeetingName(meetingName);
  // Agenda: items that start at video positions ({session}/agenda.json, saved through the local server). They are
  // listed under the video (click to jump) and shown as headings in the transcript.
  let agendaItems = [...page.agenda].sort((left, right) => left.at - right.at);
  let agendaEditing = null;
  let agendaCurrent = -2;
  function agendaIndexAt(seconds) {
    let found = -1;
    agendaItems.forEach((item, index) => { if (item.at <= seconds + 0.25) found = index; });
    return found;
  }
  function updateAgendaCurrent() {
    const index = agendaIndexAt(position);
    if (index === agendaCurrent) return;
    agendaCurrent = index;
    [...$('agenda-list').children].forEach((item, itemIndex) => item.classList.toggle('current', itemIndex === index));
    // Keep the current item in view inside the list (without scrolling the page).
    const current = $('agenda-list').children[index];
    if (current) {
      const list = $('agenda-list');
      if (current.offsetTop < list.scrollTop || current.offsetTop + current.offsetHeight > list.scrollTop + list.clientHeight) {
        list.scrollTo({ top: Math.max(0, current.offsetTop - list.clientHeight / 3), behavior: 'smooth' });
      }
    }
    // The item being played, on the video (under the meeting name) when "Show agenda item" is checked.
    const overlay = $('agenda-overlay');
    if (!inlineEditing) overlay.textContent = index < 0 ? '' : agendaItems[index].title;
    overlay.hidden = !$('show-agenda').checked || index < 0;
    stackChapter();
  }
  $('agenda-overlay').classList.add('editable-text');
  $('agenda-overlay').title = 'Click to edit this chapter title';
  $('agenda-overlay').addEventListener('click', (event) => {
    event.stopPropagation();
    const item = agendaItems[agendaCurrent];
    if (!item) return;
    inlineEdit($('agenda-overlay'), item.title, async (title) => {
      if (!title) { $('agenda-overlay').textContent = item.title; return; }
      await changeAgenda(agendaItems.map((other) => (other.id === item.id ? { ...other, title } : other)), 'Saved');
      agendaCurrent = -2;
      updateAgendaCurrent();
    });
  });
  function setShowAgenda(visible) {
    $('show-agenda').checked = visible;
    try { localStorage.setItem('thumbnails.showAgenda', visible ? '1' : '0'); } catch {}
    agendaCurrent = -2;
    updateAgendaCurrent();
  }
  $('show-agenda').addEventListener('change', () => setShowAgenda($('show-agenda').checked));
  try { if (localStorage.getItem('thumbnails.showAgenda') === '1') $('show-agenda').checked = true; } catch {}
  function renderAgenda() {
    const list = $('agenda-list');
    list.textContent = '';
    agendaItems.forEach((item) => {
      const row = document.createElement('li');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      go.title = 'Go to ' + fmt(item.at);
      const when = document.createElement('time');
      when.textContent = fmt(item.at);
      const title = document.createElement('span');
      title.className = 'chapter-title';
      title.textContent = item.title;
      // How long it runs: to the next chapter, or the end of the video.
      const next = agendaItems[agendaItems.indexOf(item) + 1];
      const length = document.createElement('span');
      length.className = 'chapter-length';
      length.textContent = fmt((next ? next.at : endSeconds) - item.at);
      length.title = 'Length of this chapter';
      go.append(when, title, length);
      go.addEventListener('click', () => showPosition(item.at));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'small';
      edit.title = 'Edit';
      edit.textContent = '✎';
      edit.addEventListener('click', () => startAgendaEdit(item));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'small';
      remove.title = 'Remove';
      remove.textContent = '✕';
      remove.addEventListener('click', async () => {
        if (!confirm('Remove the chapter "' + item.title + '"?')) return;
        await changeAgenda(agendaItems.filter((other) => other.id !== item.id), 'Removed');
      });
      row.append(go, edit, remove);
      list.appendChild(row);
    });
    $('agenda-empty').hidden = agendaItems.length > 0;
    agendaCurrent = -2;
    updateAgendaCurrent();
    sliderRangeKey = '';
    updateSliderRange();
    slider.value = position;
  }
  async function changeAgenda(items, done) {
    const previous = agendaItems;
    agendaItems = [...items].sort((left, right) => left.at - right.at);
    try {
      if (location.protocol === 'file:') throw new Error('saving needs the local server (npm run serve)');
      const response = await fetch('../agenda.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updatedAt: new Date().toISOString(), items: agendaItems }, null, 2) });
      if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
      $('agenda-status').textContent = done;
      renderAgenda();
      renderTranscript();
      return true;
    } catch (error) {
      agendaItems = previous;
      $('agenda-status').textContent = 'Not saved: ' + error.message;
      return false;
    }
  }
  function startAgendaEdit(item) {
    agendaEditing = item;
    $('agenda-time').value = fmtPrecise(item.at);
    $('agenda-title-input').value = item.title;
    $('agenda-save').textContent = 'Save';
    $('agenda-cancel').hidden = false;
    $('agenda-status').textContent = '';
    $('agenda-title-input').focus();
  }
  function resetAgendaForm() {
    agendaEditing = null;
    $('agenda-title-input').value = '';
    $('agenda-time').value = '';
    $('agenda-save').textContent = 'Add';
    $('agenda-cancel').hidden = true;
  }
  $('agenda-now').addEventListener('click', () => { $('agenda-time').value = fmtPrecise(position); });
  $('agenda-cancel').addEventListener('click', resetAgendaForm);
  $('agenda-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const title = $('agenda-title-input').value.trim();
    // An empty time means the current position.
    const at = $('agenda-time').value.trim() ? parse($('agenda-time').value) : position;
    if (!title) { $('agenda-status').textContent = 'Enter a title'; return; }
    if (at === null || at < 0 || at > endSeconds) { $('agenda-status').textContent = 'Enter a time between 00:00:00 and ' + fmt(endSeconds); return; }
    const item = { id: agendaEditing ? agendaEditing.id : Date.now().toString(36), at: Number(at.toFixed(3)), title };
    const items = agendaEditing ? agendaItems.map((other) => (other.id === agendaEditing.id ? item : other)) : [...agendaItems, item];
    if (await changeAgenda(items, (agendaEditing ? 'Saved ' : 'Added ') + fmt(item.at))) resetAgendaForm();
  });
  renderAgenda();
  // Toolbar: show or hide the chapters, and jump between them.
  function setChaptersShown(shown) {
    $('agenda-panel').hidden = !shown;
    $('chapters-toggle').setAttribute('aria-pressed', shown ? 'true' : 'false');
    try { localStorage.setItem('thumbnails.chaptersShown', shown ? '1' : '0'); } catch {}
  }
  $('chapters-toggle').addEventListener('click', () => setChaptersShown($('agenda-panel').hidden));
  try { setChaptersShown(localStorage.getItem('thumbnails.chaptersShown') !== '0'); } catch { setChaptersShown(true); }
  $('chapter-prev').addEventListener('click', () => {
    // To the start of this chapter, or the one before when already at its start.
    const previous = [...agendaItems].reverse().find((item) => item.at < position - 1.5);
    showPosition(previous ? previous.at : 0);
  });
  $('chapter-next').addEventListener('click', () => {
    const next = agendaItems.find((item) => item.at > position + 0.5);
    if (next) showPosition(next.at);
  });
  // Votes ({session}/votes.json, saved through the local server): the meeting's voting members (with when anyone
  // left or arrived), and each vote's time, motion, every member's choice, and outcome.
  let voteData = { members: page.votes.members || [], votes: page.votes.votes || [], seats: page.votes.seats ?? null, needed: page.votes.needed ?? null };
  // Each vote keeps every member's status changes in order ({ id, choice, at }), so the roll call can be replayed.
  const cycle = ['pending', 'for', 'against', 'abstain', 'absent'];
  const choiceNames = { for: 'Aye', against: 'Nay', abstain: 'Abstain', absent: 'Absent', pending: 'Not voted' };
  const choiceMarks = { for: '✔', against: '✖', abstain: '–', absent: '', pending: '' };
  // Short label: a person's last name; a group entry (with an icon) or unknown name in full.
  const lastName = (person) => (isNameUnknown(person) || person.icon ? shownName(person) : (person.name.split(' ').filter(Boolean).slice(-1)[0] || person.name));
  // The district from a role such as "Supervisor, South River District" (shown without the word District).
  function districtOf(person) {
    const parts = String(person.role || '').split(',').map((part) => part.trim()).filter(Boolean);
    const district = parts.find((part) => /district/i.test(part)) || (parts.length > 1 ? parts[parts.length - 1] : '');
    return district.replace(/ *district$/i, '');
  }
  function memberPresent(member, seconds) {
    return !((member.leftAt !== null && member.leftAt !== undefined && seconds >= member.leftAt)
      || (member.arrivedAt !== null && member.arrivedAt !== undefined && seconds < member.arrivedAt));
  }
  // Votes saved before the roll call was recorded only have final results: treat them as cast when the vote opened.
  function voteChanges(vote) {
    if (Array.isArray(vote.changes)) return vote.changes;
    return Object.entries(vote.results || {}).filter(([, choice]) => choice !== 'absent').map(([id, choice]) => ({ id, choice, at: vote.at }));
  }
  function voterIds(vote, changes) {
    // Current members, plus anyone recorded in this vote who has since been unchecked.
    const ids = voteData.members.map((item) => item.id);
    (changes || (vote ? voteChanges(vote) : [])).forEach((change) => { if (!ids.includes(change.id)) ids.push(change.id); });
    Object.keys(vote?.results || {}).forEach((id) => { if (!ids.includes(id)) ids.push(id); });
    return ids;
  }
  // A member's status at a moment: their latest change by then; absent if they weren't in the meeting when the vote
  // opened; otherwise not voted yet.
  function statusAt(vote, id, seconds, changes) {
    let found = null;
    for (const change of changes || voteChanges(vote)) {
      if (change.id === id && change.at <= seconds + 0.05 && (!found || change.at >= found.at)) found = change;
    }
    if (found) return found.choice;
    const member = voteData.members.find((item) => item.id === id);
    return member && !memberPresent(member, vote.at) ? 'absent' : 'pending';
  }
  function voteRule(memberCount) {
    const seats = voteData.seats || memberCount;
    const needed = voteData.needed || Math.floor(seats / 2) + 1;
    return { seats, needed, failAt: Math.max(1, seats - needed + 1) };
  }
  // Counts and outcome at a moment. Passes once enough ayes are in; fails once nays and absences make that
  // impossible, or when everyone has voted without enough ayes (abstentions); otherwise still voting.
  function voteState(vote, seconds = Infinity, changes) {
    const list = changes || voteChanges(vote);
    const ids = voterIds(vote, list);
    const counts = { for: 0, against: 0, abstain: 0, absent: 0, pending: 0 };
    const statuses = {};
    ids.forEach((id) => { const status = statusAt(vote, id, seconds, list); statuses[id] = status; counts[status] += 1; });
    const rule = voteRule(ids.length);
    let outcome = 'pending';
    if (counts.for >= rule.needed) outcome = 'passed';
    else if (counts.against + counts.absent >= rule.failAt || counts.pending === 0) outcome = 'failed';
    if (seconds === Infinity && (vote.outcome === 'passed' || vote.outcome === 'failed')) outcome = vote.outcome;
    return { counts, statuses, outcome, rule };
  }
  // When the outcome was settled (the first moment it stopped being pending), or null.
  function decidedAt(vote) {
    const times = [...new Set(voteChanges(vote).map((change) => change.at))].sort((a, b) => a - b);
    return times.find((time) => voteState(vote, time).outcome !== 'pending') ?? null;
  }
  function describeTally(vote, seconds = Infinity, changes) {
    const state = voteState(vote, seconds, changes);
    const { counts } = state;
    if (state.outcome === 'pending') {
      return (seconds === Infinity ? 'Undecided: ' : 'Voting: ') + counts.for + ' aye, ' + counts.against + ' nay'
        + (counts.abstain ? ', ' + counts.abstain + ' abstain' : '') + (counts.absent ? ', ' + counts.absent + ' absent' : '') + (counts.pending ? ', ' + counts.pending + ' not voted' : '');
    }
    const extras = [counts.abstain ? counts.abstain + ' abstained' : '', counts.absent ? counts.absent + ' absent' : '', counts.pending ? counts.pending + ' not voted' : ''].filter(Boolean).join(', ');
    return (state.outcome === 'passed' ? 'Passed ' : 'Failed ') + counts.for + '–' + counts.against + (extras ? ' (' + extras + ')' : '');
  }
  async function saveVotes(done) {
    try {
      if (location.protocol === 'file:') throw new Error('saving needs the local server (npm run serve)');
      const response = await fetch('../votes.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updatedAt: new Date().toISOString(), seats: voteData.seats, needed: voteData.needed, members: voteData.members, votes: voteData.votes }, null, 2) });
      if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
      $('votes-status').textContent = done || 'Saved';
      renderVotes();
      renderTranscript();
      return true;
    } catch (error) {
      $('votes-status').textContent = 'Not saved: ' + error.message;
      return false;
    }
  }

  // Votes list under the video.
  function renderVotes() {
    voteData.votes.sort((left, right) => left.at - right.at);
    const list = $('vote-list');
    list.textContent = '';
    voteData.votes.forEach((vote) => {
      const row = document.createElement('li');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      const when = document.createElement('time');
      when.textContent = fmt(vote.at);
      const text = document.createElement('span');
      text.className = 'vote-text';
      text.textContent = vote.motion || 'Vote';
      // Members' icons with their votes, 1 and 2 on whoever moved and seconded, and a border showing the result:
      // solid green when it passed, dotted red when it failed (not by color alone), dashed while undecided.
      const state = voteState(vote, Infinity);
      const faces = document.createElement('span');
      faces.className = 'vote-faces ' + state.outcome;
      const credit = (entry, verb) => (entry?.id ? verb + ' by ' + shownName(peopleMap.get(entry.id) || { id: entry.id, name: entry.id }) : '');
      faces.title = [describeTally(vote), credit(vote.movedBy, 'moved'), credit(vote.secondedBy, 'seconded')].filter(Boolean).join('; ');
      faces.setAttribute('aria-label', faces.title);
      voterIds(vote, voteChanges(vote)).forEach((id) => {
        const person = peopleMap.get(id) || { id, name: id };
        const status = state.statuses[id] || statusAt(vote, id, Infinity);
        const face = document.createElement('span');
        face.className = 'vote-face' + (status === 'absent' ? ' absent' : '') + (status === 'pending' ? ' pending' : '');
        const order = vote.movedBy?.id === id ? 1 : (vote.secondedBy?.id === id ? 2 : 0);
        face.title = shownName(person) + ': ' + choiceNames[status] + (order === 1 ? ' (moved)' : order === 2 ? ' (seconded)' : '');
        face.appendChild(avatar(person));
        if (status !== 'absent' && status !== 'pending') {
          const badge = document.createElement('span');
          badge.className = 'vote-badge choice-' + status;
          badge.textContent = choiceMarks[status];
          face.appendChild(badge);
        }
        if (order) {
          const number = document.createElement('span');
          number.className = 'vote-order';
          number.textContent = String(order);
          face.appendChild(number);
        }
        faces.appendChild(face);
      });
      go.append(when, text, faces);
      go.addEventListener('click', () => showPosition(vote.at));
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'small';
      edit.title = 'Edit';
      edit.textContent = '✎';
      edit.addEventListener('click', () => openVoteEditor(vote));
      row.append(go, edit);
      list.appendChild(row);
    });
    $('votes-empty').hidden = voteData.votes.length > 0;
    if (pageReady) renderScrubMarks();
    renderMembers();
    renderSeatOrder();
    showVoteRule();
    voteOverlayKey = null;
    updateVoteOverlay();
  }

  // Voting members.
  function renderMembers() {
    const list = $('member-list');
    list.textContent = '';
    if (!people.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No people yet; add them with 🗣️ Speakers.';
      list.appendChild(empty);
      return;
    }
    [...people].sort((a, b) => a.name.localeCompare(b.name)).forEach((person) => {
      const member = voteData.members.find((item) => item.id === person.id);
      const row = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(member);
      box.addEventListener('change', () => {
        voteData.members = box.checked ? [...voteData.members, { id: person.id, leftAt: null, arrivedAt: null }] : voteData.members.filter((item) => item.id !== person.id);
        saveVotes(box.checked ? shownName(person) + ' votes in this meeting' : shownName(person) + ' no longer listed as voting');
      });
      const name = document.createElement('span');
      name.textContent = nameAndRole(person);
      label.append(box, avatar(person), name);
      row.appendChild(label);
      if (member) {
        const moment = (field, verb) => {
          if (member[field] !== null && member[field] !== undefined) {
            const note = document.createElement('span');
            note.className = 'label';
            note.textContent = verb + ' ' + fmt(member[field]);
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.title = 'Clear';
            clear.textContent = '✕';
            clear.addEventListener('click', () => { member[field] = null; saveVotes('Cleared'); });
            row.append(note, clear);
          } else {
            const mark = document.createElement('button');
            mark.type = 'button';
            mark.textContent = verb[0].toUpperCase() + verb.slice(1) + ' here';
            mark.title = verb === 'left' ? 'They left the meeting at the current position' : 'They arrived at the current position';
            mark.addEventListener('click', () => { member[field] = Number(position.toFixed(1)); saveVotes(shownName(person) + ' ' + verb + ' at ' + fmt(position)); });
            row.appendChild(mark);
          }
        };
        moment('leftAt', 'left');
        moment('arrivedAt', 'arrived');
      }
      list.appendChild(row);
    });
  }
  // Left-to-right order of the voting members (the overlay and roll call follow it).
  function renderSeatOrder() {
    const list = $('seat-order');
    list.textContent = '';
    voteData.members.forEach((member, index) => {
      const person = peopleMap.get(member.id) || { id: member.id, name: member.id };
      const item = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = lastName(person);
      const district = document.createElement('small');
      district.textContent = districtOf(person) || ' ';
      const buttons = document.createElement('div');
      const move = (delta, label) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.title = delta < 0 ? 'Move left' : 'Move right';
        button.disabled = index + delta < 0 || index + delta >= voteData.members.length;
        button.addEventListener('click', () => {
          const members = [...voteData.members];
          [members[index], members[index + delta]] = [members[index + delta], members[index]];
          voteData.members = members;
          saveVotes('Saved the seating order');
        });
        buttons.appendChild(button);
      };
      move(-1, '◀');
      move(1, '▶');
      item.append(avatar(person), name, district, buttons);
      list.appendChild(item);
    });
    if (!voteData.members.length) list.textContent = 'Check the voting members above first.';
  }
  function showVoteRule() {
    const rule = voteRule(voteData.members.length);
    $('vote-seats').value = voteData.seats ?? '';
    $('vote-needed').value = voteData.needed ?? '';
    $('vote-seats').placeholder = String(voteData.members.length || 'auto');
    $('vote-needed').placeholder = String(Math.floor(rule.seats / 2) + 1);
    $('vote-rule').textContent = 'A motion passes once ' + rule.needed + ' vote aye; it fails once nays and absences reach ' + rule.failAt + ', or when everyone has voted without ' + rule.needed + ' ayes.';
  }
  for (const field of ['seats', 'needed']) {
    $('vote-' + field).addEventListener('change', () => {
      const value = Number($('vote-' + field).value);
      voteData[field] = Number.isInteger(value) && value > 0 ? value : null;
      showVoteRule();
      saveVotes('Saved the voting rule');
    });
  }
  $('members-toggle').addEventListener('click', () => {
    $('members-panel').hidden = !$('members-panel').hidden;
    renderMembers();
  });

  // Vote editor: a working copy of the roll call, saved with Save.
  let voteEditing = null;
  let editChanges = [];
  let editVote = { at: 0, results: {} };
  function renderVoteMembers() {
    const box = $('vote-members');
    box.textContent = '';
    editVote.at = parse($('vote-time').value) ?? position;
    const ids = voterIds(editVote, editChanges);
    if (!ids.length) {
      box.textContent = 'No voting members yet: check them under Voting members.';
      updateVoteTally();
      return;
    }
    ids.forEach((id) => {
      const person = peopleMap.get(id) || { id, name: id };
      const status = statusAt(editVote, id, position, editChanges);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vote-toggle choice-' + status;
      button.title = 'Click to record ' + shownName(person) + "'s vote at " + fmt(position);
      const name = document.createElement('span');
      name.textContent = lastName(person);
      const label = document.createElement('strong');
      label.textContent = choiceNames[status];
      const history = document.createElement('small');
      history.textContent = editChanges.filter((change) => change.id === id).sort((a, b) => a.at - b.at)
        .map((change) => choiceNames[change.choice] + ' ' + fmt(change.at)).join(', ') || 'no votes recorded';
      button.append(avatar(person), name, label, history);
      button.addEventListener('click', () => toggleVote(id));
      box.appendChild(button);
    });
    updateVoteTally();
  }
  // Records a member's vote at the current moment: the next status after the one they have now. A click within two
  // seconds of their last change changes that entry instead (cycling back to "not voted" removes it).
  function toggledChanges(vote, changes, id, seconds) {
    const at = Number(seconds.toFixed(2));
    let next = [...changes];
    const last = next.filter((change) => change.id === id).sort((a, b) => a.at - b.at).at(-1);
    if (last && Math.abs(last.at - at) <= 2) {
      const choice = cycle[(cycle.indexOf(last.choice) + 1) % cycle.length];
      next = next.filter((change) => change !== last);
      if (choice !== 'pending') next.push({ id, choice, at: last.at });
    } else {
      const current = statusAt(vote, id, at, next);
      const choice = cycle[(cycle.indexOf(current) + 1) % cycle.length];
      next.push({ id, choice: choice === 'pending' ? 'absent' : choice, at });
    }
    return next.sort((a, b) => a.at - b.at);
  }
  function toggleVote(id) {
    editChanges = toggledChanges(editVote, editChanges, id, position);
    renderVoteMembers();
    voteOverlayKey = null;
    updateVoteOverlay();
  }
  function updateVoteTally() {
    const draft = { ...editVote, outcome: $('vote-outcome').value };
    $('vote-tally').textContent = 'At ' + fmt(position) + ': ' + describeTally(draft, position, editChanges) + '. Final: ' + describeTally(draft, Infinity, editChanges) + '.';
  }
  function openVoteEditor(vote) {
    voteEditing = vote || null;
    const at = vote ? vote.at : position;
    editChanges = vote ? voteChanges(vote).map((change) => ({ ...change })) : [];
    editVote = { at, results: vote?.results || {} };
    $('vote-dialog-title').textContent = vote ? 'Edit vote' : 'Record a vote';
    $('vote-time').value = fmtPrecise(at);
    $('vote-show').value = vote?.showSeconds || 20;
    $('vote-motion').value = vote ? (vote.motion || 'Motion') : 'Motion';
    $('vote-outcome').value = vote?.outcome || 'auto';
    $('vote-delete').hidden = !vote;
    $('vote-dialog-status').textContent = '';
    renderVoteMembers();
    fillMotionPeople(vote);
    // Not modal: the video can be played and scrubbed through the roll call while this is open.
    if ($('vote-dialog').open) $('vote-dialog').close();
    $('vote-dialog').show();
    voteOverlayKey = null;
    updateVoteOverlay();
  }
  $('vote-add').addEventListener('click', () => openVoteEditor(null));
  $('vote-now').addEventListener('click', () => { $('vote-time').value = fmtPrecise(position); renderVoteMembers(); });
  $('vote-time').addEventListener('change', renderVoteMembers);
  $('vote-outcome').addEventListener('change', updateVoteTally);
  $('vote-all-for').addEventListener('click', () => {
    const at = Number(position.toFixed(2));
    voterIds(editVote, editChanges).forEach((id) => {
      const member = voteData.members.find((item) => item.id === id);
      if (member && !memberPresent(member, at)) return;
      if (statusAt(editVote, id, at, editChanges) !== 'for') editChanges.push({ id, choice: 'for', at });
    });
    editChanges.sort((a, b) => a.at - b.at);
    renderVoteMembers();
  });
  $('vote-cancel').addEventListener('click', () => $('vote-dialog').close());
  $('vote-dialog').addEventListener('close', () => { voteClickMode = 'vote'; voteOverlayKey = null; updateVoteOverlay(); });
  ['vote-motion', 'vote-time', 'vote-moved-by', 'vote-moved-at', 'vote-seconded-by', 'vote-seconded-at', 'vote-outcome'].forEach((id) => {
    $(id).addEventListener('input', () => { voteOverlayKey = null; updateVoteOverlay(); });
    $(id).addEventListener('change', () => { voteOverlayKey = null; updateVoteOverlay(); });
  });
  $('vote-delete').addEventListener('click', async () => {
    if (!voteEditing || !confirm('Remove this vote?')) return;
    const before = voteData.votes;
    voteData.votes = voteData.votes.filter((item) => item.id !== voteEditing.id);
    if (await saveVotes('Removed the vote')) $('vote-dialog').close(); else voteData.votes = before;
  });
  $('vote-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const at = parse($('vote-time').value);
    if (at === null || at < 0 || at > endSeconds) { $('vote-dialog-status').textContent = 'Enter a time between 00:00:00 and ' + fmt(endSeconds); return; }
    if (!$('vote-motion').value.trim()) { $('vote-dialog-status').textContent = 'Say what the motion is'; return; }
    const vote = {
      id: voteEditing ? voteEditing.id : Date.now().toString(36),
      at: Number(at.toFixed(3)),
      motion: $('vote-motion').value.trim(),
      changes: [...editChanges].sort((a, b) => a.at - b.at),
      outcome: $('vote-outcome').value,
      showSeconds: Math.max(3, Math.min(600, Number($('vote-show').value) || 20)),
      movedBy: readMotionPerson('moved'),
      secondedBy: readMotionPerson('seconded')
    };
    // Final statuses, for anything that only needs the result.
    vote.results = {};
    Object.entries(voteState(vote, Infinity).statuses).forEach(([id, status]) => { if (status !== 'pending') vote.results[id] = status; });
    for (const [role, label] of [['movedBy', 'motion'], ['secondedBy', 'second']]) {
      if (vote[role] && vote[role].at === null) { $('vote-dialog-status').textContent = 'Enter when the ' + label + ' was made (or press ⏱ Now)'; return; }
    }
    const before = voteData.votes;
    voteData.votes = voteEditing ? voteData.votes.map((item) => (item.id === vote.id ? vote : item)) : [...voteData.votes, vote];
    if (await saveVotes((voteEditing ? 'Saved the vote at ' : 'Recorded the vote at ') + fmt(vote.at))) $('vote-dialog').close();
    else { voteData.votes = before; $('vote-dialog-status').textContent = $('votes-status').textContent; }
  });

  // Who moved and seconded, and when. People to pick from: the voting members first, then everyone else.
  function fillMotionPeople(vote) {
    for (const role of ['moved', 'seconded']) {
      const select = $('vote-' + role + '-by');
      select.textContent = '';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '—';
      select.appendChild(none);
      const memberIds = voteData.members.map((item) => item.id);
      const groups = [['Voting members', people.filter((person) => memberIds.includes(person.id))], ['Others', people.filter((person) => !memberIds.includes(person.id))]];
      groups.forEach(([label, list]) => {
        if (!list.length) return;
        const group = document.createElement('optgroup');
        group.label = label;
        [...list].sort((a, b) => a.name.localeCompare(b.name)).forEach((person) => {
          const option = document.createElement('option');
          option.value = person.id;
          option.textContent = shownName(person);
          group.appendChild(option);
        });
        select.appendChild(group);
      });
      const entry = vote ? vote[role + 'By'] : null;
      select.value = entry?.id || '';
      $('vote-' + role + '-at').value = entry?.at === null || entry?.at === undefined ? '' : fmtPrecise(entry.at);
    }
  }
  function readMotionPerson(role) {
    const id = $('vote-' + role + '-by').value;
    if (!id) return null;
    const text = $('vote-' + role + '-at').value.trim();
    const at = text ? parse(text) : null;
    return { id, at: at === null ? null : Number(at.toFixed(3)) };
  }
  // When someone is picked, start from when they last began speaking before the vote (from the speaker marks).
  function lastSpokeBefore(id, seconds) {
    let found = null;
    turns.forEach((turn, index) => {
      if (turn.at > seconds + 0.05 || !turn.speakers.includes(id)) return;
      if (index > 0 && turns[index - 1].speakers.includes(id)) return;
      found = turn.at;
    });
    return found;
  }
  for (const role of ['moved', 'seconded']) {
    $('vote-' + role + '-by').addEventListener('change', () => {
      const id = $('vote-' + role + '-by').value;
      if (!id || $('vote-' + role + '-at').value.trim()) return;
      const voteAt = parse($('vote-time').value) ?? position;
      const spoke = lastSpokeBefore(id, voteAt);
      if (spoke !== null) $('vote-' + role + '-at').value = fmtPrecise(spoke);
    });
    $('vote-' + role + '-now').addEventListener('click', () => { $('vote-' + role + '-at').value = fmtPrecise(position); });
  }
  // On the video: each member's photo with their vote, and the outcome, for a while after each vote.
  let voteOverlayKey = null;
  // Shown from when the vote opens until 5 seconds after it passes or fails, then fades out over a second. A vote
  // that's never decided stays up a while after its last recorded change.
  const voteHoldSeconds = 5;
  const voteFadeSeconds = 1;
  function voteEnd(vote) {
    const decided = decidedAt(vote);
    if (decided !== null) return decided + voteHoldSeconds + voteFadeSeconds;
    const last = Math.max(vote.at, ...voteChanges(vote).map((change) => change.at));
    return last + (vote.showSeconds || 20);
  }
  function activeVote(seconds) {
    return [...voteData.votes].filter((vote) => vote.at <= seconds + 0.05 && seconds < voteEnd(vote)).sort((a, b) => b.at - a.at)[0] || null;
  }
  // The vote on the video: the one being edited while the vote panel is open (shown the whole time, so the motion
  // and second can be found before the vote opens), otherwise the active one when "Show votes" is checked.
  let voteClickMode = 'vote';
  function overlayVote() {
    if ($('vote-dialog').open) {
      return {
        id: voteEditing?.id || 'draft',
        at: parse($('vote-time').value) ?? editVote.at,
        motion: $('vote-motion').value.trim(),
        changes: editChanges,
        movedBy: readMotionPerson('moved'),
        secondedBy: readMotionPerson('seconded'),
        outcome: $('vote-outcome').value,
        editing: true
      };
    }
    return $('show-votes').checked ? activeVote(position) : null;
  }
  // Clicking a member's photo on the video: records their vote now (or, in Moved / Seconded mode, that they made
  // or seconded the motion now). In the vote panel this changes the draft; otherwise it saves right away.
  async function overlayClick(id) {
    const vote = overlayVote();
    if (!vote) return;
    if (voteClickMode === 'vote') {
      if (vote.editing) { toggleVote(id); return; }
      const saved = voteData.votes.find((item) => item.id === vote.id);
      const before = saved.changes;
      saved.changes = toggledChanges(saved, voteChanges(saved), id, position);
      saved.results = {};
      Object.entries(voteState(saved, Infinity).statuses).forEach(([member, status]) => { if (status !== 'pending') saved.results[member] = status; });
      const person = peopleMap.get(id) || { id, name: id };
      if (!(await saveVotes(lastName(person) + ': ' + choiceNames[statusAt(saved, id, position)] + ' at ' + fmt(position)))) saved.changes = before;
      return;
    }
    const role = voteClickMode;
    voteClickMode = 'vote';
    const current = vote[role + 'By'];
    // Clicking the same person again at the same moment clears it.
    const entry = current?.id === id && current.at !== null && Math.abs(current.at - position) <= 2 ? null : { id, at: Number(position.toFixed(2)) };
    if (vote.editing) {
      $('vote-' + role + '-by').value = entry ? entry.id : '';
      $('vote-' + role + '-at').value = entry ? fmtPrecise(entry.at) : '';
      voteOverlayKey = null;
      updateVoteOverlay();
      return;
    }
    const saved = voteData.votes.find((item) => item.id === vote.id);
    const before = saved[role + 'By'];
    saved[role + 'By'] = entry;
    const person = peopleMap.get(id) || { id, name: id };
    if (!(await saveVotes(entry ? (role === 'moved' ? 'Moved by ' : 'Seconded by ') + lastName(person) + ' at ' + fmt(position) : 'Cleared'))) saved[role + 'By'] = before;
  }
  // Starts a new vote here and shows it, ready for members to be clicked as they vote.
  async function startVoteNow() {
    const vote = { id: Date.now().toString(36), at: Number(position.toFixed(2)), motion: 'Motion',
      changes: [], results: {}, outcome: 'auto', showSeconds: 20 };
    voteData.votes = [...voteData.votes, vote];
    if (await saveVotes('Vote started at ' + fmt(vote.at) + ': click members on the video as they vote')) {
      if (!$('show-votes').checked) setShowVotes(true);
    } else {
      voteData.votes = voteData.votes.filter((item) => item !== vote);
    }
  }
  $('vote-start').addEventListener('click', startVoteNow);
  // Toolbar: show or hide the votes, and jump between them.
  function setVotesShown(shown) {
    $('votes-panel').hidden = !shown;
    $('votes-toggle').setAttribute('aria-pressed', shown ? 'true' : 'false');
    try { localStorage.setItem('thumbnails.votesShown', shown ? '1' : '0'); } catch {}
  }
  $('votes-toggle').addEventListener('click', () => setVotesShown($('votes-panel').hidden));
  try { setVotesShown(localStorage.getItem('thumbnails.votesShown') !== '0'); } catch { setVotesShown(true); }
  $('vote-prev').addEventListener('click', () => {
    const previous = [...voteData.votes].sort((a, b) => b.at - a.at).find((vote) => vote.at < position - 1.5);
    if (previous) showPosition(previous.at);
  });
  $('vote-next').addEventListener('click', () => {
    const next = [...voteData.votes].sort((a, b) => a.at - b.at).find((vote) => vote.at > position + 0.5);
    if (next) showPosition(next.at);
  });
  async function moveVoteStart(vote) {
    const at = Number(position.toFixed(2));
    if (vote.editing) { $('vote-time').value = fmtPrecise(at); renderVoteMembers(); voteOverlayKey = null; updateVoteOverlay(); return; }
    const saved = voteData.votes.find((item) => item.id === vote.id);
    const before = saved.at;
    saved.at = at;
    if (!(await saveVotes('The vote now starts at ' + fmt(at)))) saved.at = before;
  }
  function updateVoteOverlay() {
    const vote = overlayVote();
    const state = vote ? voteState(vote, position) : null;
    const decided = vote ? decidedAt(vote) : null;
    const fading = Boolean(vote && !vote.editing && decided !== null && position >= decided + voteHoldSeconds);
    $('vote-overlay').classList.toggle('fading', fading);
    if (inlineEditing && !$('vote-overlay').hidden) return;
    const key = vote ? JSON.stringify(vote) + JSON.stringify(state.statuses) + state.outcome + voteClickMode : '';
    if (key === voteOverlayKey) return;
    voteOverlayKey = key;
    const overlay = $('vote-overlay');
    overlay.hidden = !vote;
    overlay.textContent = '';
    if (!vote) return;
    overlay.classList.toggle('editing', Boolean(vote.editing));
    // What a click on a photo records (shown on hover, and always while editing).
    const modes = document.createElement('div');
    modes.className = 'vote-modes';
    const startButton = document.createElement('button');
    startButton.type = 'button';
    startButton.textContent = '⏱ Starts now';
    startButton.title = 'Move the start of this vote to ' + fmt(position);
    startButton.addEventListener('click', (event) => { event.stopPropagation(); moveVoteStart(vote); });
    modes.appendChild(startButton);
    [['vote', '🗳 Vote'], ['moved', '✋ Moved'], ['seconded', '✋ Seconded']].forEach(([mode, label]) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = mode === 'vote' ? "Click a photo to record that member's vote now" : 'Then click the member who ' + mode + ' the motion, at the moment they did';
      if (mode === voteClickMode) button.classList.add('on');
      button.addEventListener('click', (event) => { event.stopPropagation(); voteClickMode = mode; voteOverlayKey = null; updateVoteOverlay(); });
      modes.appendChild(button);
    });
    overlay.appendChild(modes);
    // The motion: click to edit it in place.
    const motion = document.createElement('div');
    motion.className = 'motion editable-text';
    motion.textContent = vote.motion || 'Motion';
    motion.title = (vote.motion ? vote.motion + ' — ' : '') + 'Click to edit the motion';
    motion.addEventListener('click', (event) => {
      event.stopPropagation();
      motion.classList.add('editing-inline');
      inlineEdit(motion, vote.motion || '', async (text) => {
        if (vote.editing) {
          $('vote-motion').value = text;
        } else {
          const saved = voteData.votes.find((item) => item.id === vote.id);
          const before = saved.motion;
          saved.motion = text;
          if (!(await saveVotes('Saved the motion'))) saved.motion = before;
        }
        voteOverlayKey = null;
        updateVoteOverlay();
      });
    });
    overlay.appendChild(motion);
    if (vote.movedBy?.id || vote.secondedBy?.id) {
      const credits = document.createElement('div');
      credits.className = 'credits';
      [[vote.movedBy, 'Moved', 'moved'], [vote.secondedBy, 'Seconded', 'seconded']].forEach(([entry, verb, mode]) => {
        if (!entry?.id) return;
        const person = peopleMap.get(entry.id) || { id: entry.id, name: entry.id };
        const item = document.createElement('span');
        item.title = verb + ' by ' + shownName(person) + (entry.at === null || entry.at === undefined ? '' : ' at ' + fmt(entry.at)) + ' — click to change';
        const text = document.createElement('span');
        text.textContent = verb + ': ' + lastName(person);
        item.append(avatar(person), text);
        item.addEventListener('click', (event) => { event.stopPropagation(); voteClickMode = mode; voteOverlayKey = null; updateVoteOverlay(); });
        credits.appendChild(item);
      });
      overlay.appendChild(credits);
    }
    const members = document.createElement('div');
    members.className = 'members';
    Object.entries(state.statuses).forEach(([id, choice]) => {
      const person = peopleMap.get(id) || { id, name: id };
      const item = document.createElement('div');
      item.className = 'vote-member' + (choice === 'absent' ? ' absent' : '') + (choice === 'pending' ? ' pending' : '');
      item.title = voteClickMode === 'vote' ? 'Click to record ' + shownName(person) + "'s vote at " + fmt(position) : shownName(person) + ' ' + voteClickMode + ' the motion at ' + fmt(position);
      const face = document.createElement('span');
      face.className = 'face';
      face.appendChild(avatar(person));
      if (choice !== 'absent' && choice !== 'pending') {
        const badge = document.createElement('span');
        badge.className = 'vote-badge choice-' + choice;
        badge.textContent = choiceMarks[choice];
        face.appendChild(badge);
      }
      const name = document.createElement('small');
      name.textContent = lastName(person);
      const district = document.createElement('small');
      district.className = 'district';
      district.textContent = choice === 'absent' ? 'absent' : districtOf(person);
      item.append(face, name, district);
      item.addEventListener('click', (event) => { event.stopPropagation(); overlayClick(id); });
      members.appendChild(item);
    });
    overlay.appendChild(members);
    const outcome = document.createElement('div');
    outcome.className = 'outcome ' + state.outcome;
    outcome.textContent = describeTally(vote, position);
    overlay.appendChild(outcome);
  }
  function setShowVotes(visible) {
    $('show-votes').checked = visible;
    try { localStorage.setItem('thumbnails.showVotes', visible ? '1' : '0'); } catch {}
    voteOverlayKey = null;
    updateVoteOverlay();
  }
  $('show-votes').addEventListener('change', () => setShowVotes($('show-votes').checked));
  try { if (localStorage.getItem('thumbnails.showVotes') === '1') $('show-votes').checked = true; } catch {}

  renderVotes();
  // Waveform of a range (with a few seconds either side), measured by the local server from the original audio, with
  // draggable start (green) and end (red) edges. Heights are on a loudness scale (dB), so quiet speech still shows.
  // Used by the Boost and Download clip dialogs; each gives its elements and how to read and set its range.
  function makeWaveform({ canvas, strip, zoomIn, zoomOut, startLabel, endLabel, status, reload, dialog, getRange, setRange, onDrag }) {
    const wave = { from: 0, to: 0, peaks: [], dragging: null };
    const x = (seconds, width) => ((seconds - wave.from) / Math.max(0.001, wave.to - wave.from)) * width;
    const time = (offset, width) => wave.from + (offset / width) * (wave.to - wave.from);
    const hint = 'Drag the green (start) and red (end) edges to refine it; click elsewhere to move the playhead (it stays within them).';
    // Loads the waveform for a stretch (by default, the range with a margin either side).
    async function load(view) {
      const range = getRange();
      if (!range) return;
      const margin = Math.max(3, (range.to - range.from) * 0.25);
      const from = view ? view.from : Math.max(0, range.from - margin);
      const to = view ? view.to : Math.min(endSeconds, range.to + margin);
      status.textContent = 'Loading the waveform...';
      try {
        const job = await startBoostJob({ action: 'peaks', from, to });
        const data = await fetch('../retranscribe/' + job.peaks, { cache: 'no-store' }).then((reply) => reply.json());
        Object.assign(wave, { from: data.from, to: data.to, peaks: data.peaks });
        status.textContent = hint;
      } catch (error) {
        wave.peaks = [];
        status.textContent = 'No waveform: ' + error.message;
      }
      draw();
    }
    function draw() {
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round((canvas.clientWidth || 600) * ratio));
      const height = Math.max(1, Math.round((canvas.clientHeight || 110) * ratio));
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      startLabel.textContent = wave.peaks.length ? fmtPrecise(wave.from) : '';
      endLabel.textContent = wave.peaks.length ? fmtPrecise(wave.to) : '';
      const context = canvas.getContext('2d');
      if (!context || !context.fillRect) return;
      context.clearRect(0, 0, width, height);
      const range = getRange();
      if (!wave.peaks.length || !range) return;
      const middle = height / 2;
      const left = x(range.from, width);
      const right = x(range.to, width);
      context.fillStyle = 'rgba(255, 224, 138, 0.16)';
      context.fillRect(left, 0, right - left, height);
      const barWidth = width / wave.peaks.length;
      wave.peaks.forEach((peak, index) => {
        const level = peak > 0 ? Math.max(0, (20 * Math.log10(peak) + 60) / 60) : 0;
        const bar = Math.max(1, level * (height * 0.46));
        const at = index * barWidth;
        context.fillStyle = at >= left && at <= right ? '#ffd166' : '#5c7c8a';
        context.fillRect(at, middle - bar, Math.max(1, barWidth - 0.5), bar * 2);
      });
      [[left, '#2e9d5b'], [right, '#d33b2f']].forEach(([edge, color]) => {
        context.fillStyle = color;
        context.fillRect(edge - 1.5 * ratio, 0, 3 * ratio, height);
        context.fillRect(edge - 6 * ratio, 0, 12 * ratio, 10 * ratio);
        context.fillRect(edge - 6 * ratio, height - 10 * ratio, 12 * ratio, 10 * ratio);
      });
      if (position >= wave.from && position <= wave.to) {
        context.fillStyle = '#ffffff';
        context.fillRect(x(position, width) - ratio / 2, 0, ratio, height);
      }
      drawStrip();
    }
    // Frames across the same window: one thumbnail after another (the nearest one saved for each spot).
    const frameImages = new Map();
    let stripRedraw = 0;
    function frameImage(file) {
      if (!frameImages.has(file)) {
        const image = new Image();
        image.onload = () => { if (!stripRedraw) stripRedraw = setTimeout(() => { stripRedraw = 0; drawStrip(); }, 50); };
        image.src = file;
        frameImages.set(file, image);
      }
      return frameImages.get(file);
    }
    function drawStrip() {
      if (!strip) return;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round((strip.clientWidth || 600) * ratio));
      const height = Math.max(1, Math.round((strip.clientHeight || 54) * ratio));
      if (strip.width !== width) strip.width = width;
      if (strip.height !== height) strip.height = height;
      const context = strip.getContext('2d');
      if (!context || !context.fillRect) return;
      context.clearRect(0, 0, width, height);
      const range = getRange();
      if (!thumbs.length || wave.to <= wave.from || !range) return;
      const tileWidth = height * 16 / 9;
      for (let left = 0; left < width; left += tileWidth) {
        const seconds = wave.from + ((left + tileWidth / 2) / width) * (wave.to - wave.from);
        const image = frameImage(thumbs[nearestThumb(seconds)].f);
        if (image.complete && image.naturalWidth) context.drawImage(image, left, 0, tileWidth, height);
      }
      // Outside the clip is shaded; its edges match the waveform's.
      const left = x(range.from, width);
      const right = x(range.to, width);
      context.fillStyle = 'rgba(0, 0, 0, 0.55)';
      context.fillRect(0, 0, Math.max(0, left), height);
      context.fillRect(right, 0, Math.max(0, width - right), height);
      [[left, '#2e9d5b'], [right, '#d33b2f']].forEach(([edge, color]) => {
        context.fillStyle = color;
        context.fillRect(edge - 1.5 * ratio, 0, 3 * ratio, height);
      });
    }
    // Zooming around the clip (or the current window's middle): a new window, loaded fresh for detail.
    let zoomTimer = 0;
    function zoom(factor) {
      const range = getRange();
      const current = Math.max(1, wave.to - wave.from || (range ? (range.to - range.from) * 1.5 : 30));
      const span = Math.max(2, Math.min(endSeconds, current * factor));
      const center = range ? (range.from + range.to) / 2 : (wave.from + wave.to) / 2;
      const from = Math.max(0, Math.min(endSeconds - span, center - span / 2));
      Object.assign(wave, { from, to: from + span });
      draw();
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(() => load({ from, to: from + span }), 250);
    }
    if (zoomIn) zoomIn.addEventListener('click', () => zoom(0.5));
    if (zoomOut) zoomOut.addEventListener('click', () => zoom(2));
    canvas.addEventListener('wheel', (event) => { if (!wave.peaks.length) return; event.preventDefault(); zoom(event.deltaY < 0 ? 0.8 : 1.25); }, { passive: false });
    const pointTime = (event, surface = canvas) => {
      const rect = surface.getBoundingClientRect();
      return Math.max(wave.from, Math.min(wave.to, time(event.clientX - rect.left, rect.width)));
    };
    const setEdge = (edge, seconds) => {
      const range = getRange();
      const minimum = 0.2;
      if (edge === 'from') setRange(Math.min(seconds, range.to - minimum), range.to); else setRange(range.from, Math.max(seconds, range.from + minimum));
      draw();
    };
    // Moves the playhead (and the video, if loaded) to a moment within the range: a click outside it, or scrubbing past
    // an edge, stops at that edge. Playing carries on from there.
    const seekHere = (wanted) => {
      const range = getRange();
      const seconds = range ? Math.max(range.from, Math.min(range.to, wanted)) : wanted;
      if (playerReady) video.currentTime = toPlayerTime(seconds);
      showPosition(seconds, { seek: false });
      draw();
    };
    // Which edge (if any) is within reach of the pointer.
    const edgeAt = (offset, width) => {
      const range = getRange();
      if (!range) return null;
      const fromDistance = Math.abs(offset - x(range.from, width));
      const toDistance = Math.abs(offset - x(range.to, width));
      if (Math.min(fromDistance, toDistance) > 10) return null;
      return fromDistance <= toDistance ? 'from' : 'to';
    };
    // The waveform and the frame strip: drag an edge to refine the range; press anywhere else to move the playhead
    // (holding and dragging scrubs).
    [canvas, strip].filter(Boolean).forEach((surface) => {
      surface.addEventListener('pointerdown', (event) => {
        if (!wave.peaks.length) return;
        const rect = surface.getBoundingClientRect();
        const edge = edgeAt(event.clientX - rect.left, rect.width);
        if (edge) {
          if (onDrag) onDrag();
          wave.dragging = edge;
          setEdge(edge, pointTime(event, surface));
        } else {
          wave.dragging = 'seek';
          seekHere(pointTime(event, surface));
        }
        surface.setPointerCapture(event.pointerId);
      });
      surface.addEventListener('pointermove', (event) => {
        const rect = surface.getBoundingClientRect();
        if (!wave.dragging) { surface.style.cursor = edgeAt(event.clientX - rect.left, rect.width) ? 'ew-resize' : 'pointer'; return; }
        if (wave.dragging === 'seek') seekHere(pointTime(event, surface)); else setEdge(wave.dragging, pointTime(event, surface));
      });
      surface.addEventListener('pointerup', () => { wave.dragging = null; });
    });
    reload.addEventListener('click', load);
    video.addEventListener('timeupdate', () => { if (dialog.open && wave.peaks.length) draw(); });
    // A typed range outside the waveform loads a new one around it.
    const typed = () => { const range = getRange(); if (range && (range.from < wave.from || range.to > wave.to)) load(); else draw(); };
    return { load, draw, typed, zoom };
  }
  const boostWave = makeWaveform({
    canvas: $('boost-wave'), startLabel: $('wave-start'), endLabel: $('wave-end'), status: $('wave-status'), reload: $('wave-reload'), dialog: $('boost-dialog'),
    getRange: () => (readBoostRange() ? { from: boost.from, to: boost.to } : null),
    setRange: (from, to) => { $('boost-from').value = fmtPrecise(from); $('boost-to').value = fmtPrecise(to); readBoostRange(); },
    onDrag: () => stopBoostPreview()
  });
  function loadWaveform() { boostWave.load(); }
  ['boost-from', 'boost-to'].forEach((id) => $(id).addEventListener('change', () => boostWave.typed()));

  // Download clip: refine the range on a waveform, preview it, and have the local server cut it (extract-clip,
  // saved in the session's clips folder) for the browser to download.
  const clipDialogRange = { from: null, to: null, previewing: false };
  function readClipRange() {
    clipDialogRange.from = parse($('clip-from').value);
    clipDialogRange.to = parse($('clip-to').value);
    const valid = clipDialogRange.from !== null && clipDialogRange.to !== null && clipDialogRange.to > clipDialogRange.from;
    $('clip-length').textContent = valid ? fmt(clipDialogRange.to - clipDialogRange.from) + ' long' : 'enter a start before the end';
    ['clip-download', 'clip-preview'].forEach((id) => { $(id).disabled = !valid && !clipRecording; });
    return valid;
  }
  const clipWave = makeWaveform({
    canvas: $('clip-wave'), strip: $('clip-strip'), zoomIn: $('clip-zoom-in'), zoomOut: $('clip-zoom-out'), startLabel: $('clip-wave-start'), endLabel: $('clip-wave-end'), status: $('clip-wave-status'), reload: $('clip-wave-reload'), dialog: $('clip-dialog'),
    getRange: () => (readClipRange() ? { from: clipDialogRange.from, to: clipDialogRange.to } : null),
    setRange: (from, to) => {
      $('clip-from').value = fmtPrecise(from);
      $('clip-to').value = fmtPrecise(to);
      readClipRange();
      // Keep the page's clip range in step.
      start = from;
      end = to;
      update();
    },
    onDrag: () => stopClipPreview()
  });
  $('clip-open').addEventListener('click', () => {
    let from = start, to = end;
    if (from !== null && to !== null && to < from) [from, to] = [to, from];
    if (from === null || to === null || to <= from) { from = position; to = Math.min(endSeconds, position + 30); }
    $('clip-from').value = fmtPrecise(from);
    $('clip-to').value = fmtPrecise(to);
    $('clip-status').textContent = location.protocol === 'file:' ? 'Downloading needs the local server (npm run serve).' : '';
    readClipRange();
    if (!$('clip-dialog').open) {
      $('clip-dialog').show();
      // Anchor it by its left and top so dragging the corner widens it to the right.
      const rect = $('clip-dialog').getBoundingClientRect();
      if (rect.width) Object.assign($('clip-dialog').style, { inset: 'auto', left: rect.left + 'px', top: rect.top + 'px' });
    }
    clipWave.load();
  });
  if (window.ResizeObserver) new ResizeObserver(() => { if ($('clip-dialog').open) clipWave.draw(); }).observe($('clip-dialog'));
  ['clip-from', 'clip-to'].forEach((id) => {
    $(id).addEventListener('input', () => { stopClipPreview(); readClipRange(); });
    $(id).addEventListener('change', () => clipWave.typed());
  });
  function stopClipPreview() {
    if (clipDialogRange.previewing) video.pause();
    clipDialogRange.previewing = false;
    $('clip-preview').textContent = '▶ Play clip';
  }
  $('clip-preview').addEventListener('click', async () => {
    if (clipDialogRange.previewing) { stopClipPreview(); return; }
    if (!readClipRange()) return;
    try {
      if (!playerReady) {
        $('clip-status').textContent = 'Loading video...';
        await initPlayer();
        setStatus('Play');
        $('play').disabled = false;
      }
      // Pick up from the playhead when it's inside the clip (after clicking the waveform), else from the start.
      const startAt = position >= clipDialogRange.from && position < clipDialogRange.to - 0.2 ? position : clipDialogRange.from;
      showPosition(startAt);
      await seekTo(toPlayerTime(startAt));
      clipDialogRange.previewing = true;
      $('clip-preview').textContent = '⏹ Stop';
      $('clip-status').textContent = '';
      await video.play();
    } catch (error) {
      stopClipPreview();
      $('clip-status').textContent = 'Could not play: ' + error.message;
    }
  });
  // At the end of the clip: start over when looping, otherwise stop.
  video.addEventListener('timeupdate', () => {
    if (!clipDialogRange.previewing || toPosition(video.currentTime) < clipDialogRange.to) return;
    if ($('clip-loop').checked) { video.currentTime = toPlayerTime(clipDialogRange.from); showPosition(clipDialogRange.from, { seek: false }); }
    else stopClipPreview();
  });
  try { $('clip-loop').checked = localStorage.getItem('thumbnails.clipLoop') === '1'; } catch {}
  $('clip-loop').addEventListener('change', () => { try { localStorage.setItem('thumbnails.clipLoop', $('clip-loop').checked ? '1' : '0'); } catch {} });
  $('clip-download').addEventListener('click', async () => {
    if (clipRecording) { clipRecording.stop(); return; }
    if (!readClipRange()) return;
    stopClipPreview();
    if ($('clip-overlays').checked) { recordClipWithOverlays(); return; }
    $('clip-download').disabled = true;
    $('clip-status').textContent = 'Cutting the clip...';
    try {
      const job = await startBoostJob({ action: 'clip', from: clipDialogRange.from, to: clipDialogRange.to, accurate: $('clip-accurate').checked });
      const link = document.createElement('a');
      link.href = '../' + job.clip;
      link.download = job.clip.split('/').pop();
      document.body.appendChild(link);
      link.click();
      link.remove();
      $('clip-status').textContent = job.message;
    } catch (error) {
      $('clip-status').textContent = 'No clip: ' + error.message;
    } finally {
      readClipRange();
    }
  });
  // With the overlays: plays the clip and records a canvas showing the video with everything drawn on it (as on the
  // page, magnified speakers included), plus the sound (with any playback boost), then downloads the recording.
  let clipRecording = null;
  async function recordClipWithOverlays() {
    const status = $('clip-status');
    let destination = null;
    try {
      if (!window.MediaRecorder) throw new Error('this browser cannot record video');
      if (!playerReady) {
        status.textContent = 'Loading video...';
        await initPlayer();
        setStatus('Play');
        $('play').disabled = false;
      }
      video.pause();
      const from = clipDialogRange.from;
      const to = clipDialogRange.to;
      showPosition(from);
      await seekTo(toPlayerTime(from));
      await waitForFrame(15000);
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const context = canvas.getContext('2d');
      // Sound: through the boost graph when it's in use (so boosts are kept), else straight from the video.
      let audioTracks = [];
      if (boost.graph) {
        destination = boost.graph.context.createMediaStreamDestination();
        boost.graph.compressor.connect(destination);
        audioTracks = destination.stream.getAudioTracks();
      } else {
        const capture = video.captureStream ? video.captureStream() : (video.mozCaptureStream ? video.mozCaptureStream() : null);
        audioTracks = capture ? capture.getAudioTracks() : [];
      }
      const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audioTracks]);
      const type = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
      const recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6000000 } : undefined);
      const chunks = [];
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      let frame = 0;
      const draw = () => {
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        paintMagnified(context, video, canvas.width, canvas.height, magnifiedAt(currentSeconds()));
        paintOverlays(context, canvas.width);
        const now = toPosition(video.currentTime);
        status.textContent = 'Recording with the overlays: ' + fmt(Math.max(0, now - from)) + ' of ' + fmt(to - from) + ' (⏹ to stop early)';
        if (now >= to || video.ended) { recorder.stop(); return; }
        frame = requestAnimationFrame(draw);
      };
      const finished = new Promise((resolve) => { recorder.onstop = resolve; });
      clipRecording = { stop: () => { if (recorder.state !== 'inactive') recorder.stop(); } };
      $('clip-download').textContent = '⏹ Stop';
      recorder.start(1000);
      await video.play();
      draw();
      await finished;
      cancelAnimationFrame(frame);
      video.pause();
      const blob = new Blob(chunks, { type: recorder.mimeType || type || 'video/webm' });
      const extension = (recorder.mimeType || type).includes('mp4') ? 'mp4' : 'webm';
      const name = 'clip-' + fmt(from).replace(/:/g, '-') + '-to-' + fmt(to).replace(/:/g, '-') + '-overlays.' + extension;
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 30000);
      status.textContent = 'Saved ' + name + ' (' + (blob.size / 1e6).toFixed(1) + ' MB)';
    } catch (error) {
      status.textContent = 'Not recorded: ' + error.message;
    } finally {
      if (destination) { try { boost.graph.compressor.disconnect(destination); } catch {} }
      clipRecording = null;
      $('clip-download').textContent = '⬇ Download';
      readClipRange();
    }
  }
  $('clip-close').addEventListener('click', () => $('clip-dialog').close());
  $('clip-dialog').addEventListener('close', stopClipPreview);
  // Dialogs move by dragging their heading (kept on screen).
  function makeDialogDraggable(dialog) {
    const handle = dialog.querySelector('h2');
    if (!handle) return;
    handle.classList.add('drag-handle');
    handle.title = 'Drag to move';
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const rect = dialog.getBoundingClientRect();
      const offsetX = event.clientX - rect.left;
      const offsetY = event.clientY - rect.top;
      const move = (moveEvent) => {
        const left = Math.max(0, Math.min(window.innerWidth - rect.width, moveEvent.clientX - offsetX));
        const top = Math.max(0, Math.min(window.innerHeight - 40, moveEvent.clientY - offsetY));
        Object.assign(dialog.style, { position: 'fixed', margin: '0', inset: 'auto', left: left + 'px', top: top + 'px' });
      };
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }
  ['display-dialog', 'vote-dialog', 'boost-dialog', 'person-dialog', 'spoke-dialog', 'zoom-dialog', 'clip-dialog'].forEach((id) => makeDialogDraggable($(id)));
  // Overlay layout: each overlay's text size (from 🎛) and position (dragged on the video), remembered in this browser.
  // Positions are fractions of the video's width and height, so they hold at any size.
  const overlayElements = { title: 'title-overlay', chapter: 'agenda-overlay', clock: 'overlay', speakers: 'speaker-cards', votes: 'vote-overlay' };
  // var, not let: the name and chapter overlays are set up earlier in the page and ask for the chapter's placement
  // before this runs (it stays undefined until here).
  var overlayLayout = {};
  try { overlayLayout = JSON.parse(localStorage.getItem('thumbnails.overlayLayout') || '{}') || {}; } catch {}
  function saveOverlayLayout() {
    try { localStorage.setItem('thumbnails.overlayLayout', JSON.stringify(overlayLayout)); } catch {}
  }
  function applyOverlayLayout() {
    Object.entries(overlayElements).forEach(([type, id]) => {
      const element = $(id);
      const layout = overlayLayout[type] || {};
      element.style.setProperty('--s', String(layout.size || 1));
      if (Number.isFinite(layout.x) && Number.isFinite(layout.y)) {
        element.style.left = (layout.x * 100) + '%';
        element.style.top = (layout.y * 100) + '%';
        element.style.right = 'auto';
        element.style.bottom = 'auto';
      } else {
        ['left', 'top', 'right', 'bottom'].forEach((side) => { element.style[side] = ''; });
      }
    });
    stackChapter();
    document.querySelectorAll('[data-size]').forEach((slider) => {
      const size = Math.round((overlayLayout[slider.dataset.size]?.size || 1) * 100);
      slider.value = size;
      if (slider.nextElementSibling) slider.nextElementSibling.textContent = size + '%';
    });
  }
  // Unless it has been moved, the chapter sits just under the meeting name (or in its place when the name is hidden).
  function stackChapter() {
    const chapter = $('agenda-overlay');
    if (!overlayLayout || Number.isFinite(overlayLayout.chapter?.x)) return;
    const title = $('title-overlay');
    const stage = $('stage');
    if (title.hidden || !stage.clientHeight) { chapter.style.top = ''; chapter.style.left = title.hidden ? '' : title.style.left; return; }
    chapter.style.left = title.style.left || '';
    chapter.style.top = ((title.offsetTop + title.offsetHeight + 4) / stage.clientHeight * 100) + '%';
  }
  document.querySelectorAll('[data-size]').forEach((slider) => {
    slider.addEventListener('input', () => {
      const type = slider.dataset.size;
      overlayLayout[type] = { ...(overlayLayout[type] || {}), size: Number(slider.value) / 100 };
      saveOverlayLayout();
      applyOverlayLayout();
    });
  });
  $('layout-reset').addEventListener('click', () => { overlayLayout = {}; saveOverlayLayout(); applyOverlayLayout(); });
  window.addEventListener('resize', stackChapter);
  // Dragging: a press that moves more than a few pixels moves the overlay (and the click that follows is ignored, so it
  // doesn't also edit, record a vote, or play); a press that doesn't move is an ordinary click.
  function makeMovable(type) {
    const element = $(overlayElements[type]);
    element.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('input, button, select')) return;
      const stage = $('stage');
      const start = { x: event.clientX, y: event.clientY, left: element.offsetLeft, top: element.offsetTop };
      let dragging = false;
      const move = (moveEvent) => {
        const dx = moveEvent.clientX - start.x;
        const dy = moveEvent.clientY - start.y;
        if (!dragging && Math.hypot(dx, dy) < 5) return;
        dragging = true;
        element.classList.add('dragging');
        const left = Math.max(0, Math.min(stage.clientWidth - element.offsetWidth, start.left + dx));
        const top = Math.max(0, Math.min(stage.clientHeight - element.offsetHeight, start.top + dy));
        overlayLayout[type] = { ...(overlayLayout[type] || {}), x: left / stage.clientWidth, y: top / stage.clientHeight };
        applyOverlayLayout();
      };
      const up = () => {
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
        element.classList.remove('dragging');
        if (!dragging) return;
        saveOverlayLayout();
        // Swallow the click that ends the drag.
        window.addEventListener('click', (clickEvent) => { clickEvent.stopPropagation(); clickEvent.preventDefault(); }, { capture: true, once: true });
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    });
  }
  Object.keys(overlayElements).forEach(makeMovable);

  // Saved frames: paints the overlays exactly as they appear on the video (where they are, at their size), scaled to
  // the frame's full resolution. Walks each visible overlay, drawing backgrounds, borders, photos, and text.
  function paintOverlays(context, width) {
    const stage = $('stage');
    const stageRect = stage.getBoundingClientRect();
    if (!stageRect.width) return;
    const scale = width / stageRect.width;
    const roots = Object.values(overlayElements).map((id) => $(id))
      .filter((element) => !element.hidden && !element.classList.contains('placeholder') && !element.classList.contains('fading'));
    roots.forEach((root) => paintElement(context, root, stageRect, scale));
  }
  function parseColor(value) {
    const match = String(value).match(/rgba?[(]([^)]+)[)]/);
    if (!match) return null;
    const parts = match[1].split(',').map((part) => Number(part.trim()));
    return { css: value, alpha: parts.length > 3 ? parts[3] : 1 };
  }
  function roundedPath(context, x, y, w, h, radius) {
    const r = Math.max(0, Math.min(radius, w / 2, h / 2));
    context.beginPath();
    if (context.roundRect) context.roundRect(x, y, w, h, r); else context.rect(x, y, w, h);
  }
  function paintElement(context, element, stageRect, scale) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || element.classList.contains('vote-modes') || element.tagName === 'BUTTON') return;
    const rect = element.getBoundingClientRect();
    const x = (rect.left - stageRect.left) * scale;
    const y = (rect.top - stageRect.top) * scale;
    const w = rect.width * scale;
    const h = rect.height * scale;
    context.save();
    context.globalAlpha *= Number(style.opacity);
    const radius = parseFloat(style.borderTopLeftRadius) * scale || 0;
    const background = parseColor(style.backgroundColor);
    if (background && background.alpha > 0) {
      roundedPath(context, x, y, w, h, radius);
      context.fillStyle = background.css;
      context.fill();
    }
    const borderWidth = parseFloat(style.borderTopWidth) || 0;
    const border = parseColor(style.borderTopColor);
    if (borderWidth > 0 && style.borderTopStyle !== 'none' && border && border.alpha > 0) {
      context.lineWidth = borderWidth * scale;
      context.strokeStyle = border.css;
      context.setLineDash(style.borderTopStyle === 'dotted' ? [borderWidth * scale, borderWidth * scale * 1.5] : (style.borderTopStyle === 'dashed' ? [borderWidth * scale * 3, borderWidth * scale * 2] : []));
      roundedPath(context, x + context.lineWidth / 2, y + context.lineWidth / 2, w - context.lineWidth, h - context.lineWidth, radius);
      context.stroke();
      context.setLineDash([]);
    }
    if (element.tagName === 'IMG') {
      if (element.complete && element.naturalWidth) {
        roundedPath(context, x, y, w, h, radius);
        context.clip();
        context.drawImage(element, x, y, w, h);
      }
      context.restore();
      return;
    }
    for (const node of element.childNodes) {
      if (node.nodeType === 1) paintElement(context, node, stageRect, scale);
      else if (node.nodeType === 3 && node.textContent.trim()) paintText(context, node, style, stageRect, scale);
    }
    context.restore();
  }
  // Text, line by line where the browser wrapped it.
  function paintText(context, node, style, stageRect, scale) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const lines = [...range.getClientRects()].filter((line) => line.width > 0);
    if (!lines.length) return;
    context.font = style.fontStyle + ' ' + style.fontWeight + ' ' + (parseFloat(style.fontSize) * scale) + 'px ' + style.fontFamily;
    context.fillStyle = style.color;
    context.textBaseline = 'middle';
    context.textAlign = 'left';
    const words = node.textContent.trim().split(/ +/);
    let next = 0;
    lines.forEach((line, index) => {
      const lineWidth = line.width * scale;
      let text = '';
      if (index === lines.length - 1) text = words.slice(next).join(' ');
      else {
        while (next < words.length) {
          const candidate = text ? text + ' ' + words[next] : words[next];
          if (text && context.measureText(candidate).width > lineWidth + 2) break;
          text = candidate;
          next += 1;
        }
      }
      context.fillText(text, (line.left - stageRect.left) * scale, (line.top - stageRect.top + line.height / 2) * scale);
    });
  }
  applyOverlayLayout();
  // When a person spoke: their stretches (from the speaker marks), on a bar across the meeting and as a list.
  let spokePerson = null;
  let spokeCurrent = -2;
  function speakingStretches(id) {
    const stretches = [];
    turns.forEach((turn, index) => {
      const speaking = turn.speakers.includes(id);
      const before = index > 0 && turns[index - 1].speakers.includes(id);
      if (speaking && !before) stretches.push({ from: turn.at, to: endSeconds });
      if (!speaking && before && stretches.length) stretches[stretches.length - 1].to = turn.at;
    });
    return stretches;
  }
  function openSpokeDialog(id) {
    spokePerson = id;
    renderSpoke();
    if (!$('spoke-dialog').open) $('spoke-dialog').show();
  }
  function renderSpoke() {
    if (!spokePerson) return;
    const person = peopleMap.get(spokePerson) || { id: spokePerson, name: spokePerson };
    const stretches = speakingStretches(spokePerson);
    $('spoke-title').textContent = 'When ' + shownName(person) + ' spoke';
    const total = stretches.reduce((sum, item) => sum + (item.to - item.from), 0);
    $('spoke-summary').textContent = stretches.length ? stretches.length + ' time' + (stretches.length === 1 ? '' : 's') + ', ' + fmt(total) + ' in all' : 'Not marked as speaking yet';
    const bar = $('spoke-bar');
    bar.textContent = '';
    stretches.forEach((item) => {
      const segment = document.createElement('span');
      segment.style.left = (item.from / endSeconds * 100) + '%';
      segment.style.width = ((item.to - item.from) / endSeconds * 100) + '%';
      segment.title = fmt(item.from) + '-' + fmt(item.to);
      bar.appendChild(segment);
    });
    const marker = document.createElement('i');
    marker.id = 'spoke-marker';
    bar.appendChild(marker);
    const list = $('spoke-list');
    list.textContent = '';
    stretches.forEach((item) => {
      const row = document.createElement('li');
      const go = document.createElement('button');
      go.type = 'button';
      go.className = 'go';
      const when = document.createElement('time');
      when.textContent = fmt(item.from);
      const length = document.createElement('span');
      length.className = 'label';
      length.textContent = fmt(item.to - item.from) + ' ';
      const words = document.createElement('span');
      words.className = 'spoke-text';
      // Their first words in that stretch.
      words.textContent = transcript.filter((line) => line[0] >= item.from - 0.5 && line[0] < item.to).slice(0, 2).map((line) => line[2]).join(' ');
      go.append(when, length, words);
      go.addEventListener('click', () => showPosition(item.from));
      const boostButton = document.createElement('button');
      boostButton.type = 'button';
      boostButton.className = 'small';
      boostButton.textContent = '🔊';
      boostButton.title = 'Boost this stretch and transcribe it again';
      boostButton.addEventListener('click', () => openBoostDialog(item.from, item.to));
      const clipButton = document.createElement('button');
      clipButton.type = 'button';
      clipButton.className = 'small';
      clipButton.textContent = '✂';
      clipButton.title = 'Use this stretch as the clip';
      clipButton.addEventListener('click', () => { start = item.from; end = item.to; update(); showPosition(item.from); });
      row.append(go, boostButton, clipButton);
      list.appendChild(row);
    });
    spokeCurrent = -2;
    updateSpokeCurrent();
  }
  // While open: mark where the video is, and highlight the stretch being played.
  function updateSpokeCurrent() {
    if (!spokePerson || !$('spoke-dialog').open) return;
    const marker = $('spoke-marker');
    if (marker) marker.style.left = (position / endSeconds * 100) + '%';
    const stretches = speakingStretches(spokePerson);
    const index = stretches.findIndex((item) => position >= item.from - 0.05 && position < item.to);
    if (index === spokeCurrent) return;
    spokeCurrent = index;
    [...$('spoke-list').children].forEach((row, rowIndex) => row.classList.toggle('current', rowIndex === index));
    [...$('spoke-bar').children].forEach((segment, segmentIndex) => { if (segment.tagName === 'SPAN') segment.classList.toggle('now', segmentIndex === index); });
  }
  $('spoke-bar').addEventListener('click', (event) => {
    const rect = $('spoke-bar').getBoundingClientRect();
    const seconds = (event.clientX - rect.left) / rect.width * endSeconds;
    // Jump to the stretch clicked, or the nearest one.
    const stretches = speakingStretches(spokePerson);
    if (!stretches.length) return;
    const hit = stretches.find((item) => seconds >= item.from && seconds < item.to)
      || stretches.reduce((best, item) => (Math.abs(item.from - seconds) < Math.abs(best.from - seconds) ? item : best));
    showPosition(hit.from);
  });
  $('spoke-prev').addEventListener('click', () => {
    const previous = [...speakingStretches(spokePerson)].reverse().find((item) => item.from < position - 1.5);
    if (previous) showPosition(previous.from);
  });
  $('spoke-next').addEventListener('click', () => {
    const next = speakingStretches(spokePerson).find((item) => item.from > position + 0.5);
    if (next) showPosition(next.from);
  });
  $('spoke-close').addEventListener('click', () => $('spoke-dialog').close());
  // Chapter scope: markers above the scrubber for speaker changes, motions, and each vote's last vote.
  function renderScrubMarks() {
    const box = $('scrub-marks');
    const range = transcriptRange;
    box.hidden = !range;
    if (!range) return;
    const speakersLane = $('marks-speakers');
    const eventsLane = $('marks-events');
    speakersLane.textContent = '';
    eventsLane.textContent = '';
    const span = Math.max(0.001, range.max - range.min);
    const place = (element, seconds, lane, title, jumpTo) => {
      element.style.left = ((Math.max(range.min, seconds) - range.min) / span * 100) + '%';
      element.title = fmt(seconds) + '  ' + title;
      element.addEventListener('click', () => showPosition(jumpTo ?? seconds));
      lane.appendChild(element);
    };
    // Speaker changes in the chapter, plus whoever is already speaking when it starts.
    turns.forEach((turn, index) => {
      const inside = turn.at >= range.min && turn.at < range.max;
      const atStart = turn.at < range.min && (index + 1 >= turns.length || turns[index + 1].at > range.min);
      if ((!inside && !atStart) || !turn.speakers.length) return;
      const people = turn.speakers.map((id) => peopleMap.get(id) || { id, name: id });
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'scrub-mark';
      mark.appendChild(avatar(people[0]));
      if (people.length > 1) {
        const more = document.createElement('span');
        more.className = 'more';
        more.textContent = '+' + (people.length - 1);
        mark.appendChild(more);
      }
      place(mark, inside ? turn.at : range.min, speakersLane, people.map(shownName).join(', ') + ' speaking', inside ? turn.at : range.min);
    });
    // Motions (when they were made) and each vote's first vote cast (clicking it plays the roll call from just before).
    voteData.votes.forEach((vote) => {
      if (vote.movedBy?.id && vote.movedBy.at >= range.min && vote.movedBy.at < range.max) {
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.className = 'scrub-mark event';
        mark.textContent = '✋';
        place(mark, vote.movedBy.at, eventsLane, 'Motion by ' + shownName(peopleMap.get(vote.movedBy.id) || { id: vote.movedBy.id, name: vote.movedBy.id }) + (vote.motion ? ': ' + vote.motion : ''));
      }
      const changes = voteChanges(vote);
      const first = changes.length ? Math.min(...changes.map((change) => change.at)) : vote.at;
      if (first >= range.min && first < range.max) {
        const mark = document.createElement('button');
        mark.type = 'button';
        mark.className = 'scrub-mark event vote-mark ' + voteState(vote, Infinity).outcome;
        mark.textContent = '🗳';
        place(mark, first, eventsLane, 'Voting begins: ' + (vote.motion || 'Vote') + ' — ' + describeTally(vote), Math.max(range.min, first - 1));
      }
    });
  }
  // Camera views and zoom areas ({session}/views.json). A view is a camera angle (such as the dais from the back of the
  // room), recognized by its picture: each camera change is matched to the view whose reference picture looks most
  // like it, unless set by hand. Each view has a box for each person; the video can zoom to the speaker's box.
  let viewData = { views: page.views.views || [], sceneViews: page.views.sceneViews || {} };
  let manualZoom = null;
  let zoomSelecting = false;
  let zoomSelectedAt = 0;
  let autoZoom = false;
  try { autoZoom = localStorage.getItem('thumbnails.autoZoom') === '1'; } catch {}
  $('auto-zoom').checked = autoZoom;
  function setAutoZoom(on) {
    autoZoom = on;
    $('auto-zoom').checked = on;
    try { localStorage.setItem('thumbnails.autoZoom', on ? '1' : '0'); } catch {}
    updateZoom();
  }
  $('auto-zoom').addEventListener('change', () => setAutoZoom($('auto-zoom').checked));
  // A picture's signature: a 16x9 grayscale copy. Two shots from the same camera angle differ by a few levels on
  // average (people move); different angles differ by 40 or more (out of 255), so 15 separates them well.
  const pictureSignatures = new Map();
  function pictureSignature(url) {
    if (!pictureSignatures.has(url)) {
      pictureSignatures.set(url, new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          // Shrink in two steps so each point averages its area.
          const middle = document.createElement('canvas');
          middle.width = 64;
          middle.height = 36;
          const middleContext = middle.getContext('2d');
          middleContext.imageSmoothingQuality = 'high';
          middleContext.drawImage(image, 0, 0, 64, 36);
          const canvas = document.createElement('canvas');
          canvas.width = 16;
          canvas.height = 9;
          const context = canvas.getContext('2d');
          context.imageSmoothingQuality = 'high';
          context.drawImage(middle, 0, 0, 16, 9);
          const data = context.getImageData(0, 0, 16, 9).data;
          const gray = new Float32Array(144);
          for (let index = 0; index < 144; index += 1) gray[index] = data[index * 4] * 0.3 + data[index * 4 + 1] * 0.59 + data[index * 4 + 2] * 0.11;
          resolve(gray);
        };
        image.onerror = () => resolve(null);
        image.src = url;
      }));
    }
    return pictureSignatures.get(url);
  }
  const signatureDifference = (left, right) => { let total = 0; for (let index = 0; index < 144; index += 1) total += Math.abs(left[index] - right[index]); return total / 144; };
  const sameAngle = 15;
  const sceneViewCache = new Map();
  // The view a camera change shows: set by hand, else the view whose picture it looks most like (within 15), else none.
  async function viewForScene(file) {
    if (Object.prototype.hasOwnProperty.call(viewData.sceneViews, file)) return viewData.views.find((view) => view.id === viewData.sceneViews[file]) || null;
    const signature = await pictureSignature(file);
    if (!signature) return null;
    let best = null;
    for (const view of viewData.views) {
      if (!view.scene) continue;
      const reference = await pictureSignature(view.scene);
      if (!reference) continue;
      const difference = signatureDifference(signature, reference);
      if (difference <= sameAngle && (!best || difference < best.difference)) best = { view, difference };
    }
    return best ? best.view : null;
  }
  function currentSceneFile() {
    return nowScene >= 0 && page.scenes[nowScene] ? page.scenes[nowScene][1] : null;
  }
  let currentView = null;
  async function refreshCurrentView() {
    const file = currentSceneFile();
    const view = file ? await viewForScene(file) : null;
    if (file !== currentSceneFile()) return;
    currentView = view;
    sceneViewCache.set(file, view ? view.id : null);
    renderViewSelect();
    updateZoom();
  }
  function renderViewSelect() {
    const select = $('view-select');
    const file = currentSceneFile();
    if (!file) return;
    if (!sceneViewCache.has(file)) { refreshCurrentView(); }
    const manual = Object.prototype.hasOwnProperty.call(viewData.sceneViews, file);
    const shownId = sceneViewCache.get(file) ?? null;
    const options = [['', manual ? '📷 automatic' : '📷 ' + (viewData.views.find((view) => view.id === shownId)?.name || 'no view') + ' (automatic)']]
      .concat(viewData.views.map((view) => [view.id, '📷 ' + view.name]))
      .concat([['none', '📷 not a view'], ['new', '➕ New view from this camera…'], ['edit', '✎ Zoom areas…']]);
    select.textContent = '';
    options.forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    });
    select.value = manual ? (viewData.sceneViews[file] === null ? 'none' : viewData.sceneViews[file]) : '';
  }
  $('view-select').addEventListener('click', (event) => event.stopPropagation());
  $('view-select').addEventListener('change', async (event) => {
    event.stopPropagation();
    const file = currentSceneFile();
    const value = $('view-select').value;
    if (!file) return;
    if (value === 'edit') { renderViewSelect(); openZoomEditor(); return; }
    if (value === 'new') {
      const name = (prompt('Name this camera view (for example: Dais, wide):') || '').trim();
      if (!name) { renderViewSelect(); return; }
      const view = { id: Date.now().toString(36), name, scene: file, regions: {} };
      viewData.views = [...viewData.views, view];
      viewData.sceneViews = { ...viewData.sceneViews, [file]: view.id };
      sceneViewCache.clear();
      if (await saveViews('Added the view ' + name)) openZoomEditor();
      return;
    }
    const sceneViews = { ...viewData.sceneViews };
    if (value === '') delete sceneViews[file]; else sceneViews[file] = value === 'none' ? null : value;
    viewData.sceneViews = sceneViews;
    sceneViewCache.clear();
    await saveViews('Saved the camera view for this shot');
  });
  async function saveViews(done) {
    try {
      if (location.protocol === 'file:') throw new Error('saving needs the local server (npm run serve)');
      const response = await fetch('../views.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ updatedAt: new Date().toISOString(), views: viewData.views, sceneViews: viewData.sceneViews }, null, 2) });
      if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
      $('snapshot-status').textContent = done;
      sceneViewCache.clear();
      refreshCurrentView();
      return true;
    } catch (error) {
      $('snapshot-status').textContent = 'Not saved: ' + error.message;
      return false;
    }
  }

  // Magnifying. Each person's area in a camera view has a square (where they sit) and a display box (where its larger
  // copy goes, and how big), both set in the zoom area editor. While they speak on that view the copy fades in; it
  // stays a few seconds after they stop, then fades out (timed by the video, so scrubbing and pausing agree).
  const defaultGrow = 1.8;
  const holdSeconds = 3;
  const fadeSeconds = 0.6;
  // Just before someone speaks, their larger copy grows out of where they sit, ready when they start.
  const leadSeconds = 0.8;
  const regionHeight = (region) => region.h ?? region.w;
  // Default display box: centered on the square, grown, kept inside the picture.
  function magnifiedPlace(region, grow) {
    const w = Math.min(1, region.w * grow);
    const h = Math.min(1, regionHeight(region) * grow);
    const centerX = region.x + region.w / 2;
    const centerY = region.y + regionHeight(region) / 2;
    return { x: Math.max(0, Math.min(1 - w, centerX - w / 2)), y: Math.max(0, Math.min(1 - h, centerY - h / 2)), w, h };
  }
  const targetOf = (region) => region.target || magnifiedPlace(region, defaultGrow);
  // What to show at a video position: each area with how far along it is, from 0 (where they sit) to 1 (its larger
  // copy in place). It grows in during the lead-up to speaking, holds while they speak and a few seconds after, then
  // shrinks back into their seat.
  let manualFadeStart = 0;
  function magnifiedAt(seconds) {
    if (manualZoom) return [{ region: manualZoom, progress: Math.min(1, (performance.now() - manualFadeStart) / (leadSeconds * 1000)) }];
    if (!autoZoom || !currentView) return [];
    const shown = [];
    Object.entries(currentView.regions || {}).forEach(([id, region]) => {
      const stretches = speakingStretches(id);
      if (stretches.some((item) => seconds >= item.from && seconds < item.to)) { shown.push({ region, progress: 1 }); return; }
      const ended = [...stretches].reverse().find((item) => item.to <= seconds);
      const since = ended ? seconds - ended.to : Infinity;
      const next = stretches.find((item) => item.from > seconds && item.from - seconds <= leadSeconds);
      const growing = next ? 1 - (next.from - seconds) / leadSeconds : 0;
      const leaving = since < holdSeconds ? 1 : (since < holdSeconds + fadeSeconds ? 1 - (since - holdSeconds) / fadeSeconds : 0);
      const progress = Math.max(growing, leaving);
      if (progress > 0) shown.push({ region, progress });
    });
    return shown;
  }
  const ease = (value) => (value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2);
  let magnifyFrame = 0;
  function updateZoom() {
    $('zoom-toggle').classList.toggle('on', Boolean(manualZoom) || zoomSelecting);
    if (!magnifyFrame) magnifyFrame = requestAnimationFrame(magnifyLoop);
  }
  function magnifyLoop() {
    magnifyFrame = 0;
    const visible = drawMagnifier();
    // Keep animating while anything shows (and while playing, so fades follow the video).
    if (visible || (playerReady && !video.paused && (autoZoom || manualZoom))) magnifyFrame = requestAnimationFrame(magnifyLoop);
  }
  function currentSeconds() {
    return playerReady && !video.hidden ? toPosition(video.currentTime) : position;
  }
  // Draws each visible area's larger copy, with a black border and a drop shadow.
  function paintMagnified(context, source, width, height, items) {
    const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
    const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
    if (!sourceWidth || !sourceHeight) return;
    items.forEach(({ region, progress }) => {
      if (progress <= 0) return;
      // Between where they sit and the larger copy's place, eased; it fades in over the first part of the way.
      const target = targetOf(region);
      const along = ease(Math.min(1, progress));
      const opacity = Math.min(1, progress * 2.5);
      const mix = (from, to) => from + (to - from) * along;
      const x = mix(region.x, target.x) * width;
      const y = mix(region.y, target.y) * height;
      const w = mix(region.w, target.w) * width;
      const h = mix(regionHeight(region), target.h) * height;
      const border = Math.max(2, width / 320);
      context.save();
      context.globalAlpha = opacity;
      context.shadowColor = 'rgba(0, 0, 0, 0.7)';
      context.shadowBlur = Math.max(6, width / 80);
      context.shadowOffsetX = width / 400;
      context.shadowOffsetY = width / 300;
      context.fillStyle = '#000';
      context.fillRect(x - border, y - border, w + border * 2, h + border * 2);
      context.shadowColor = 'transparent';
      context.drawImage(source, region.x * sourceWidth, region.y * sourceHeight, region.w * sourceWidth, regionHeight(region) * sourceHeight, x, y, w, h);
      context.restore();
    });
  }
  function drawMagnifier() {
    const canvas = $('magnifier');
    const stage = $('stage');
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round((stage.clientWidth || 960) * ratio);
    const height = Math.round((stage.clientHeight || 540) * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context || !context.clearRect) return false;
    context.clearRect(0, 0, width, height);
    const items = magnifiedAt(currentSeconds()).filter((item) => item.progress > 0);
    if (!items.length) return false;
    paintMagnified(context, playerReady && !video.hidden ? video : $('frame'), width, height, items);
    return true;
  }
  // Manual: 🔍, then drag a square on the video; 🔍 again removes it.
  $('zoom-toggle').addEventListener('click', () => {
    if (manualZoom || zoomSelecting) { manualZoom = null; zoomSelecting = false; $('stage').classList.remove('selecting'); updateZoom(); return; }
    zoomSelecting = true;
    $('stage').classList.add('selecting');
    $('zoom-toggle').classList.add('on');
    $('snapshot-status').textContent = 'Drag a square on the video to magnify it';
  });
  $('stage').addEventListener('pointerdown', (event) => {
    if (!zoomSelecting || event.button !== 0) return;
    event.preventDefault();
    const rect = $('stage').getBoundingClientRect();
    const startX = event.clientX - rect.left;
    const startY = event.clientY - rect.top;
    const box = $('zoom-select');
    let size = 0;
    let left = startX;
    let top = startY;
    const move = (moveEvent) => {
      const dx = moveEvent.clientX - rect.left - startX;
      const dy = moveEvent.clientY - rect.top - startY;
      size = Math.min(rect.width, rect.height, Math.max(Math.abs(dx), Math.abs(dy)));
      left = Math.max(0, Math.min(rect.width - size, dx < 0 ? startX - size : startX));
      top = Math.max(0, Math.min(rect.height - size, dy < 0 ? startY - size : startY));
      Object.assign(box.style, { left: left + 'px', top: top + 'px', width: size + 'px', height: size + 'px' });
      box.hidden = false;
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      box.hidden = true;
      zoomSelecting = false;
      zoomSelectedAt = Date.now();
      $('stage').classList.remove('selecting');
      if (size < 12) { $('snapshot-status').textContent = ''; updateZoom(); return; }
      manualZoom = { x: left / rect.width, y: top / rect.height, w: size / rect.width, h: size / rect.height };
      manualFadeStart = performance.now();
      $('snapshot-status').textContent = 'Magnified (🔍 to remove it)';
      updateZoom();
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  });
  window.addEventListener('resize', drawMagnifier);
  video.addEventListener('seeked', drawMagnifier);

  // Zoom area editor for the current view: a box per person, drawn on the current frame (or the view's picture).
  let zoomEditing = null;
  let zoomPerson = null;
  let zoomPicture = null;
  const zoomCanvas = $('zoom-canvas');
  async function openZoomEditor() {
    const view = currentView;
    if (!view) { $('snapshot-status').textContent = 'Pick or create a camera view for this shot first (📷 above the transcript)'; return; }
    zoomEditing = { ...view, regions: { ...(view.regions || {}) } };
    $('zoom-title').textContent = 'Zoom areas: ' + view.name;
    $('zoom-view-name').value = view.name;
    $('zoom-status').textContent = '';
    zoomPerson = voteData.members[0]?.id || null;
    renderZoomPeople();
    await loadZoomPicture(playerReady);
    $('zoom-dialog').show();
  }
  async function loadZoomPicture(fromVideo) {
    if (fromVideo && playerReady && video.videoWidth) {
      zoomPicture = document.createElement('canvas');
      zoomPicture.width = video.videoWidth;
      zoomPicture.height = video.videoHeight;
      zoomPicture.getContext('2d').drawImage(video, 0, 0);
    } else {
      zoomPicture = await new Promise((resolve) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => resolve(null); image.src = zoomEditing.scene || currentSceneFile(); });
    }
    drawZoomCanvas();
  }
  function renderZoomPeople() {
    const box = $('zoom-people');
    box.textContent = '';
    const memberIds = voteData.members.map((member) => member.id);
    const ids = [...memberIds, ...Object.keys(zoomEditing.regions).filter((id) => !memberIds.includes(id))];
    const others = people.filter((person) => !ids.includes(person.id));
    ids.forEach((id) => {
      const person = peopleMap.get(id) || { id, name: id };
      const button = document.createElement('button');
      button.type = 'button';
      button.className = (id === zoomPerson ? 'on' : '') + (zoomEditing.regions[id] ? ' has-area' : '');
      const name = document.createElement('span');
      name.textContent = lastName(person);
      button.append(avatar(person), name);
      button.addEventListener('click', () => { zoomPerson = id; renderZoomPeople(); drawZoomCanvas(); });
      box.appendChild(button);
    });
    // Anyone else (presenters, staff) from a menu.
    const select = document.createElement('select');
    const first = document.createElement('option');
    first.value = '';
    first.textContent = '+ someone else…';
    select.appendChild(first);
    others.sort((a, b) => shownName(a).localeCompare(shownName(b))).forEach((person) => {
      const option = document.createElement('option');
      option.value = person.id;
      option.textContent = shownName(person);
      select.appendChild(option);
    });
    select.addEventListener('change', () => { if (select.value) { zoomPerson = select.value; renderZoomPeople(); drawZoomCanvas(); } });
    box.appendChild(select);
  }
  // Which box of the selected person is being edited: where they sit ('source') or their larger copy ('copy').
  let zoomEditBox = 'source';
  function setZoomEditBox(box) {
    zoomEditBox = box;
    $('zoom-edit-source').classList.toggle('on', box === 'source');
    $('zoom-edit-copy').classList.toggle('on', box === 'copy');
    drawZoomCanvas();
  }
  $('zoom-edit-source').addEventListener('click', () => setZoomEditBox('source'));
  $('zoom-edit-copy').addEventListener('click', () => setZoomEditBox('copy'));
  setZoomEditBox('source');
  const boxOf = (region, which) => (which === 'copy' ? targetOf(region) : { x: region.x, y: region.y, w: region.w, h: regionHeight(region) });
  // The 8 resize handles of a box: corners and edge midpoints, with which sides each one moves.
  function boxHandles(box) {
    const left = box.x, right = box.x + box.w, top = box.y, bottom = box.y + box.h;
    const middleX = box.x + box.w / 2, middleY = box.y + box.h / 2;
    return [
      { x: left, y: top, sides: 'nw', cursor: 'nwse-resize' }, { x: right, y: top, sides: 'ne', cursor: 'nesw-resize' },
      { x: left, y: bottom, sides: 'sw', cursor: 'nesw-resize' }, { x: right, y: bottom, sides: 'se', cursor: 'nwse-resize' },
      { x: middleX, y: top, sides: 'n', cursor: 'ns-resize' }, { x: middleX, y: bottom, sides: 's', cursor: 'ns-resize' },
      { x: left, y: middleY, sides: 'w', cursor: 'ew-resize' }, { x: right, y: middleY, sides: 'e', cursor: 'ew-resize' }
    ];
  }
  function drawZoomCanvas() {
    if (!zoomPicture || !zoomEditing) return;
    zoomCanvas.width = zoomPicture.width;
    zoomCanvas.height = zoomPicture.height;
    const W = zoomCanvas.width;
    const H = zoomCanvas.height;
    const context = zoomCanvas.getContext('2d');
    context.drawImage(zoomPicture, 0, 0, W, H);
    const line = Math.max(2, W / 400);
    context.font = '600 ' + Math.round(H * 0.022) + 'px system-ui, sans-serif';
    context.textBaseline = 'top';
    // Names sit just outside a box (above it, or below when there's no room), so they never cover what's inside.
    const label = (text, box, color) => {
      const height = H * 0.03;
      const width = context.measureText(text).width + line * 4;
      const x = Math.max(0, Math.min(W - width, box.x * W));
      const above = box.y * H - height - line;
      const y = above >= 0 ? above : Math.min(H - height, (box.y + box.h) * H + line);
      context.fillStyle = 'rgba(0, 0, 0, 0.7)';
      context.fillRect(x, y, width, height);
      context.fillStyle = color;
      context.fillText(text, x + line * 2, y + line);
    };
    const drawCopy = (region, active) => {
      const target = targetOf(region);
      const border = Math.max(2, W / 320);
      context.save();
      context.globalAlpha = active ? 1 : 0.45;
      context.shadowColor = 'rgba(0, 0, 0, 0.7)';
      context.shadowBlur = W / 80;
      context.fillStyle = '#000';
      context.fillRect(target.x * W - border, target.y * H - border, target.w * W + border * 2, target.h * H + border * 2);
      context.shadowColor = 'transparent';
      context.drawImage(zoomPicture, region.x * zoomPicture.width, region.y * zoomPicture.height, region.w * zoomPicture.width, regionHeight(region) * zoomPicture.height, target.x * W, target.y * H, target.w * W, target.h * H);
      context.restore();
    };
    const drawHandles = (box) => {
      const size = W / 90;
      context.fillStyle = '#ffd166';
      context.strokeStyle = '#000';
      context.lineWidth = Math.max(1, line / 2);
      boxHandles(box).forEach((handle) => {
        context.fillRect(handle.x * W - size / 2, handle.y * H - size / 2, size, size);
        context.strokeRect(handle.x * W - size / 2, handle.y * H - size / 2, size, size);
      });
    };
    // Others: just their squares. The selected person: both boxes, the one being edited on top with its handles.
    Object.entries(zoomEditing.regions).forEach(([id, region]) => {
      if (id === zoomPerson) return;
      context.lineWidth = line;
      context.strokeStyle = 'rgba(255, 255, 255, 0.8)';
      context.strokeRect(region.x * W, region.y * H, region.w * W, regionHeight(region) * H);
      label(lastName(peopleMap.get(id) || { id, name: id }), boxOf(region, 'source'), '#ffffff');
    });
    const region = zoomEditing.regions[zoomPerson];
    if (!region) return;
    const name = lastName(peopleMap.get(zoomPerson) || { id: zoomPerson, name: zoomPerson });
    const source = boxOf(region, 'source');
    const copy = boxOf(region, 'copy');
    const drawSource = (active) => {
      context.lineWidth = active ? line * 1.5 : line;
      context.setLineDash(active ? [] : [line * 3, line * 2]);
      context.strokeStyle = active ? '#ffd166' : 'rgba(255, 209, 102, 0.6)';
      context.strokeRect(source.x * W, source.y * H, source.w * W, source.h * H);
      context.setLineDash([]);
    };
    if (zoomEditBox === 'copy') {
      drawSource(false);
      drawCopy(region, true);
      context.lineWidth = line * 1.5;
      context.strokeStyle = '#ffd166';
      context.strokeRect(copy.x * W, copy.y * H, copy.w * W, copy.h * H);
      drawHandles(copy);
      label(name, copy, '#ffd166');
    } else {
      // Editing where they sit: the larger copy is hidden so it can't get in the way.
      drawSource(true);
      drawHandles(source);
      label(name, source, '#ffd166');
    }
  }
  // What a press at a point would do to the box being edited: a handle (resize), inside (move), or outside.
  function zoomHit(point, rect) {
    const region = zoomEditing.regions[zoomPerson];
    if (!region) return { mode: 'draw' };
    const box = boxOf(region, zoomEditBox);
    const toleranceX = 10 / rect.width;
    const toleranceY = 10 / rect.height;
    const handle = boxHandles(box).find((item) => Math.abs(point.x - item.x) <= toleranceX && Math.abs(point.y - item.y) <= toleranceY);
    if (handle) return { mode: 'resize', handle, box };
    if (point.x >= box.x && point.x <= box.x + box.w && point.y >= box.y && point.y <= box.y + box.h) return { mode: 'move', box };
    return { mode: zoomEditBox === 'source' ? 'draw' : 'none' };
  }
  // Resizes a box from a handle, keeping its shape (h/w as fractions), anchored on the opposite side (or centered on
  // the other axis for an edge handle), and kept inside the picture.
  function resizedBox(box, sides, point, minimum) {
    const shape = box.h / box.w;
    const anchorX = sides.includes('w') ? box.x + box.w : box.x;
    const anchorY = sides.includes('n') ? box.y + box.h : box.y;
    let w;
    if (sides.length === 2) w = Math.max(Math.abs(point.x - anchorX), Math.abs(point.y - anchorY) / shape);
    else if (sides === 'e' || sides === 'w') w = Math.abs(point.x - anchorX);
    else w = Math.abs(point.y - anchorY) / shape;
    w = Math.max(minimum, Math.min(1, 1 / shape, w));
    const h = w * shape;
    let x = sides.includes('w') ? anchorX - w : (sides.includes('e') ? anchorX : box.x + box.w / 2 - w / 2);
    let y = sides.includes('n') ? anchorY - h : (sides.includes('s') ? anchorY : box.y + box.h / 2 - h / 2);
    x = Math.max(0, Math.min(1 - w, x));
    y = Math.max(0, Math.min(1 - h, y));
    return { x, y, w, h };
  }
  function setZoomBox(which, box) {
    const region = zoomEditing.regions[zoomPerson];
    if (which === 'copy') { region.target = box; return; }
    // Changing where they sit keeps the larger copy where it is, at the same size (reshaped to match if needed).
    const target = targetOf(region);
    const shape = box.h / box.w;
    zoomEditing.regions[zoomPerson] = { x: box.x, y: box.y, w: box.w, h: box.h, target: { ...target, h: Math.min(1 - target.y, target.w * shape) } };
  }
  zoomCanvas.addEventListener('pointermove', (event) => {
    if (event.buttons || !zoomPerson || !zoomEditing) return;
    const rect = zoomCanvas.getBoundingClientRect();
    const hit = zoomHit({ x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }, rect);
    zoomCanvas.style.cursor = hit.mode === 'resize' ? hit.handle.cursor : (hit.mode === 'move' ? 'move' : (hit.mode === 'draw' ? 'crosshair' : 'default'));
  });
  zoomCanvas.addEventListener('pointerdown', (event) => {
    if (!zoomPerson || !zoomPicture) { $('zoom-status').textContent = 'Pick a person first'; return; }
    const rect = zoomCanvas.getBoundingClientRect();
    const point = (pointerEvent) => ({ x: (pointerEvent.clientX - rect.left) / rect.width, y: (pointerEvent.clientY - rect.top) / rect.height });
    const start = point(event);
    const hit = zoomHit(start, rect);
    if (hit.mode === 'none') return;
    const which = zoomEditBox;
    const aspect = zoomCanvas.width / Math.max(1, zoomCanvas.height);
    zoomCanvas.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      const now = point(moveEvent);
      if (hit.mode === 'move') {
        setZoomBox(which, { ...hit.box, x: Math.max(0, Math.min(1 - hit.box.w, hit.box.x + now.x - start.x)), y: Math.max(0, Math.min(1 - hit.box.h, hit.box.y + now.y - start.y)) });
      } else if (hit.mode === 'resize') {
        setZoomBox(which, resizedBox(hit.box, hit.handle.sides, now, 0.02));
      } else {
        // A new square where they sit: as wide (in pixels) as the larger of the two drags.
        const dx = now.x - start.x;
        const dy = now.y - start.y;
        const w = Math.min(1, 1 / aspect, Math.max(Math.abs(dx), Math.abs(dy) / aspect, 0.02));
        const h = w * aspect;
        const square = { x: Math.max(0, Math.min(1 - w, dx < 0 ? start.x - w : start.x)), y: Math.max(0, Math.min(1 - h, dy < 0 ? start.y - h : start.y)), w, h };
        if (zoomEditing.regions[zoomPerson]) setZoomBox('source', square);
        else zoomEditing.regions[zoomPerson] = { ...square, target: magnifiedPlace(square, defaultGrow) };
      }
      drawZoomCanvas();
    };
    const up = () => { zoomCanvas.removeEventListener('pointermove', move); zoomCanvas.removeEventListener('pointerup', up); renderZoomPeople(); };
    zoomCanvas.addEventListener('pointermove', move);
    zoomCanvas.addEventListener('pointerup', up);
  });
  $('zoom-area-remove').addEventListener('click', () => { if (zoomPerson) { delete zoomEditing.regions[zoomPerson]; renderZoomPeople(); drawZoomCanvas(); } });
  $('zoom-frame').addEventListener('click', () => loadZoomPicture(true));
  $('zoom-cancel').addEventListener('click', () => $('zoom-dialog').close());
  $('zoom-view-delete').addEventListener('click', async () => {
    if (!zoomEditing || !confirm('Delete the view "' + zoomEditing.name + '" and its zoom areas?')) return;
    const id = zoomEditing.id;
    viewData.views = viewData.views.filter((view) => view.id !== id);
    viewData.sceneViews = Object.fromEntries(Object.entries(viewData.sceneViews).filter(([, value]) => value !== id));
    if (await saveViews('Deleted the view')) $('zoom-dialog').close();
  });
  $('zoom-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = $('zoom-view-name').value.trim() || zoomEditing.name;
    const edited = { ...zoomEditing, name };
    viewData.views = viewData.views.map((view) => (view.id === edited.id ? edited : view));
    if (await saveViews('Saved the zoom areas for ' + name)) {
      $('zoom-dialog').close();
      // Saving zoom areas means they're wanted: turn on magnifying whoever is speaking (also in 🎛).
      if (!autoZoom) {
        setAutoZoom(true);
        $('snapshot-status').textContent = 'Saved the zoom areas for ' + name + ', and turned on 🔍 Magnify whoever is speaking (in 🎛)';
      }
    }
  });
  // The address bar keeps the position and clip range (?t=01:04:44.100&from=01:02:30&to=01:10:00), so a refresh,
  // bookmark, or shared link reopens at the same spot. replaceState avoids filling the Back history.
  let queryTimer = null;
  let restoring = true;
  function scheduleQueryUpdate() {
    if (restoring || queryTimer) return;
    queryTimer = setTimeout(() => {
      queryTimer = null;
      const params = new URLSearchParams(location.search);
      params.set('t', fmtPrecise(position));
      if (start !== null) params.set('from', fmtPrecise(start)); else params.delete('from');
      if (end !== null) params.set('to', fmtPrecise(end)); else params.delete('to');
      try { history.replaceState(null, '', location.pathname + '?' + params.toString().replace(/%3A/gi, ':') + location.hash); } catch {}
    }, video.paused ? 250 : 1000);
  }
  video.addEventListener('pause', scheduleQueryUpdate);

  $('density').addEventListener('change', renderGrid);
  try { if (localStorage.getItem('thumbnails.playBoosts') === '1') $('play-boosts').checked = true; } catch {}
  renderGrid();
  renderPeople();
  pageReady = true;
  sizeTranscript();
  renderTranscript();
  renderScrubMarks();
  const query = new URLSearchParams(location.search);
  start = parse(query.get('from'));
  end = parse(query.get('to'));
  update();
  showPosition(parse(query.get('t')) ?? 0);
  restoring = false;
</script>
</body>
</html>
`;
}
