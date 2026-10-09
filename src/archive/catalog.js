import fs from 'fs';
import path from 'path';

// A catalog of past meetings on a drive of saved material (read only): what meetings there were, of which body, when,
// and what each has (video, audio, agenda, minutes, a transcript), from
//   Warren County VA/Swagit/<id>/      the county's archived videos (metadata.json: body, title, date)
//   WCBOS/<year>/<date> WCBOS ….mp4    Board of Supervisors videos saved by hand
//   WCFAC/<date> WCFAC….mp3            Finance and Audit Committee recordings (and transcripts beside them)
//   WCLB Minutes/*.pdf, <date> WCLB …/ the Warren County Library Board's minutes and a meeting's folder
//   Recordings/<recorder>/*.WAV        handheld recorders, named by when they started; matched to a meeting on the
//                                      same day (a committee's known meeting days), else listed as not known yet
// Writes the catalog as JSON (--out, default <root>/streamscribe/catalog.json) and a readable summary (--report).
//   npm run catalog-archive -- --root /Volumes/backup-plus [--out <file>] [--report <file>]
const BODIES = {
  bos: 'Board of Supervisors',
  work: 'Board of Supervisors Work Session',
  planning: 'Planning Commission',
  wcfac: 'Finance and Audit Committee',
  wclb: 'Warren County Library Board'
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (value) => String(value).padStart(2, '0');
const list = (folder) => {
  try {
    return fs.readdirSync(folder, { withFileTypes: true });
  } catch {
    return [];
  }
};
const exists = (file) => fs.existsSync(file);
const size = (file) => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

// "Feb 16, 2021" → 2021-02-16.
function isoDate(text) {
  const match = String(text || '').match(/([A-Za-z]{3})[a-z]* (\d{1,2}), (\d{4})/);
  if (!match) return null;
  return `${match[3]}-${pad(MONTHS.indexOf(match[1].toLowerCase()) + 1)}-${pad(match[2])}`;
}

function swagit(root) {
  const folder = path.join(root, 'Warren County VA', 'Swagit');
  const meetings = [];
  for (const entry of list(folder)) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const dir = path.join(folder, entry.name);
    let meta = null;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, 'metadata.json'), 'utf8'));
    } catch {
      continue;
    }
    const category = String(meta.category || '');
    const body = /work session/i.test(category)
      ? BODIES.work
      : /planning/i.test(category)
        ? BODIES.planning
        : /supervisors/i.test(category)
          ? BODIES.bos
          : category || 'Unknown';
    meetings.push({
      date: isoDate(meta.meetingDate),
      body,
      title: meta.title || category,
      source: 'swagit',
      id: `swagit-${entry.name}`,
      swagitId: Number(entry.name),
      url: meta.pageUrl || null,
      duration: meta.duration || null,
      files: {
        video: exists(path.join(dir, 'video.mp4')) ? path.join(dir, 'video.mp4') : null,
        agenda: exists(path.join(dir, 'agenda.pdf')) ? path.join(dir, 'agenda.pdf') : null,
        transcript: exists(path.join(dir, 'transcript-words.json'))
          ? path.join(dir, 'transcript-words.json')
          : exists(path.join(dir, 'transcript.txt'))
            ? path.join(dir, 'transcript.txt')
            : null
      },
      bytes: size(path.join(dir, 'video.mp4'))
    });
  }
  return meetings;
}

function wcbos(root) {
  const meetings = [];
  for (const year of list(path.join(root, 'WCBOS'))) {
    if (!year.isDirectory()) continue;
    for (const file of list(path.join(root, 'WCBOS', year.name))) {
      const match = file.name.match(/^(\d{4}-\d{2}-\d{2}) WCBOS ?(.*)\.mp4$/i);
      if (!match) continue;
      const full = path.join(root, 'WCBOS', year.name, file.name);
      meetings.push({
        date: match[1],
        body: /work session/i.test(match[2]) ? BODIES.work : BODIES.bos,
        title: match[2].trim() || 'Board of Supervisors Meeting',
        source: 'wcbos',
        id: `wcbos-${match[1]}-${
          match[2]
            .replace(/[^A-Za-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase() || 'meeting'
        }`,
        files: { video: full },
        bytes: size(full)
      });
    }
  }
  return meetings;
}

