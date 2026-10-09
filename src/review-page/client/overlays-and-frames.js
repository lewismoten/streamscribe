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
  try {
    localStorage.setItem('thumbnails.overlay', overlayMode);
  } catch {}
  updateOverlay();
}
$('overlay-mode').addEventListener('change', () => setOverlay($('overlay-mode').value));
$('clock-format').value = clockLook;
$('clock-format').addEventListener('change', () => {
  setClockFormat($('clock-format').value);
  updateOverlay();
});
try {
  // Earlier pages had a single "Show clock" checkbox, which showed both.
  setOverlay(
    localStorage.getItem('thumbnails.overlay') ||
      (localStorage.getItem('thumbnails.showClock') === '1' ? 'both' : 'none')
  );
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
    const fileName =
      'frame-' + fmt(position).replace(/:/g, '-') + (fraction ? '.' + String(fraction).padStart(3, '0') : '') + '.png';
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
    if (video.readyState >= 2) {
      resolve();
      return;
    }
    if (video.buffered.length && video.buffered.start(0) > video.currentTime) {
      video.currentTime = video.buffered.start(0) + 0.05;
    }
    const done = (fn, value) => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('seeked', onReady);
      video.removeEventListener('canplay', onReady);
      fn(value);
    };
    const onReady = () => {
      if (video.readyState >= 2) done(resolve);
    };
    const timer = setTimeout(
      () => done(reject, new Error('the frame did not load within ' + Math.round(timeoutMs / 1000) + ' seconds')),
      timeoutMs
    );
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
    if (Math.abs(video.currentTime - target) < frameSeconds / 4 && video.readyState >= 2) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
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
  if (event.key === ',') {
    event.preventDefault();
    stepFrame(-1);
  }
  if (event.key === '.') {
    event.preventDefault();
    stepFrame(1);
  }
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
      canvas.height = Math.round((320 * video.videoHeight) / Math.max(1, video.videoWidth));
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.time = String(video.currentTime);
      if (offset === 0) button.classList.add('current');
      const label = document.createElement('span');
      const framesAway = offset * spacing;
      label.textContent =
        (offset === 0 ? 'current' : (framesAway > 0 ? '+' : '') + framesAway + ' fr') +
        ' · ' +
        fmt(toPosition(video.currentTime)) +
        '.' +
        String(Math.round((toPosition(video.currentTime) % 1) * 1000)).padStart(3, '0');
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

$('set-start').addEventListener('click', () => {
  start = position;
  update();
});
$('set-end').addEventListener('click', () => {
  end = position;
  update();
});
