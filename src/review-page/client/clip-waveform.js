// Waveform of a range (with a few seconds either side), measured by the local server from the original audio, with
// draggable start (green) and end (red) edges. Heights are on a loudness scale (dB), so quiet speech still shows.
// Used by the Boost and Download clip dialogs; each gives its elements and how to read and set its range.
function makeWaveform({
  canvas,
  strip,
  zoomIn,
  zoomOut,
  startLabel,
  endLabel,
  status,
  reload,
  dialog,
  getRange,
  setRange,
  onDrag
}) {
  const wave = { from: 0, to: 0, peaks: [], dragging: null };
  const x = (seconds, width) => ((seconds - wave.from) / Math.max(0.001, wave.to - wave.from)) * width;
  const time = (offset, width) => wave.from + (offset / width) * (wave.to - wave.from);
  const hint =
    'Drag the green (start) and red (end) edges to refine it; click elsewhere to move the playhead (it stays within them).';
  // Loads the waveform for a stretch (by default, the range with a margin either side).
  async function load(view) {
    const range = getRange();
    if (!range) return;
    const margin = Math.max(3, (range.to - range.from) * 0.25);
    const from = view ? view.from : Math.max(0, range.from - margin);
    const to = view ? view.to : Math.min(endSeconds, range.to + margin);
    status.textContent = 'Loading the waveform...';
    try {
      const job = await startBoostJob({ action: 'peaks', from, to });
      const data = await fetch('../retranscribe/' + job.peaks, { cache: 'no-store' }).then((reply) => reply.json());
      Object.assign(wave, { from: data.from, to: data.to, peaks: data.peaks });
      status.textContent = hint;
    } catch (error) {
      wave.peaks = [];
      status.textContent = 'No waveform: ' + error.message;
    }
    draw();
  }
  function draw() {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round((canvas.clientWidth || 600) * ratio));
    const height = Math.max(1, Math.round((canvas.clientHeight || 110) * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    startLabel.textContent = wave.peaks.length ? fmtPrecise(wave.from) : '';
    endLabel.textContent = wave.peaks.length ? fmtPrecise(wave.to) : '';
    const context = canvas.getContext('2d');
    if (!context || !context.fillRect) return;
    context.clearRect(0, 0, width, height);
    const range = getRange();
    if (!wave.peaks.length || !range) return;
    const middle = height / 2;
    const left = x(range.from, width);
    const right = x(range.to, width);
    context.fillStyle = 'rgba(255, 224, 138, 0.16)';
    context.fillRect(left, 0, right - left, height);
    const barWidth = width / wave.peaks.length;
    wave.peaks.forEach((peak, index) => {
      const level = peak > 0 ? Math.max(0, (20 * Math.log10(peak) + 60) / 60) : 0;
      const bar = Math.max(1, level * (height * 0.46));
      const at = index * barWidth;
      context.fillStyle = at >= left && at <= right ? '#ffd166' : '#5c7c8a';
      context.fillRect(at, middle - bar, Math.max(1, barWidth - 0.5), bar * 2);
    });
    [
      [left, '#2e9d5b'],
      [right, '#d33b2f']
    ].forEach(([edge, color]) => {
      context.fillStyle = color;
      context.fillRect(edge - 1.5 * ratio, 0, 3 * ratio, height);
      context.fillRect(edge - 6 * ratio, 0, 12 * ratio, 10 * ratio);
      context.fillRect(edge - 6 * ratio, height - 10 * ratio, 12 * ratio, 10 * ratio);
    });
    if (position >= wave.from && position <= wave.to) {
      context.fillStyle = '#ffffff';
      context.fillRect(x(position, width) - ratio / 2, 0, ratio, height);
    }
    drawStrip();
  }
  // Frames across the same window: one thumbnail after another (the nearest one saved for each spot).
  const frameImages = new Map();
  let stripRedraw = 0;
  function frameImage(file) {
    if (!frameImages.has(file)) {
      const image = new Image();
      image.onload = () => {
        if (!stripRedraw)
          stripRedraw = setTimeout(() => {
            stripRedraw = 0;
            drawStrip();
          }, 50);
      };
      image.src = file;
      frameImages.set(file, image);
    }
    return frameImages.get(file);
  }
  function drawStrip() {
    if (!strip) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round((strip.clientWidth || 600) * ratio));
    const height = Math.max(1, Math.round((strip.clientHeight || 54) * ratio));
    if (strip.width !== width) strip.width = width;
    if (strip.height !== height) strip.height = height;
    const context = strip.getContext('2d');
    if (!context || !context.fillRect) return;
    context.clearRect(0, 0, width, height);
    const range = getRange();
    if (!thumbs.length || wave.to <= wave.from || !range) return;
    const tileWidth = (height * 16) / 9;
    for (let left = 0; left < width; left += tileWidth) {
      const seconds = wave.from + ((left + tileWidth / 2) / width) * (wave.to - wave.from);
      const image = frameImage(thumbs[nearestThumb(seconds)].f);
      if (image.complete && image.naturalWidth) context.drawImage(image, left, 0, tileWidth, height);
    }
    // Outside the clip is shaded; its edges match the waveform's.
    const left = x(range.from, width);
    const right = x(range.to, width);
    context.fillStyle = 'rgba(0, 0, 0, 0.55)';
    context.fillRect(0, 0, Math.max(0, left), height);
    context.fillRect(right, 0, Math.max(0, width - right), height);
    [
      [left, '#2e9d5b'],
      [right, '#d33b2f']
    ].forEach(([edge, color]) => {
      context.fillStyle = color;
      context.fillRect(edge - 1.5 * ratio, 0, 3 * ratio, height);
    });
  }
  // Zooming around the clip (or the current window's middle): a new window, loaded fresh for detail.
  let zoomTimer = 0;
  function zoom(factor) {
    const range = getRange();
    const current = Math.max(1, wave.to - wave.from || (range ? (range.to - range.from) * 1.5 : 30));
    const span = Math.max(2, Math.min(endSeconds, current * factor));
    const center = range ? (range.from + range.to) / 2 : (wave.from + wave.to) / 2;
    const from = Math.max(0, Math.min(endSeconds - span, center - span / 2));
    Object.assign(wave, { from, to: from + span });
    draw();
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => load({ from, to: from + span }), 250);
  }
  if (zoomIn) zoomIn.addEventListener('click', () => zoom(0.5));
  if (zoomOut) zoomOut.addEventListener('click', () => zoom(2));
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!wave.peaks.length) return;
      event.preventDefault();
      zoom(event.deltaY < 0 ? 0.8 : 1.25);
    },
    { passive: false }
  );
  const pointTime = (event, surface = canvas) => {
    const rect = surface.getBoundingClientRect();
    return Math.max(wave.from, Math.min(wave.to, time(event.clientX - rect.left, rect.width)));
  };
  const setEdge = (edge, seconds) => {
    const range = getRange();
    const minimum = 0.2;
    if (edge === 'from') setRange(Math.min(seconds, range.to - minimum), range.to);
    else setRange(range.from, Math.max(seconds, range.from + minimum));
    draw();
  };
  // Moves the playhead (and the video, if loaded) to a moment within the range: a click outside it, or scrubbing past
  // an edge, stops at that edge. Playing carries on from there.
  const seekHere = (wanted) => {
    const range = getRange();
    const seconds = range ? Math.max(range.from, Math.min(range.to, wanted)) : wanted;
    if (playerReady) video.currentTime = toPlayerTime(seconds);
    showPosition(seconds, { seek: false });
    draw();
  };
  // Which edge (if any) is within reach of the pointer.
  const edgeAt = (offset, width) => {
    const range = getRange();
    if (!range) return null;
    const fromDistance = Math.abs(offset - x(range.from, width));
    const toDistance = Math.abs(offset - x(range.to, width));
    if (Math.min(fromDistance, toDistance) > 10) return null;
    return fromDistance <= toDistance ? 'from' : 'to';
  };
  // The waveform and the frame strip: drag an edge to refine the range; press anywhere else to move the playhead
  // (holding and dragging scrubs).
  [canvas, strip].filter(Boolean).forEach((surface) => {
    surface.addEventListener('pointerdown', (event) => {
      if (!wave.peaks.length) return;
      const rect = surface.getBoundingClientRect();
      const edge = edgeAt(event.clientX - rect.left, rect.width);
      if (edge) {
        if (onDrag) onDrag();
        wave.dragging = edge;
        setEdge(edge, pointTime(event, surface));
      } else {
        wave.dragging = 'seek';
        seekHere(pointTime(event, surface));
      }
      surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener('pointermove', (event) => {
      const rect = surface.getBoundingClientRect();
      if (!wave.dragging) {
        surface.style.cursor = edgeAt(event.clientX - rect.left, rect.width) ? 'ew-resize' : 'pointer';
        return;
      }
      if (wave.dragging === 'seek') seekHere(pointTime(event, surface));
      else setEdge(wave.dragging, pointTime(event, surface));
    });
    surface.addEventListener('pointerup', () => {
      wave.dragging = null;
    });
  });
  reload.addEventListener('click', load);
  video.addEventListener('timeupdate', () => {
    if (dialog.open && wave.peaks.length) draw();
  });
  // A typed range outside the waveform loads a new one around it.
  const typed = () => {
    const range = getRange();
    if (range && (range.from < wave.from || range.to > wave.to)) load();
    else draw();
  };
  return { load, draw, typed, zoom };
}
const boostWave = makeWaveform({
  canvas: $('boost-wave'),
  startLabel: $('wave-start'),
  endLabel: $('wave-end'),
  status: $('wave-status'),
  reload: $('wave-reload'),
  dialog: $('boost-dialog'),
  getRange: () => (readBoostRange() ? { from: boost.from, to: boost.to } : null),
  setRange: (from, to) => {
    $('boost-from').value = fmtPrecise(from);
    $('boost-to').value = fmtPrecise(to);
    readBoostRange();
  },
  onDrag: () => stopBoostPreview()
});
function loadWaveform() {
  boostWave.load();
}
['boost-from', 'boost-to'].forEach((id) => $(id).addEventListener('change', () => boostWave.typed()));
