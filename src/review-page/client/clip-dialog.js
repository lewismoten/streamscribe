// Download clip: refine the range on a waveform, preview it, and have the local server cut it (extract-clip,
// saved in the session's clips folder) for the browser to download. The waveform itself is in clip-waveform.js.
const clipDialogRange = { from: null, to: null, previewing: false };
function readClipRange() {
  clipDialogRange.from = parse($('clip-from').value);
  clipDialogRange.to = parse($('clip-to').value);
  const valid =
    clipDialogRange.from !== null && clipDialogRange.to !== null && clipDialogRange.to > clipDialogRange.from;
  $('clip-length').textContent = valid
    ? fmt(clipDialogRange.to - clipDialogRange.from) + ' long'
    : 'enter a start before the end';
  ['clip-download', 'clip-preview'].forEach((id) => {
    $(id).disabled = !valid && !clipRecording;
  });
  return valid;
}
const clipWave = makeWaveform({
  canvas: $('clip-wave'),
  strip: $('clip-strip'),
  zoomIn: $('clip-zoom-in'),
  zoomOut: $('clip-zoom-out'),
  startLabel: $('clip-wave-start'),
  endLabel: $('clip-wave-end'),
  status: $('clip-wave-status'),
  reload: $('clip-wave-reload'),
  dialog: $('clip-dialog'),
  getRange: () => (readClipRange() ? { from: clipDialogRange.from, to: clipDialogRange.to } : null),
  setRange: (from, to) => {
    $('clip-from').value = fmtPrecise(from);
    $('clip-to').value = fmtPrecise(to);
    readClipRange();
    // Keep the page's clip range in step.
    start = from;
    end = to;
    update();
  },
  onDrag: () => stopClipPreview()
});
$('clip-open').addEventListener('click', () => {
  let from = start,
    to = end;
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  if (from === null || to === null || to <= from) {
    from = position;
    to = Math.min(endSeconds, position + 30);
  }
  $('clip-from').value = fmtPrecise(from);
  $('clip-to').value = fmtPrecise(to);
  $('clip-status').textContent = location.protocol === 'file:' ? 'Downloading needs the local server (npm start).' : '';
  readClipRange();
  if (!$('clip-dialog').open) {
    $('clip-dialog').show();
    // Anchor it by its left and top so dragging the corner widens it to the right.
    const rect = $('clip-dialog').getBoundingClientRect();
    if (rect.width)
      Object.assign($('clip-dialog').style, { inset: 'auto', left: rect.left + 'px', top: rect.top + 'px' });
  }
  clipWave.load();
});
if (window.ResizeObserver)
  new ResizeObserver(() => {
    if ($('clip-dialog').open) clipWave.draw();
  }).observe($('clip-dialog'));
