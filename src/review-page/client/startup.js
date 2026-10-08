// The address bar keeps the position and clip range (?t=01:04:44.100&from=01:02:30&to=01:10:00), so a refresh,
// bookmark, or shared link reopens at the same spot. replaceState avoids filling the Back history.
let queryTimer = null;
let restoring = true;
function scheduleQueryUpdate() {
  if (restoring || queryTimer) return;
  queryTimer = setTimeout(
    () => {
      queryTimer = null;
      const params = new URLSearchParams(location.search);
      params.set('t', fmtPrecise(position));
      if (start !== null) params.set('from', fmtPrecise(start));
      else params.delete('from');
      if (end !== null) params.set('to', fmtPrecise(end));
      else params.delete('to');
      try {
        history.replaceState(
          null,
          '',
          location.pathname + '?' + params.toString().replace(/%3A/gi, ':') + location.hash
        );
      } catch {}
    },
    video.paused ? 250 : 1000
  );
}
video.addEventListener('pause', scheduleQueryUpdate);

// A session still being captured (extract-thumbnails --watch writes live.json as segments arrive): every few seconds
// the page picks up new thumbnails, camera changes, segments, and transcript lines, and the player keeps loading
// the open playlist, so everything captured so far can be played and scrubbed. Stops once the session is finished.
let liveRuns = 0;
function gridCount() {
  const maxLevel = Number($('density').value);
  return thumbs.filter((item) => item.l <= maxLevel).length;
}
function updateLiveEdge() {
  $('live-edge').hidden = !page.live;
  $('live-edge').title = 'Still being captured (' + fmt(endSeconds) + ' so far): jump to the latest moment';
}
async function reloadPlayer() {
  const wasPlaying = !video.paused;
  if (hls) {
    hls.destroy();
    hls = null;
  }
  video.removeAttribute('src');
  video.load();
  playerReady = false;
  await initPlayer();
  setStatus('Play');
  if (wasPlaying) await video.play().catch(() => {});
}
async function refreshLive() {
  const data = await fetch('live.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (data && Array.isArray(data.segments)) {
    // Segments filled in mid-session (a recovered gap) shift the player's timeline, so the player reloads; new
    // segments at the end just extend it.
    const appended =
      data.segments.length >= segments.length &&
      segments.every((item, index) => data.segments[index][0] === item[0] && data.segments[index][1] === item[1]);
    const segmentsChanged = !appended || data.segments.length !== segments.length;
    const shownBefore = gridCount();
    const scenesChanged = JSON.stringify(data.scenes) !== JSON.stringify(page.scenes);
    segments.splice(0, segments.length, ...data.segments);
    thumbs.splice(0, thumbs.length, ...data.thumbs);
    page.clocks = data.clocks || page.clocks;
    last = thumbs[thumbs.length - 1];
    endSeconds = segments.length
      ? segments[segments.length - 1][1] + segments[segments.length - 1][2]
      : last
        ? last.s
        : 0;
    if (segmentsChanged) {
      sliderRangeKey = '';
      updateSliderRange();
      slider.value = position;
      renderScrubMarks();
    }
    if (gridCount() !== shownBefore) renderGrid();
    if (scenesChanged) {
      page.scenes = data.scenes;
      renderTranscript();
      updateNowScene();
    }
    if (!appended && playerReady) await reloadPlayer().catch((error) => showFileNote(true, error.message));
    page.live = Boolean(data.live);
  }
  liveRuns += 1;
  if (page.live && liveRuns % 3 === 0) loadLatestTranscript();
  updateLiveEdge();
  if (page.live) setTimeout(refreshLive, 5000);
  else loadLatestTranscript();
}
$('live-edge').addEventListener('click', () => showPosition(Math.max(0, endSeconds - 5)));
// Served by streamscribe, the page links back to the library.
$('home').hidden = location.protocol === 'file:';
updateLiveEdge();
if (page.live && location.protocol !== 'file:') setTimeout(refreshLive, 2000);

$('density').addEventListener('change', renderGrid);
try {
  if (localStorage.getItem('thumbnails.playBoosts') === '1') $('play-boosts').checked = true;
} catch {}
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
