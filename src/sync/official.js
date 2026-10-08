// The official sources of a meeting, kept with it so this independent archive can point to them: the official
// recording (Swagit), the meeting's documents (CivicClerk: overview, agenda, packet, and files per agenda item), and
// its calendar entry (CivicPlus). Stored as
//   { swagit: { base, videoId, offset?, timeline? }, civicclerk: { base, eventId, agendaFileId?, packetFileId? },
//     calendarUrl?, links?: [{ label, url }] }
// and turned into links here (web app, agents, publishing). Paste any official address and parseOfficialUrl says
// what it is. Times: the official video's clock can differ from this archive's positions (a capture that starts
// earlier, material the archive lacks), so swagit.timeline holds matching points [position, official seconds] (from
// how build-meeting lined the capture up with the archive), or swagit.offset a fixed difference (official minus
// position); with neither, links don't claim a time.

const clean = (url) => String(url || '').trim();

// What an official address is: { swagit } | { civicclerk } (with the file it names, if any) | { calendarUrl } |
// { link }, or null when it isn't an address.
/** @param {string} text @returns {any} */
export function parseOfficialUrl(text) {
  let url;
  try { url = new URL(clean(text)); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const base = `${url.protocol}//${url.host}`;
  const swagit = url.hostname.endsWith('swagit.com') && url.pathname.match(/\/videos\/(\d+)/);
  if (swagit) return { swagit: { base, videoId: swagit[1] } };
  const clerk = url.hostname.endsWith('civicclerk.com') && url.pathname.match(/\/event\/(\d+)(?:\/files\/(agenda|attachment)\/(\d+))?/);
  if (clerk) return { civicclerk: { base, eventId: clerk[1] }, file: clerk[2] ? { type: clerk[2], id: clerk[3], url: url.href } : null };
  if (/calendar\.aspx/i.test(url.pathname) || url.searchParams.has('EID')) return { calendarUrl: url.href };
  return { link: url.href };
}

// The official video's time at this archive's position, or null when that isn't known.
/** @param {any} official @param {number} position @returns {number | null} */
export function officialTime(official, position) {
  const swagit = official?.swagit;
  if (!swagit || !Number.isFinite(position)) return null;
  const time = rawOfficialTime(swagit, position);
  return time === null ? null : Math.min(Math.max(0, time), swagit.duration || Infinity);
}

function rawOfficialTime(swagit, position) {
  const points = swagit.timeline || [];
  if (points.length) {
    let before = points[0];
    let after = points.at(-1);
    for (const point of points) {
      if (point[0] <= position) before = point;
      if (point[0] >= position) { after = point; break; }
    }
    if (position <= points[0][0]) return Math.max(0, points[0][1] - (points[0][0] - position));
    if (position >= after[0] && after === points.at(-1)) return after[1] + (position - after[0]);
    const span = after[0] - before[0];
    return span > 0 ? before[1] + ((position - before[0]) / span) * (after[1] - before[1]) : before[1];
  }
  return Number.isFinite(swagit.offset) ? position + swagit.offset : null;
}

const swagitVideo = (swagit) => `${swagit.base}/videos/${swagit.videoId}`;
/** @type {(official: any, position: number) => string | null} */
export const swagitAt = (official, position) => {
  const at = officialTime(official, position);
  return official?.swagit ? `${swagitVideo(official.swagit)}${at === null ? '' : `?ts=${Math.floor(at)}`}` : null;
};
/** @type {(swagit: { base: string, videoId: string }, options?: { autoplay?: boolean }) => string} */
export const embedCode = (swagit, { autoplay = false } = {}) =>
  `<iframe title="Swagit Video Player" width="640" height="360" src="${swagitVideo(swagit)}/embed${autoplay ? '' : '?autoplay=0'}" frameborder="0" allowfullscreen></iframe>`;

// Every link for a meeting, grouped: [{ group, label, url }]. With at (a position), the video link starts there.
/** @param {any} official @param {{ at?: number | null }} [options] @returns {{ group: string, label: string, url: string }[]} */
export function officialLinks(official, { at = null } = {}) {
  if (!official) return [];
  const links = [];
  const add = (group, label, url) => { if (url) links.push({ group, label, url }); };
  const swagit = official.swagit;
  if (swagit?.videoId) {
    const video = swagitVideo(swagit);
    add('Official video', at === null ? 'Watch' : `Watch from here${officialTime(official, at) === null ? ' (start of video)' : ''}`, at === null ? video : swagitAt(official, at));
    add('Official video', 'Download the video', `${video}/download`);
    add('Official video', 'Transcript, with the video', `${video}#transcript`);
    add('Official video', 'Download the transcript', `${video}/transcript`);
    add('Official video', 'Agenda, with the video', `${video}#full-agenda`);
  }
  const clerk = official.civicclerk;
  if (clerk?.eventId) {
    add('Documents', 'Meeting overview', `${clerk.base}/event/${clerk.eventId}/overview`);
    if (clerk.agendaFileId) add('Documents', 'Agenda', `${clerk.base}/event/${clerk.eventId}/files/agenda/${clerk.agendaFileId}`);
    if (clerk.packetFileId) add('Documents', 'Full agenda packet', `${clerk.base}/event/${clerk.eventId}/files/agenda/${clerk.packetFileId}`);
  }
  add('Calendar', 'Calendar entry', official.calendarUrl);
  for (const link of official.links || []) add('Other', link.label || link.url, link.url);
  return links;
}

// Merges an edit (meeting-info's) over what the recorder knew; fields set in the edit win.
/** @param {any} base @param {any} edit @returns {any} */
export function mergeOfficial(base, edit) {
  if (!base && !edit) return null;
  return {
    ...(base || {}), ...(edit || {}),
    swagit: edit?.swagit || base?.swagit ? { ...(base?.swagit || {}), ...(edit?.swagit || {}) } : undefined,
    civicclerk: edit?.civicclerk || base?.civicclerk ? { ...(base?.civicclerk || {}), ...(edit?.civicclerk || {}) } : undefined
  };
}

// The matching points between a built meeting's positions and the official archive's time, from build-meeting's
// meeting.json (where each stretch of the meeting came from) and the archive's alignment.json (where each capture
// lines up with it). Points from capture are kept only where the match was confident.
export function timelineFromAlignment(meeting, alignment) {
  const points = [];
  const sessions = new Map((alignment?.sessions || []).map((session) => [String(session.sessionDir).split('/').pop(), session]));
  for (const piece of meeting?.pieces || []) {
    if (piece.kind === 'archive') {
      points.push([piece.meetingStart, piece.archiveStart], [piece.meetingStart + piece.duration, piece.archiveEnd]);
    } else if (piece.kind === 'live') {
      const session = sessions.get(String(piece.session).split('/').pop());
      for (const anchor of session?.anchors || []) {
        if (anchor.archiveTime === null || anchor.score < 0.5 || anchor.videoStart < piece.liveStart || anchor.videoStart > piece.liveEnd) continue;
        points.push([piece.meetingStart + (anchor.videoStart - piece.liveStart), anchor.archiveTime]);
      }
    }
  }
  points.sort((left, right) => left[0] - right[0]);
  const kept = [];
  for (const point of points) if (!kept.length || (point[0] > kept.at(-1)[0] && point[1] >= kept.at(-1)[1])) kept.push(point.map((value) => Math.round(value * 10) / 10));
  return kept;
}
