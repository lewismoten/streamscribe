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

let hls = null;
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
    hls = new window.Hls({ startPosition: toPlayerTime(position) });
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
    + (onDisk ? 'Run <code>npm start</code> in the repository folder.' + link : 'Check that <code>npm start</code> is still running, then reload this page.');
  note.hidden = false;
}
if (location.protocol === 'file:') showFileNote(false);

$('display-open').addEventListener('click', () => { if ($('display-dialog').open) $('display-dialog').close(); else $('display-dialog').show(); });
