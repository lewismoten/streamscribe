// Transcript downloads, in the format chosen in 🎛 (remembered): a simple transcript (who said what, with the time as
// each minute begins), word for word (each word with its video time), or closed captions (.srt). Every download
// button (whole meeting, a chapter, the playlist) uses it. Corrections are applied.
const TRANSCRIPT_FORMATS = { simple: 'Simple transcript (.txt)', words: 'Word for word (.txt)', captions: 'Closed captions (.srt)' };
let transcriptFormat = 'simple';
try { transcriptFormat = Object.keys(TRANSCRIPT_FORMATS).includes(localStorage.getItem('thumbnails.transcriptFormat')) ? localStorage.getItem('thumbnails.transcriptFormat') : 'simple'; } catch {}
// Times in simple transcripts: the video time, the date and time of day, or both (also chosen in 🎛, remembered).
const STAMP_STYLES = { both: 'Video time and date/time', video: 'Video time', clock: 'Date and time' };
let stampStyle = 'both';
try { stampStyle = Object.keys(STAMP_STYLES).includes(localStorage.getItem('thumbnails.stampStyle')) ? localStorage.getItem('thumbnails.stampStyle') : 'both'; } catch {}
const stampFormat = new Intl.DateTimeFormat('en-US', { timeZone: page.timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const stampAt = (seconds) => {
  const clock = clockMs(seconds) === null ? '' : stampFormat.format(new Date(clockMs(seconds)));
  if (stampStyle === 'video' || !clock) return '[' + fmt(seconds) + ']';
  return '[' + (stampStyle === 'clock' ? clock : fmt(seconds) + ' · ' + clock) + ']';
};
const speakerLabel = (ids) => (ids.length ? ids.map((id) => nameAndRole(peopleMap.get(id) || { id, name: id })).join(' & ') : 'Unknown speaker');
// What happens besides speech, in order: chapter starts (withChapters), motions, seconds, and each vote's result with
// how every member voted (where the roll call settled it).
function transcriptEvents(withChapters) {
  const personName = (id) => shownName(peopleMap.get(id) || { id, name: id });
  const events = [];
  if (withChapters) agendaItems.forEach((item) => events.push({ at: item.at, chapter: item.title }));
  voteData.votes.forEach((vote) => {
    if (vote.movedBy?.id && vote.movedBy.at !== null && vote.movedBy.at !== undefined) {
      events.push({ at: vote.movedBy.at, text: '✋ Motion by ' + personName(vote.movedBy.id) + (vote.motion ? ': ' + vote.motion : '') });
    }
    if (vote.secondedBy?.id && vote.secondedBy.at !== null && vote.secondedBy.at !== undefined) {
      events.push({ at: vote.secondedBy.at, text: '✋ Seconded by ' + personName(vote.secondedBy.id) });
    }
    const statuses = voteState(vote).statuses;
    const roll = ['for', 'against', 'abstain', 'absent', 'pending'].map((choice) => {
      const names = Object.keys(statuses).filter((id) => statuses[id] === choice).map(personName);
      return names.length ? choiceNames[choice] + ': ' + names.join(', ') : '';
    }).filter(Boolean).join('; ');
    // The result goes where the roll call settled it (or where the vote opened, if it never was).
    events.push({ at: decidedAt(vote) ?? vote.at, text: '🗳 Vote: ' + (vote.motion || 'Motion') + ' — ' + describeTally(vote) + (roll ? ' (' + roll + ')' : '') });
  });
  return events.sort((left, right) => left.at - right.at);
}
// The text lines for a stretch (null for everything); withChapters puts each chapter's heading where it starts.
function transcriptLines(chapter, withChapters) {
  const out = [];
  // One blank line at most between parts.
  const add = (text) => { if (text || out[out.length - 1]) out.push(text); };
  const inRange = (seconds) => !chapter || (seconds >= chapter.from - 0.01 && seconds < chapter.to);
  const events = transcriptEvents(withChapters);
  let eventIndex = 0;
  let line = null;
  let lastMinute = null;
  let lastEnd = null;
  const closeLine = () => {
    if (line && line.words.length) out.push(line.label + ': ' + line.words.join(' '));
    line = null;
  };
  const eventsUntil = (seconds) => {
    while (eventIndex < events.length && events[eventIndex].at <= seconds) {
      const event = events[eventIndex++];
      if (!inRange(event.at)) continue;
      closeLine();
      if (event.chapter) { add(''); add('== ' + event.chapter + ' =='); add(''); lastMinute = null; } else out.push(event.text);
    }
  };
  transcript.forEach(([startSeconds, endSeconds, text, , timedWords]) => {
    if (chapter && (endSeconds < chapter.from || startSeconds >= chapter.to)) return;
    lineWordList(startSeconds, endSeconds, text, timedWords).forEach((word) => {
      if (!inRange(word.at)) return;
      eventsUntil(word.at);
      const shown = word.edited ? word.display : word.text;
      if (!shown) return;
      // Each minute of the time of day (the stamps show it), or of the video when that isn't known.
      const minute = clockMs(word.at) === null || stampStyle === 'video' ? Math.floor(word.at / 60) : Math.floor(clockMs(word.at) / 60000);
      if (minute !== lastMinute) {
        closeLine();
        add('');
        out.push(stampAt(word.at));
        lastMinute = minute;
      }
      const label = speakerLabel(speakersAt(word.at + 0.01));
      if (!line || line.label !== label || (lastEnd !== null && word.at - lastEnd >= paragraphPauseSeconds)) {
        closeLine();
        line = { label, words: [] };
      }
      line.words.push(shown);
      lastEnd = word.end;
    });
  });
  eventsUntil(chapter ? chapter.to : Infinity);
  closeLine();
  return out;
}
// Every word said in a stretch, in order, as { at, end, text, ids } with corrections applied (deleted words left out).
function wordsIn(range) {
  const list = [];
  transcript.forEach(([startSeconds, endSeconds, text, , timedWords]) => {
    if (range && (endSeconds < range.from || startSeconds >= range.to)) return;
    lineWordList(startSeconds, endSeconds, text, timedWords).forEach((word) => {
      const shown = word.edited ? word.display : word.text;
      if (!shown || (range && (word.at < range.from - 0.01 || word.at >= range.to))) return;
      list.push({ at: word.at, end: range ? Math.min(word.end, range.to) : word.end, text: shown, ids: speakersAt(word.at + 0.01) });
    });
  });
  return list;
}
// Closed captions (SubRip .srt, which YouTube takes) for stretches of the video played one after another: each
// stretch's times start where the one before ended. A caption holds at most two lines of about 42 characters and
// 6 seconds, and a new one starts at each speaker change (named, as captions do) and pause.
function captionsFor(ranges) {
  const cues = [];
  let offset = 0;
  ranges.forEach((range) => {
    let cue = null;
    let lastIds = null;
    const close = () => { if (cue) cues.push(cue); cue = null; };
    wordsIn(range).forEach((word) => {
      const key = word.ids.join(',');
      const changed = key !== lastIds;
      // Pauses and lengths are measured in the meeting's own time; captions are timed to the playlist video.
      if (!cue || changed || word.at - cue.lastEnd >= 1 || (cue.text + ' ' + word.text).length > 84 || word.end - cue.firstAt > 6) {
        close();
        const label = changed && word.ids.length ? word.ids.map((id) => shownName(peopleMap.get(id) || { id, name: id })).join(' & ') + ': ' : '';
        cue = { from: word.at - range.from + offset, end: word.end - range.from + offset, text: label + word.text, firstAt: word.at, lastEnd: word.end };
      } else {
        cue.text += ' ' + word.text;
        cue.end = word.end - range.from + offset;
        cue.lastEnd = word.end;
      }
      lastIds = key;
    });
    close();
    offset += range.to - range.from;
  });
  const stamp = (seconds) => {
    const ms = Math.max(0, Math.round(seconds * 1000));
    const pad = (value, size) => String(value).padStart(size, '0');
    return pad(Math.floor(ms / 3600000), 2) + ':' + pad(Math.floor(ms / 60000) % 60, 2) + ':' + pad(Math.floor(ms / 1000) % 60, 2) + ',' + pad(ms % 1000, 3);
  };
  // Two lines, split near the middle at a space.
  const wrap = (text) => {
    if (text.length <= 42) return text;
    const middle = Math.floor(text.length / 2);
    const before = text.lastIndexOf(' ', middle);
    const after = text.indexOf(' ', middle);
    const at = before < 0 ? after : (after < 0 || middle - before <= after - middle ? before : after);
    return at < 0 ? text : text.slice(0, at) + String.fromCharCode(10) + text.slice(at + 1);
  };
  const NL = String.fromCharCode(10);
  return cues.map((cue, index) => {
    const next = cues[index + 1];
    const end = Math.max(cue.from + 0.8, Math.min(cue.end + 0.3, next ? next.from : cue.end + 0.3));
    return (index + 1) + NL + stamp(cue.from) + ' --> ' + stamp(next ? Math.min(end, next.from) : end) + NL + wrap(cue.text) + NL;
  }).join(NL);
}
function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name.replace(/[^a-zA-Z0-9 ,.()-]+/g, '').trim().replace(/ +/g, ' ');
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}
function chapterRange(item) {
  const next = agendaItems[agendaItems.indexOf(item) + 1];
  return { title: item.title, from: item.at, to: next ? next.at : endSeconds };
}
// Word for word: each word on its own line with its video time (00:02:16.420), a ">> Name, role" line where the
// speaker changes, chapter headings (withChapters), and motions, seconds, and votes where they happened.
const preciseStamp = (seconds) => fmt(seconds) + '.' + String(Math.round((Math.max(0, seconds) % 1) * 1000) % 1000).padStart(3, '0');
function wordLines(range, withChapters) {
  const out = [];
  const add = (text) => { if (text || out[out.length - 1]) out.push(text); };
  const inRange = (seconds) => !range || (seconds >= range.from - 0.01 && seconds < range.to);
  const events = transcriptEvents(withChapters);
  let eventIndex = 0;
  let lastLabel = null;
  const eventsUntil = (seconds) => {
    while (eventIndex < events.length && events[eventIndex].at <= seconds) {
      const event = events[eventIndex++];
      if (!inRange(event.at)) continue;
      if (event.chapter) { add(''); out.push(preciseStamp(event.at) + '  == ' + event.chapter + ' =='); add(''); lastLabel = null; } else out.push(preciseStamp(event.at) + '  ' + event.text);
    }
  };
  wordsIn(range).forEach((word) => {
    eventsUntil(word.at);
    const label = speakerLabel(word.ids);
    if (label !== lastLabel) { out.push(preciseStamp(word.at) + '  >> ' + label); lastLabel = label; }
    out.push(preciseStamp(word.at) + '  ' + word.text);
  });
  eventsUntil(range ? range.to : Infinity);
  return out;
}
// Downloads a transcript of the whole meeting (ranges null), one chapter, or the playlist's clips, in the chosen format.
function downloadAs(ranges, kind) {
  const NL = String.fromCharCode(10);
  const name = (meetingName || 'transcript') + (kind === 'chapter' ? ' - ' + ranges[0].title : kind === 'playlist' ? ' - playlist' : '');
  if (transcriptFormat === 'captions') {
    // Timed from the start of what's downloaded: the meeting, the chapter, or the playlist video.
    downloadFile(name + '.srt', captionsFor(ranges || [{ from: 0, to: endSeconds }]), 'application/x-subrip;charset=utf-8');
    return;
  }
  const words = transcriptFormat === 'words';
  const linesFor = (range, withChapters) => (words ? wordLines(range, withChapters) : transcriptLines(range, withChapters));
  const lines = [meetingName || document.title || 'Meeting'];
  if (kind === 'chapter') lines.push('Chapter: ' + ranges[0].title);
  if (kind === 'playlist') lines.push('Playlist: ' + ranges.length + ' clips, ' + fmt(ranges.reduce((sum, range) => sum + (range.to - range.from), 0)));
  if (words) lines.push('Word for word, with the video time of each word');
  lines.push('');
  if (kind === 'playlist') {
    ranges.forEach((range, index) => {
      lines.push('== Clip ' + (index + 1) + ': ' + range.title + ' (' + fmt(range.from) + '–' + fmt(range.to) + ') ==', '');
      lines.push(...linesFor(range, false), '');
    });
  } else {
    lines.push(...linesFor(ranges ? ranges[0] : null, kind === 'meeting'));
  }
  downloadFile(name + (words ? ' - word for word' : '') + '.txt', lines.join(NL) + NL, 'text/plain;charset=utf-8');
}
function downloadTranscript(chapter) {
  downloadAs(chapter ? [chapter] : null, chapter ? 'chapter' : 'meeting');
}
// The format and times settings in 🎛.
function showDownloadSettings() {
  $('download-format').value = transcriptFormat;
  $('download-times').value = stampStyle;
  $('download-times').disabled = transcriptFormat !== 'simple';
}
Object.entries(TRANSCRIPT_FORMATS).forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; $('download-format').appendChild(option); });
Object.entries(STAMP_STYLES).forEach(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; $('download-times').appendChild(option); });
$('download-format').addEventListener('change', () => {
  transcriptFormat = $('download-format').value;
  try { localStorage.setItem('thumbnails.transcriptFormat', transcriptFormat); } catch {}
  showDownloadSettings();
});
$('download-times').addEventListener('change', () => {
  stampStyle = $('download-times').value;
  try { localStorage.setItem('thumbnails.stampStyle', stampStyle); } catch {}
});
showDownloadSettings();
// ⬇ beside the find box: the whole meeting, or the chapter being played.
const downloadMenu = document.createElement('div');
downloadMenu.className = 'download-menu';
downloadMenu.hidden = true;
document.body.appendChild(downloadMenu);
$('transcript-download').addEventListener('click', (event) => {
  event.stopPropagation();
  if (!downloadMenu.hidden) { downloadMenu.hidden = true; return; }
  downloadMenu.textContent = '';
  const head = document.createElement('div');
  head.className = 'picker-head';
  head.textContent = 'Download the transcript';
  downloadMenu.appendChild(head);
  const format = document.createElement('div');
  format.className = 'menu-row';
  format.textContent = TRANSCRIPT_FORMATS[transcriptFormat] + (transcriptFormat === 'simple' ? ', ' + STAMP_STYLES[stampStyle].toLowerCase() : '') + ' — change in 🎛';
  downloadMenu.appendChild(format);
  const option = (label, chapter) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => { downloadMenu.hidden = true; downloadTranscript(chapter); });
    downloadMenu.appendChild(button);
  };
  option('⬇ Whole meeting', null);
  const current = agendaIndexAt(position);
  if (current >= 0) option('⬇ This chapter: ' + agendaItems[current].title, chapterRange(agendaItems[current]));
  downloadMenu.hidden = false;
  const rect = $('transcript-download').getBoundingClientRect();
  downloadMenu.style.left = Math.max(8, Math.min(window.innerWidth - downloadMenu.offsetWidth - 8, rect.right - downloadMenu.offsetWidth)) + 'px';
  downloadMenu.style.top = (rect.bottom + 6) + 'px';
});
document.addEventListener('mousedown', (event) => { if (!downloadMenu.hidden && !downloadMenu.contains(event.target) && event.target !== $('transcript-download')) downloadMenu.hidden = true; });

