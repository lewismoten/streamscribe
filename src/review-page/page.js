import fs from 'fs';
import path from 'path';
import { rename, writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { LOCALE, SOURCES } from '../config/runtime-config.js';
import { loadSessionSegments } from '../sessions/session.js';
import { loadJson } from '../util/fs-utils.js';
import { formatPosition } from '../transcription/transcript.js';
import { renderMarkup } from './markup.js';

// The page's stylesheet and its script, kept as plain files here and written into each page (so a page works on its
// own, even opened from disk). The stylesheet's parts are joined in this order (later rules win), and the script's
// parts share one scope and run in this order.
const pageDir = path.dirname(fileURLToPath(import.meta.url));
const STYLE_PARTS = [
  'base',
  'stage',
  'transcript',
  'words-and-picker',
  'speakers',
  'dialogs',
  'chapters',
  'votes',
  'scrubber',
  'toolbar-and-controls'
];
export const CLIENT_PARTS = [
  'core',
  'player',
  'overlays-and-frames',
  'clip-range',
  'speakers',
  'person-editor',
  'transcript',
  'transcript-words',
  'downloads',
  'transcript-formats',
  'playlist',
  'word-picker',
  'find-and-load',
  'boost',
  'boost-retranscribe',
  'meeting-name',
  'chapters',
  'votes',
  'votes-panel',
  'vote-overlay',
  'clip-dialog',
  'clip-waveform',
  'overlay-layout',
  'spoken-and-markers',
  'camera-views',
  'magnifier',
  'zoom-editor',
  'startup'
];
// Each file is indented two spaces inside the page's <style> or <script>.
const indent = (text) =>
  text
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
// Each style part's leading comment (what it styles) is left out of the page.
const STYLES = indent(
  STYLE_PARTS.map((name) =>
    fs.readFileSync(path.join(pageDir, 'styles', `${name}.css`), 'utf8').replace(/^\/\*[^]*?\*\/\n/, '')
  ).join('')
);
const CLIENT = CLIENT_PARTS.map((name) =>
  indent(fs.readFileSync(path.join(pageDir, 'client', `${name}.js`), 'utf8'))
).join('');

// Thumbnail file name for a video position: HH-MM-SS.jpg, with milliseconds when the position isn't whole.
export function thumbnailFileName(position) {
  const fraction = Math.round((position % 1) * 1000);
  return `${formatPosition(position).replace(/:/g, '-')}${fraction ? `.${String(fraction).padStart(3, '0')}` : ''}.jpg`;
}

const serverPort = 4873;

// Replaces a file in one step, so a page or player reading it never sees half of it.
async function writeFileAtomically(filePath, text) {
  await writeFile(`${filePath}.tmp`, text);
  await rename(`${filePath}.tmp`, filePath);
}

// Thumbnails as the page uses them: file, position, time of day, and pass.
function pageThumbs(thumbnails) {
  const clock = (iso) =>
    iso
      ? new Intl.DateTimeFormat('en-US', {
          timeZone: LOCALE.timeZone,
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit'
        }).format(new Date(iso))
      : '';
  return thumbnails.map((item) => ({
    f: item.fileName,
    s: item.positionSeconds,
    c: clock(item.clockTime),
    l: item.level
  }));
}

// Writes {session}/playback.m3u8 (an HLS playlist of the captured segments, for the page's player),
// {session}/thumbnails/index.html, and {session}/thumbnails/live.json. With `live` (a session still being captured,
// from extract-thumbnails --watch), the playlist stays open so players keep loading new segments, and an open page
// picks up new thumbnails, camera changes, and segments from live.json.
export async function writeThumbnailsPage(sessionDir, thumbnails, { live = false } = {}) {
  // Camera and slide changes found by extract-thumbnails (thumbnails/scenes.json), if any.
  const sceneIndex = await loadJson(path.join(sessionDir, 'thumbnails', 'scenes.json'), null);
  const scenes = (sceneIndex?.scenes || []).map((scene) => [scene.positionSeconds, scene.fileName]);
  const session = await loadSessionSegments(sessionDir);
  const maxDuration = Math.ceil(Math.max(1, ...session.retained.map((item) => item.durationSeconds)));
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-PLAYLIST-TYPE:${live ? 'EVENT' : 'VOD'}`,
    `#EXT-X-TARGETDURATION:${maxDuration}`,
    '#EXT-X-MEDIA-SEQUENCE:0'
  ];
  session.retained.forEach((item, index) => {
    // A missed or discarded moment breaks the stream's timestamps, which players need flagged (as does each
    // switch between the live capture and the archive in a meeting built by build-meeting).
    if (index > 0 && (item.sequence !== session.retained[index - 1].sequence + 1 || item.discontinuity)) {
      lines.push('#EXT-X-DISCONTINUITY');
    }
    lines.push(`#EXTINF:${item.durationSeconds.toFixed(3)},`, `segments/${encodeURIComponent(item.fileName)}`);
  });
  if (!live) {
    lines.push('#EXT-X-ENDLIST');
  }
  await writeFileAtomically(path.join(sessionDir, 'playback.m3u8'), `${lines.join('\n')}\n`);

  const segments = session.retained.map((item) => [
    Number(item.audioStart.toFixed(3)),
    Number(item.videoStart.toFixed(3)),
    item.durationSeconds
  ]);
  // When each stretch's position zero aired, in milliseconds: [[start position, ms], ...].
  const clocks = session.clockRuns
    .filter((run) => run.zero !== null)
    .map((run) => [Number(run.start.toFixed(3)), Math.round(run.zero * 1000)]);
  await writeFileAtomically(
    path.join(sessionDir, 'thumbnails', 'live.json'),
    JSON.stringify({
      live,
      updatedAt: new Date().toISOString(),
      thumbs: pageThumbs(thumbnails),
      segments,
      scenes,
      clocks
    })
  );
  // The final transcript, built into the page; served pages also load the latest one at runtime.
  const transcript = await loadJson(path.join(sessionDir, 'transcripts', 'latest.json'), null);
  const transcriptLines = (transcript?.lines || []).map((line) => [
    Number(Number(line.startSeconds).toFixed(2)),
    Number(Number(line.endSeconds).toFixed(2)),
    line.text,
    line.retranscribed ? 1 : 0
  ]);
  // Speaker marks for this session, and the roster of people (shared by every meeting from the source).
  const peopleDir = findPeopleDir(sessionDir);
  const speakers = await loadJson(path.join(sessionDir, 'speakers.json'), null);
  const meetingInfo = await loadJson(path.join(sessionDir, 'meeting-info.json'), null);
  const agenda = await loadJson(path.join(sessionDir, 'agenda.json'), null);
  const votes = await loadJson(path.join(sessionDir, 'votes.json'), null);
  const views = await loadJson(path.join(sessionDir, 'views.json'), null);
  const audioBoosts = await loadJson(path.join(sessionDir, 'audio-boosts.json'), null);
  const roster = await loadJson(path.join(peopleDir, 'people.json'), null);
  const peopleUrl = path
    .relative(path.join(sessionDir, 'thumbnails'), peopleDir)
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');
  // A session that is part of a full meeting links to it; a full meeting describes where its video comes from.
  const fullMeeting = await loadJson(path.join(sessionDir, 'full-meeting.json'), null);
  const fullMeetingUrl = fullMeeting?.meetingDir
    ? path
        .relative(path.join(sessionDir, 'thumbnails'), path.join(fullMeeting.meetingDir, 'thumbnails', 'index.html'))
        .split(path.sep)
        .map(encodeURIComponent)
        .join('/')
    : '';
  await writeFile(
    path.join(sessionDir, 'thumbnails', 'index.html'),
    renderScrubber(thumbnails, sessionDir, {
      segments,
      serverUrl: findServerUrl(sessionDir),
      transcriptLines,
      scenes,
      clocks,
      live,
      turns: speakers?.turns || [],
      people: roster?.people || [],
      peopleGroups: roster?.groups || null,
      peopleUrl,
      fullMeetingUrl,
      boosts: audioBoosts?.boosts || [],
      meetingName: meetingInfo?.name || '',
      agenda: agenda?.items || [],
      votes: {
        members: votes?.members || [],
        votes: votes?.votes || [],
        seats: votes?.seats ?? null,
        needed: votes?.needed ?? null
      },
      views: { views: views?.views || [], sceneViews: views?.sceneViews || {} }
    })
  );
}

