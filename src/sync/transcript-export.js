// A meeting's transcript as a file to download (the website's meeting page), in one of three formats, the same as the
// review page's (src/review-page/client/transcript-formats.js):
//   simple    who said what, a paragraph per speaker (and after a long pause), with the time as each minute begins;
//             for the whole meeting, each chapter's heading where it starts; motions, seconds, and votes in place
//   words     word for word: each word with its time, speakers named where they change, chapters and votes in place
//   captions  closed captions (SubRip .srt, which YouTube takes), timed from the start of what's downloaded: at most
//             two lines of about 42 characters and 6 seconds a caption, a new one at each speaker change and pause
// Pure: the page hands it the words (corrections applied, speakers named) and what happened; nothing here reads the
// hub. Times are in seconds of the part's recording; a meeting of several parts is told part by part.
//   parts     [{ name, index, words: [{ at, end, text, speakers: [names], clock: ms since the epoch | null }] }]
//   chapters  [{ part, at, title }]
//   votes     [{ part, at, motion, movedBy: { name, at } | null, secondedBy: { name, at } | null, result: text }]
//   range     null (the whole meeting), or { part, from, to, title } (a chapter)
//   stamps    simple transcripts' times: 'video' (the recording's time), 'clock' (the time of day), or 'both'
export const FORMATS = {
  simple: 'Simple transcript (.txt)',
  words: 'Word for word (.txt)',
  captions: 'Closed captions (.srt)'
};
export const STAMPS = { both: 'Recording time and time of day', video: 'Recording time', clock: 'Time of day' };
const PARAGRAPH_PAUSE = 2.5;

// h:mm:ss (and tenths for word-for-word).
export function videoTime(seconds, tenths = false) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const secs = total % 60;
  const shownSecs = tenths ? secs.toFixed(1).padStart(4, '0') : String(Math.floor(secs)).padStart(2, '0');
  return `${hours}:${String(minutes).padStart(2, '0')}:${shownSecs}`;
}
const srtTime = (seconds) => {
  const millis = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(Math.floor(millis / 3600000))}:${pad(Math.floor(millis / 60000) % 60)}:${pad(Math.floor(millis / 1000) % 60)},${pad(millis % 1000, 3)}`;
};

// The vote's outcome from its results (who voted which way): "Passed 5–0", with abstentions and absences.
export function voteResult(vote) {
  const counts = { for: 0, against: 0, abstain: 0, absent: 0 };
  for (const choice of Object.values(vote.results || {})) if (choice in counts) counts[choice] += 1;
  if (!Object.values(counts).some(Boolean)) return '';
  const passed = vote.outcome === 'passed' || (vote.outcome !== 'failed' && counts.for > counts.against);
  const extras = [
    counts.abstain ? `${counts.abstain} abstained` : '',
    counts.absent ? `${counts.absent} absent` : ''
  ].filter(Boolean);
  return `${passed ? 'Passed' : 'Failed'} ${counts.for}–${counts.against}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

// What happens besides speech in a part, in order: chapter starts (when wanted), motions, seconds, and votes.
function events(part, chapters, votes, withChapters) {
  const list = [];
  if (withChapters)
    for (const chapter of chapters) if (chapter.part === part) list.push({ at: chapter.at, chapter: chapter.title });
  for (const vote of votes) {
    if (vote.part !== part) continue;
    if (vote.movedBy?.at != null)
      list.push({
        at: vote.movedBy.at,
        text: `✋ Motion by ${vote.movedBy.name}${vote.motion ? `: ${vote.motion}` : ''}`
      });
    if (vote.secondedBy?.at != null)
      list.push({ at: vote.secondedBy.at, text: `✋ Seconded by ${vote.secondedBy.name}` });
    list.push({ at: vote.at, text: `🗳 Vote: ${vote.motion || 'Motion'}${vote.result ? ` — ${vote.result}` : ''}` });
  }
  return list.sort((a, b) => a.at - b.at);
}

const label = (speakers) => (speakers?.length ? speakers.join(' & ') : 'Unknown speaker');

function simpleLines(part, words, happenings, inRange, { stamps, timeZone }) {
  const out = [];
  const add = (text) => {
    if (text || out[out.length - 1]) out.push(text);
  };
  const clockFormat = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
  const stampOf = (word) => {
    const clockText = word.clock != null ? clockFormat.format(new Date(word.clock)) : '';
    if (stamps === 'video' || !clockText) return `[${videoTime(word.at)}]`;
    return `[${stamps === 'clock' ? clockText : `${videoTime(word.at)} · ${clockText}`}]`;
  };
  // Chapter headings go before a minute's time; motions and votes after it, beside what was said.
  const headings = happenings.filter((event) => event.chapter);
  const others = happenings.filter((event) => !event.chapter);
  let nextHeading = 0;
  let nextOther = 0;
  let line = null;
  let lastMinute = null;
  let lastEnd = null;
  const close = () => {
    if (line?.words.length) out.push(`${line.label}: ${line.words.join(' ')}`);
    line = null;
  };
  const othersUntil = (seconds) => {
    while (nextOther < others.length && others[nextOther].at <= seconds) {
      const event = others[nextOther++];
      if (!inRange(event.at)) continue;
      close();
      out.push(event.text);
    }
  };
  const headingsUntil = (seconds) => {
    while (nextHeading < headings.length && headings[nextHeading].at <= seconds) {
      const event = headings[nextHeading++];
      if (!inRange(event.at)) continue;
      // (What happened before it, a vote after the last word, say, stays in the chapter before.)
      othersUntil(event.at - 0.001);
      close();
      add('');
      add(`== ${event.chapter} ==`);
      add('');
      lastMinute = null;
    }
  };
  for (const word of words) {
    if (!inRange(word.at)) continue;
    headingsUntil(word.at);
    const minute = word.clock == null || stamps === 'video' ? Math.floor(word.at / 60) : Math.floor(word.clock / 60000);
    if (minute !== lastMinute) {
      close();
      add('');
      out.push(stampOf(word));
      lastMinute = minute;
    }
    othersUntil(word.at);
    const who = label(word.speakers);
    if (!line || line.label !== who || (lastEnd !== null && word.at - lastEnd >= PARAGRAPH_PAUSE)) {
      close();
      line = { label: who, words: [] };
    }
    line.words.push(word.text);
    lastEnd = word.end;
  }
  headingsUntil(Infinity);
  othersUntil(Infinity);
  close();
  return out;
}