['clip-from', 'clip-to'].forEach((id) => {
  $(id).addEventListener('input', () => {
    stopClipPreview();
    readClipRange();
  });
  $(id).addEventListener('change', () => clipWave.typed());
});
function stopClipPreview() {
  if (clipDialogRange.previewing) video.pause();
  clipDialogRange.previewing = false;
  $('clip-preview').textContent = '▶ Play clip';
}
$('clip-preview').addEventListener('click', async () => {
  if (clipDialogRange.previewing) {
    stopClipPreview();
    return;
  }
  if (!readClipRange()) return;
  try {
    if (!playerReady) {
      $('clip-status').textContent = 'Loading video...';
      await initPlayer();
      setStatus('Play');
      $('play').disabled = false;
    }
    // Pick up from the playhead when it's inside the clip (after clicking the waveform), else from the start.
    const startAt =
      position >= clipDialogRange.from && position < clipDialogRange.to - 0.2 ? position : clipDialogRange.from;
    showPosition(startAt);
    await seekTo(toPlayerTime(startAt));
    clipDialogRange.previewing = true;
    $('clip-preview').textContent = '⏹ Stop';
    $('clip-status').textContent = '';
    await video.play();
  } catch (error) {
    stopClipPreview();
    $('clip-status').textContent = 'Could not play: ' + error.message;
  }
});
// At the end of the clip: start over when looping, otherwise stop.
video.addEventListener('timeupdate', () => {
  if (!clipDialogRange.previewing || toPosition(video.currentTime) < clipDialogRange.to) return;
  if ($('clip-loop').checked) {
    video.currentTime = toPlayerTime(clipDialogRange.from);
    showPosition(clipDialogRange.from, { seek: false });
  } else stopClipPreview();
});
try {
  $('clip-loop').checked = localStorage.getItem('thumbnails.clipLoop') === '1';
} catch {}
$('clip-loop').addEventListener('change', () => {
  try {
    localStorage.setItem('thumbnails.clipLoop', $('clip-loop').checked ? '1' : '0');
  } catch {}
});
$('clip-download').addEventListener('click', async () => {
  if (clipRecording) {
    clipRecording.stop();
    return;
  }
  if (!readClipRange()) return;
  stopClipPreview();
  if ($('clip-overlays').checked) {
    recordClipWithOverlays();
    return;
  }
  $('clip-download').disabled = true;
  $('clip-status').textContent = 'Cutting the clip...';
  try {
    const job = await startBoostJob({
      action: 'clip',
      from: clipDialogRange.from,
      to: clipDialogRange.to,
      accurate: $('clip-accurate').checked
    });
    const link = document.createElement('a');
    link.href = '../' + job.clip;
    link.download = job.clip.split('/').pop();
    document.body.appendChild(link);
    link.click();
    link.remove();
    $('clip-status').textContent = job.message;
  } catch (error) {
    $('clip-status').textContent = 'No clip: ' + error.message;
  } finally {
    readClipRange();
  }
});
// With the overlays: plays the clip and records a canvas showing the video with everything drawn on it (as on the
// page, magnified speakers included), plus the sound (with any playback boost), then downloads the recording.
let clipRecording = null;
async function recordClipWithOverlays() {
  const status = $('clip-status');
  let destination = null;
  try {
    if (!window.MediaRecorder) throw new Error('this browser cannot record video');
    if (!playerReady) {
      status.textContent = 'Loading video...';
      await initPlayer();
      setStatus('Play');
      $('play').disabled = false;
    }
    video.pause();
    const from = clipDialogRange.from;
    const to = clipDialogRange.to;
    showPosition(from);
    await seekTo(toPlayerTime(from));
    await waitForFrame(15000);
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    // Sound: through the boost graph when it's in use (so boosts are kept), else straight from the video.
    let audioTracks = [];
    if (boost.graph) {
      destination = boost.graph.context.createMediaStreamDestination();
      boost.graph.compressor.connect(destination);
      audioTracks = destination.stream.getAudioTracks();
    } else {
      const capture = video.captureStream
        ? video.captureStream()
        : video.mozCaptureStream
          ? video.mozCaptureStream()
          : null;
      audioTracks = capture ? capture.getAudioTracks() : [];
    }
    const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audioTracks]);
    const type =
      [
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm'
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
    const recorder = new MediaRecorder(stream, type ? { mimeType: type, videoBitsPerSecond: 6000000 } : undefined);
    const chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    let frame = 0;
    const draw = () => {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      paintMagnified(context, video, canvas.width, canvas.height, magnifiedAt(currentSeconds()));
      paintOverlays(context, canvas.width);
      const now = toPosition(video.currentTime);
      status.textContent =
        'Recording with the overlays: ' + fmt(Math.max(0, now - from)) + ' of ' + fmt(to - from) + ' (⏹ to stop early)';
      if (now >= to || video.ended) {
        recorder.stop();
        return;
      }
      frame = requestAnimationFrame(draw);
    };
    const finished = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    clipRecording = {
      stop: () => {
        if (recorder.state !== 'inactive') recorder.stop();
      }
    };
    $('clip-download').textContent = '⏹ Stop';
    recorder.start(1000);
    await video.play();
    draw();
    await finished;
    cancelAnimationFrame(frame);
    video.pause();
    const blob = new Blob(chunks, { type: recorder.mimeType || type || 'video/webm' });
    const extension = (recorder.mimeType || type).includes('mp4') ? 'mp4' : 'webm';
    const name =
      'clip-' + fmt(from).replace(/:/g, '-') + '-to-' + fmt(to).replace(/:/g, '-') + '-overlays.' + extension;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    status.textContent = 'Saved ' + name + ' (' + (blob.size / 1e6).toFixed(1) + ' MB)';
  } catch (error) {
    status.textContent = 'Not recorded: ' + error.message;
  } finally {
    if (destination) {
      try {
        boost.graph.compressor.disconnect(destination);
      } catch {}
    }
    clipRecording = null;
    $('clip-download').textContent = '⬇ Download';
    readClipRange();
  }
}
$('clip-close').addEventListener('click', () => $('clip-dialog').close());
$('clip-dialog').addEventListener('close', stopClipPreview);