function findSource(sessionDir) {
  return SOURCES.find((item) => !path.relative(item.storageDir, sessionDir).startsWith('..'));
}

// {source storage}/people: names, roles, and face crops of the people who speak at its meetings.
export function findPeopleDir(sessionDir) {
  const source = findSource(sessionDir);
  return source ? path.join(source.storageDir, 'people') : path.join(sessionDir, 'people');
}

// The same page on the streamscribe server (`npm start`), where the player can load the segments (browsers block that on file://).
function findServerUrl(sessionDir) {
  const source = findSource(sessionDir);
  if (!source) {
    return '';
  }
  const slug = String(source.key)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const relative = path.relative(source.storageDir, sessionDir).split(path.sep).map(encodeURIComponent).join('/');
  return `http://127.0.0.1:${serverPort}/files/${slug}/${relative}/thumbnails/index.html`;
}

const escapeText = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The thumbnails page: a player (with the slider as its scrubber), a grid at a chosen density, and a clip builder.
// Move to a moment (play, drag the slider, or click a thumbnail), press "Clip start", move again, press "Clip end",
// and the `npm run extract-clip` command for that range appears, ready to copy.
export function renderScrubber(
  thumbnails,
  sessionDir = '',
  playback = { segments: [], serverUrl: '', transcriptLines: [] }
) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const sessionArg = sessionDir ? path.relative(repoRoot, sessionDir) || '.' : '<session folder>';
  // Clock time for any position: from the session's clock origins, or else the first thumbnail's clock time minus
  // its position.
  const anchor = thumbnails.find((item) => item.clockTime);
  const clocks = playback.clocks?.length
    ? playback.clocks
    : anchor
      ? [[0, Date.parse(anchor.clockTime) - anchor.positionSeconds * 1000]]
      : [];
  const data = JSON.stringify({
    thumbs: pageThumbs(thumbnails),
    live: Boolean(playback.live),
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
${STYLES}</style>
${renderMarkup(playback, escapeText)}<script>
  const page = ${data};
${CLIENT}</script>
</body>
</html>
`;
}
