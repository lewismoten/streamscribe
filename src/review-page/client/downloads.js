// Transcript downloads, in the format chosen in 🎛 (remembered): a simple transcript (who said what, with the time as
// each minute begins), word for word (each word with its video time), or closed captions (.srt). Every download
// button (whole meeting, a chapter, the playlist) uses it. Corrections are applied. The formats themselves are made in
// transcript-formats.js.
const TRANSCRIPT_FORMATS = {
  simple: 'Simple transcript (.txt)',
  words: 'Word for word (.txt)',
  captions: 'Closed captions (.srt)'
};
let transcriptFormat = 'simple';
try {
  transcriptFormat = Object.keys(TRANSCRIPT_FORMATS).includes(localStorage.getItem('thumbnails.transcriptFormat'))
    ? localStorage.getItem('thumbnails.transcriptFormat')
    : 'simple';
} catch {}
// Times in simple transcripts: the video time, the date and time of day, or both (also chosen in 🎛, remembered).
const STAMP_STYLES = { both: 'Video time and date/time', video: 'Video time', clock: 'Date and time' };
let stampStyle = 'both';
try {
  stampStyle = Object.keys(STAMP_STYLES).includes(localStorage.getItem('thumbnails.stampStyle'))
    ? localStorage.getItem('thumbnails.stampStyle')
    : 'both';
} catch {}
const stampFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: page.timeZone,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
});
const stampAt = (seconds) => {
  const clock = clockMs(seconds) === null ? '' : stampFormat.format(new Date(clockMs(seconds)));
  if (stampStyle === 'video' || !clock) return '[' + fmt(seconds) + ']';
  return '[' + (stampStyle === 'clock' ? clock : fmt(seconds) + ' · ' + clock) + ']';
};
function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name
    .replace(/[^a-zA-Z0-9 ,.()-]+/g, '')
    .trim()
    .replace(/ +/g, ' ');
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}
function chapterRange(item) {
  const next = agendaItems[agendaItems.indexOf(item) + 1];
  return { title: item.title, from: item.at, to: next ? next.at : endSeconds };
}
// Downloads a transcript of the whole meeting (ranges null), one chapter, or the playlist's clips, in the chosen format.
function downloadAs(ranges, kind) {
  const NL = String.fromCharCode(10);
  const name =
    (meetingName || 'transcript') +
    (kind === 'chapter' ? ' - ' + ranges[0].title : kind === 'playlist' ? ' - playlist' : '');
  if (transcriptFormat === 'captions') {
    // Timed from the start of what's downloaded: the meeting, the chapter, or the playlist video.
    downloadFile(
      name + '.srt',
      captionsFor(ranges || [{ from: 0, to: endSeconds }]),
      'application/x-subrip;charset=utf-8'
    );
    return;
  }
  const words = transcriptFormat === 'words';
  const linesFor = (range, withChapters) =>
    words ? wordLines(range, withChapters) : transcriptLines(range, withChapters);
  const lines = [meetingName || document.title || 'Meeting'];
  if (kind === 'chapter') lines.push('Chapter: ' + ranges[0].title);
  if (kind === 'playlist')
    lines.push(
      'Playlist: ' + ranges.length + ' clips, ' + fmt(ranges.reduce((sum, range) => sum + (range.to - range.from), 0))
    );
  if (words) lines.push('Word for word, with the video time of each word');
  lines.push('');
  if (kind === 'playlist') {
    ranges.forEach((range, index) => {
      lines.push(
        '== Clip ' + (index + 1) + ': ' + range.title + ' (' + fmt(range.from) + '–' + fmt(range.to) + ') ==',
        ''
      );
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
Object.entries(TRANSCRIPT_FORMATS).forEach(([value, label]) => {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  $('download-format').appendChild(option);
});
Object.entries(STAMP_STYLES).forEach(([value, label]) => {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  $('download-times').appendChild(option);
});
$('download-format').addEventListener('change', () => {
  transcriptFormat = $('download-format').value;
  try {
    localStorage.setItem('thumbnails.transcriptFormat', transcriptFormat);
  } catch {}
  showDownloadSettings();
});
$('download-times').addEventListener('change', () => {
  stampStyle = $('download-times').value;
  try {
    localStorage.setItem('thumbnails.stampStyle', stampStyle);
  } catch {}
});
showDownloadSettings();
// ⬇ beside the find box: the whole meeting, or the chapter being played.
const downloadMenu = document.createElement('div');
downloadMenu.className = 'download-menu';
downloadMenu.hidden = true;
document.body.appendChild(downloadMenu);
$('transcript-download').addEventListener('click', (event) => {
  event.stopPropagation();
  if (!downloadMenu.hidden) {
    downloadMenu.hidden = true;
    return;
  }
  downloadMenu.textContent = '';
  const head = document.createElement('div');
  head.className = 'picker-head';
  head.textContent = 'Download the transcript';
  downloadMenu.appendChild(head);
  const format = document.createElement('div');
  format.className = 'menu-row';
  format.textContent =
    TRANSCRIPT_FORMATS[transcriptFormat] +
    (transcriptFormat === 'simple' ? ', ' + STAMP_STYLES[stampStyle].toLowerCase() : '') +
    ' — change in 🎛';
  downloadMenu.appendChild(format);
  const option = (label, chapter) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.addEventListener('click', () => {
      downloadMenu.hidden = true;
      downloadTranscript(chapter);
    });
    downloadMenu.appendChild(button);
  };
  option('⬇ Whole meeting', null);
  const current = agendaIndexAt(position);
  if (current >= 0) option('⬇ This chapter: ' + agendaItems[current].title, chapterRange(agendaItems[current]));
  downloadMenu.hidden = false;
  const rect = $('transcript-download').getBoundingClientRect();
  downloadMenu.style.left =
    Math.max(8, Math.min(window.innerWidth - downloadMenu.offsetWidth - 8, rect.right - downloadMenu.offsetWidth)) +
    'px';
  downloadMenu.style.top = rect.bottom + 6 + 'px';
});
document.addEventListener('mousedown', (event) => {
  if (!downloadMenu.hidden && !downloadMenu.contains(event.target) && event.target !== $('transcript-download'))
    downloadMenu.hidden = true;
});