function wcfac(root) {
  const byDate = new Map();
  for (const file of list(path.join(root, 'WCFAC'))) {
    const match = file.name.match(/^(\d{4}-\d{2}-\d{2}) WCFAC/);
    if (!match) continue;
    const full = path.join(root, 'WCFAC', file.name);
    const meeting = byDate.get(match[1]) || {
      date: match[1],
      body: BODIES.wcfac,
      title: 'Finance and Audit Committee',
      source: 'wcfac',
      id: `wcfac-${match[1]}`,
      files: { audio: [], transcript: [] },
      bytes: 0
    };
    if (/\.mp3$/i.test(file.name)) {
      meeting.files.audio.push(full);
      meeting.bytes += size(full);
    } else if (/\.txt$/i.test(file.name)) meeting.files.transcript.push(full);
    byDate.set(match[1], meeting);
  }
  return [...byDate.values()];
}

function wclb(root) {
  const meetings = new Map();
  // Minutes: "WCLB Feb 19 Minutes_2025060208…pdf" (the year from when they were saved).
  for (const file of list(path.join(root, 'WCLB Minutes'))) {
    const match = file.name.match(/^WCLB ([A-Za-z]+) (\d{1,2}) Minutes_(\d{4})/);
    if (!match) continue;
    const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
    if (!month) continue;
    const date = `${match[3]}-${pad(month)}-${pad(match[2])}`;
    meetings.set(date, {
      date,
      body: BODIES.wclb,
      title: 'Library Board',
      source: 'wclb',
      id: `wclb-${date}`,
      files: { minutes: path.join(root, 'WCLB Minutes', file.name), audio: [] },
      bytes: 0
    });
  }
  // A meeting's own folder: "<date> WCLB Meeting …".
  for (const entry of list(root)) {
    const match = entry.isDirectory() && entry.name.match(/^(\d{4}-\d{2}-\d{2}) WCLB/);
    if (!match) continue;
    const dir = path.join(root, entry.name);
    const meeting = meetings.get(match[1]) || {
      date: match[1],
      body: BODIES.wclb,
      title: 'Library Board',
      source: 'wclb',
      id: `wclb-${match[1]}`,
      files: { audio: [] },
      bytes: 0
    };
    for (const file of list(dir))
      if (/\.(mp3|wav|m4a)$/i.test(file.name)) {
        meeting.files.audio.push(path.join(dir, file.name));
        meeting.bytes += size(path.join(dir, file.name));
      } else if (/agenda.*\.pdf$/i.test(file.name)) meeting.files.agenda = path.join(dir, file.name);
      else if (/notes.*\.pdf$/i.test(file.name)) meeting.files.notes = path.join(dir, file.name);
    meeting.folder = dir;
    meetings.set(match[1], meeting);
  }
  return [...meetings.values()];
}

// Handheld recorders: Q70 names files 20250603212305.WAV, the V15 R20250603-212011.WAV (when recording started, by
// the recorder's clock).
function recordings(root, known) {
  const found = [];
  const folder = path.join(root, 'Recordings');
  for (const recorder of list(folder)) {
    if (!recorder.isDirectory()) continue;
    for (const file of list(path.join(folder, recorder.name))) {
      const match = file.name.match(/^R?(\d{4})(\d{2})(\d{2})-?(\d{2})(\d{2})(\d{2})\.(wav|mp3|wma)$/i);
      if (!match) continue;
      const date = `${match[1]}-${match[2]}-${match[3]}`;
      const full = path.join(folder, recorder.name, file.name);
      // The same day as a committee's known meeting: that meeting.
      const same = known.filter((meeting) => meeting.date === date && /Finance|Library/.test(meeting.body));
      found.push({
        date,
        startedAt: `${date}T${match[4]}:${match[5]}:${match[6]}`,
        recorder: recorder.name,
        file: full,
        bytes: size(full),
        meeting: same.length === 1 ? same[0].id : null,
        guess: same.length === 1 ? same[0].body : same.length > 1 ? 'more than one meeting that day' : null
      });
    }
  }
  return found;
}

