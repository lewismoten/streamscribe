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
// How a person's copy shows (set in the zoom area editor): 'copy' grows out of where they sit (the default), 'pip' (a
// picture in picture) fades in and out at its place, 'none' shows nothing (their square only marks where they sit).
// A copy's place can move from a moment on (keyframes: region.moves, [{ at, target }] in video seconds), such as out of
// the way of a document shown during part of the meeting.
const showOf = (region) => region.show || 'copy';
function targetAt(region, seconds) {
  const moved = (region.moves || [])
    .filter((move) => move.at <= seconds)
    .sort((a, b) => a.at - b.at)
    .at(-1);
  return moved?.target || targetOf(region);
}
// What to show at a video position: each area with how far along it is, from 0 (where they sit) to 1 (its larger
// copy in place). It grows in during the lead-up to speaking, holds while they speak and a few seconds after, then
// shrinks back into their seat. Every step stays within the shot (camera view) showing at that moment, worked out
// for the exact frame: nothing grows ahead of a cut, nothing lingers past one, and someone already talking when the
// camera cuts to them grows in at the start of the new shot.
let manualFadeStart = 0;
function magnifiedAt(seconds) {
  if (manualZoom)
    return [
      { region: manualZoom, progress: Math.min(1, (performance.now() - manualFadeStart) / (leadSeconds * 1000)) }
    ];
  if (!autoZoom) return [];
  const scene = sceneIndexAt(seconds);
  const view = scene >= 0 ? cachedViewFor(page.scenes[scene][1]) : null;
  if (!view) return [];
  const sceneStart = page.scenes[scene][0];
  const sceneEnd = scene + 1 < page.scenes.length ? page.scenes[scene + 1][0] : Infinity;
  const shown = [];
  Object.entries(view.regions || {}).forEach(([id, region]) => {
    if (showOf(region) === 'none') return;
    const stretches = speakingStretches(id);
    const speaking = stretches.find((item) => seconds >= item.from && seconds < item.to);
    if (speaking) {
      shown.push({
        region,
        progress: speaking.from < sceneStart ? Math.min(1, (seconds - sceneStart) / leadSeconds) : 1
      });
      return;
    }
    // Only a stretch that ended in this shot lingers, and only one starting in this shot grows in ahead of it.
    const ended = [...stretches].reverse().find((item) => item.to <= seconds && item.to > sceneStart);
    const since = ended ? seconds - ended.to : Infinity;
    const next = stretches.find(
      (item) => item.from > seconds && item.from - seconds <= leadSeconds && item.from < sceneEnd
    );
    const lead = next ? Math.min(leadSeconds, next.from - sceneStart) : leadSeconds;
    const growing = next && lead > 0 ? Math.max(0, 1 - (next.from - seconds) / lead) : 0;
    const leaving =
      since < holdSeconds ? 1 : since < holdSeconds + fadeSeconds ? 1 - (since - holdSeconds) / fadeSeconds : 0;
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
  if (visible || (playerReady && !video.paused && (autoZoom || manualZoom)))
    magnifyFrame = requestAnimationFrame(magnifyLoop);
}
function currentSeconds() {
  return playerReady && !video.hidden ? toPosition(video.currentTime) : position;
}
// Draws each visible area's larger copy, with a black border and a drop shadow.
function paintMagnified(context, source, width, height, items) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  if (!sourceWidth || !sourceHeight) return;
  const seconds = currentSeconds();
  items.forEach(({ region, progress }) => {
    if (progress <= 0) return;
    // Between where they sit and the larger copy's place, eased; it fades in over the first part of the way. A picture
    // in picture stays at its place and only fades.
    const target = targetAt(region, seconds);
    const pip = showOf(region) === 'pip';
    const along = pip ? 1 : ease(Math.min(1, progress));
    const opacity = pip ? Math.min(1, progress) : Math.min(1, progress * 2.5);
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
    context.drawImage(
      source,
      region.x * sourceWidth,
      region.y * sourceHeight,
      region.w * sourceWidth,
      regionHeight(region) * sourceHeight,
      x,
      y,
      w,
      h
    );
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
  if (manualZoom || zoomSelecting) {
    manualZoom = null;
    zoomSelecting = false;
    $('stage').classList.remove('selecting');
    updateZoom();
    return;
  }
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
    if (size < 12) {
      $('snapshot-status').textContent = '';
      updateZoom();
      return;
    }
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