function wordLines(part, words, happenings, inRange) {
  const out = [];
  const add = (text) => {
    if (text || out[out.length - 1]) out.push(text);
  };
  let next = 0;
  let lastLabel = null;
  const until = (seconds) => {
    while (next < happenings.length && happenings[next].at <= seconds) {
      const event = happenings[next++];
      if (!inRange(event.at)) continue;
      if (event.chapter) {
        add('');
        out.push(`[${videoTime(event.at, true)}]  == ${event.chapter} ==`);
        add('');
        lastLabel = null;
      } else out.push(`[${videoTime(event.at, true)}]  ${event.text}`);
    }
  };
  for (const word of words) {
    if (!inRange(word.at)) continue;
    until(word.at);
    const who = label(word.speakers);
    if (who !== lastLabel) {
      out.push(`[${videoTime(word.at, true)}]  >> ${who}`);
      lastLabel = who;
    }
    out.push(`[${videoTime(word.at, true)}]  ${word.text}`);
  }
  until(Infinity);
  return out;
}

function captionCues(words, from) {
  const cues = [];
  let cue = null;
  let lastKey = null;
  const close = () => {
    if (cue) cues.push(cue);
    cue = null;
  };
  for (const word of words) {
    const key = (word.speakers || []).join(',');
    const changed = key !== lastKey;
    if (
      !cue ||
      changed ||
      word.at - cue.lastEnd >= 1 ||
      `${cue.text} ${word.text}`.length > 84 ||
      word.end - cue.firstAt > 6
    ) {
      close();
      const name = changed && word.speakers?.length ? `${word.speakers.join(' & ')}: ` : '';
      cue = {
        firstAt: word.at,
        from: word.at - from,
        end: word.end - from,
        lastEnd: word.end,
        text: `${name}${word.text}`
      };
    } else {
      cue.text += ` ${word.text}`;
      cue.end = word.end - from;
      cue.lastEnd = word.end;
    }
    lastKey = key;
  }
  close();
  // Two lines of about 42 characters.
  const wrap = (text) => {
    if (text.length <= 42) return text;
    const cut = text.lastIndexOf(' ', Math.min(text.length - 1, Math.ceil(text.length / 2) + 6));
    return cut > 0 ? `${text.slice(0, cut)}\n${text.slice(cut + 1)}` : text;
  };
  return cues
    .map(
      (item, index) =>
        `${index + 1}\n${srtTime(item.from)} --> ${srtTime(Math.max(item.end, item.from + 0.5))}\n${wrap(item.text)}`
    )
    .join('\n\n');
}

// The file: { name, text, type }.
/**
 * @param {{
 *   title?: string, format?: string, stamps?: string, timeZone?: string,
 *   parts?: { name: string, index: number, words: any[] }[],
 *   chapters?: { part: string, at: number, title: string }[],
 *   votes?: any[],
 *   range?: { part: string, from: number, to: number, title: string } | null
 * }} options
 */
export function exportTranscript({
  title = 'Meeting',
  format = 'simple',
  parts = [],
  chapters = [],
  votes = [],
  range = null,
  stamps = 'both',
  timeZone
}) {
  const chosen = range ? parts.filter((part) => part.name === range.part) : parts;
  const inRangeOf = (part) => (seconds) =>
    !range || (part.name === range.part && seconds >= range.from - 0.01 && seconds < range.to);
  const base = `${title}${range ? ` - ${range.title}` : ''}`;
  const name = (extension) =>
    `${base}${format === 'words' ? ' - word for word' : ''}.${extension}`
      .replace(/[^a-zA-Z0-9 ,.()&'-]+/g, '')
      .replace(/ +/g, ' ')
      .trim();
  if (format === 'captions') {
    const part = chosen[0];
    const words = part ? part.words.filter((word) => inRangeOf(part)(word.at)) : [];
    return {
      name: name('srt'),
      text: `${captionCues(words, range ? range.from : 0)}\n`,
      type: 'application/x-subrip;charset=utf-8'
    };
  }
  const out = [title];
  if (range) out.push(`Chapter: ${range.title}`);
  if (format === 'words') out.push('Word for word, with the time of each word');
  out.push('');
  for (const part of chosen) {
    if (chosen.length > 1) out.push('', `==== Part ${part.index + 1} ====`, '');
    const happenings = events(part.name, chapters, votes, !range);
    const inRange = inRangeOf(part);
    out.push(
      ...(format === 'words'
        ? wordLines(part.name, part.words, happenings, inRange)
        : simpleLines(part.name, part.words, happenings, inRange, { stamps, timeZone }))
    );
  }
  return {
    name: name('txt'),
    text: `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`,
    type: 'text/plain;charset=utf-8'
  };
}