export function catalog(root) {
  const meetings = [...swagit(root), ...wcbos(root), ...wcfac(root), ...wclb(root)];
  const recorded = recordings(root, meetings);
  // Recordings matched to a meeting go with it; the rest are listed as not known yet.
  for (const item of recorded) {
    const meeting = meetings.find((entry) => entry.id === item.meeting);
    if (meeting) (meeting.files.recordings ||= []).push(item.file);
  }
  // The same meeting saved twice (a Swagit video and one saved by hand on the same day, same body): noted.
  for (const meeting of meetings.filter((entry) => entry.source === 'wcbos')) {
    const twin = meetings.find(
      (entry) => entry.source === 'swagit' && entry.date === meeting.date && entry.body === meeting.body
    );
    if (twin) meeting.sameAs = twin.id;
  }
  meetings.sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.body.localeCompare(b.body));
  return {
    root,
    catalogedAt: new Date().toISOString(),
    meetings,
    unmatchedRecordings: recorded.filter((item) => !item.meeting)
  };
}

export function report(result) {
  const lines = [`# Past meetings on ${result.root}`, '', `Cataloged ${result.catalogedAt.slice(0, 10)}.`, ''];
  const byBody = new Map();
  for (const meeting of result.meetings) byBody.set(meeting.body, [...(byBody.get(meeting.body) || []), meeting]);
  lines.push('| Body | Meetings | Years | With video | With audio | GB |', '| --- | --- | --- | --- | --- | --- |');
  for (const [body, items] of byBody) {
    const years = items.map((item) => item.date?.slice(0, 4)).filter(Boolean);
    lines.push(
      `| ${body} | ${items.length} | ${Math.min(...years)}–${Math.max(...years)} | ${items.filter((item) => item.files.video).length} | ${items.filter((item) => item.files.audio?.length || item.files.recordings?.length).length} | ${(items.reduce((sum, item) => sum + (item.bytes || 0), 0) / 1e9).toFixed(1)} |`
    );
  }
  lines.push('', '## Saved twice', '');
  const twins = result.meetings.filter((item) => item.sameAs);
  lines.push(
    twins.length ? twins.map((item) => `- ${item.date} ${item.body}: ${item.id} = ${item.sameAs}`).join('\n') : 'None.'
  );
  lines.push('', '## Committee meetings and their recordings', '');
  for (const meeting of result.meetings.filter((item) => item.source === 'wcfac' || item.source === 'wclb'))
    lines.push(
      `- ${meeting.date} ${meeting.body}: ${
        [
          meeting.files.minutes ? 'minutes' : '',
          meeting.files.agenda ? 'agenda' : '',
          meeting.files.audio?.length ? `${meeting.files.audio.length} audio` : '',
          meeting.files.transcript?.length ? 'transcript' : '',
          meeting.files.recordings?.length ? `${meeting.files.recordings.length} recorder files` : ''
        ]
          .filter(Boolean)
          .join(', ') || 'nothing but the date'
      }`
    );
  lines.push('', '## Recordings not matched to a meeting yet', '');
  lines.push(
    result.unmatchedRecordings.length
      ? result.unmatchedRecordings
          .map(
            (item) =>
              `- ${item.startedAt.replace('T', ' ')} (${item.recorder}): ${path.basename(item.file)}, ${(item.bytes / 1e6).toFixed(0)} MB`
          )
          .join('\n')
      : 'None.'
  );
  return `${lines.join('\n')}\n`;
}

export const run = () => {
  const argv = process.argv.slice(2);
  const value = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
  const root = value('--root');
  if (!root) {
    console.error('Expected --root <drive or folder>');
    process.exit(1);
  }
  const result = catalog(root);
  const out = value('--out') || path.join(root, 'streamscribe', 'catalog.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  const text = report(result);
  if (value('--report')) fs.writeFileSync(value('--report'), text);
  console.log(text);
  console.log(`Catalog: ${out}`);
};
