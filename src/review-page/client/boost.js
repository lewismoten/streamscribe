// Boost & re-transcribe: pick a portion, adjust the volume while listening, then the local server applies the same
// adjustment with ffmpeg and transcribes the portion again (retranscribe-range).
const boost = { from: null, to: null, previewing: false, graph: null, polling: null, playingKey: null };
function boostSettings() {
  return {
    gainDb: Number($('boost-gain').value),
    highpassHz: $('boost-highpass').checked ? 120 : 0,
    normalize: $('boost-normalize').checked,
    denoise: $('boost-denoise').checked
  };
}
function readBoostRange() {
  boost.from = parse($('boost-from').value);
  boost.to = parse($('boost-to').value);
  const valid = boost.from !== null && boost.to !== null && boost.to > boost.from;
  $('boost-length').textContent = valid ? fmt(boost.to - boost.from) + ' long' : 'enter a start before the end';
  ['boost-preview', 'boost-render', 'boost-send', 'boost-save'].forEach((id) => { $(id).disabled = !valid; });
  return valid;
}
// Live preview: the video's sound runs through the browser's audio graph (high-pass, gain, and a compressor that
// stands in for the server's loudness evening; with that off it only keeps loud moments from clipping).
function ensureGraph() {
  if (boost.graph) return boost.graph;
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const source = context.createMediaElementSource(video);
  const highpass = context.createBiquadFilter();
  highpass.type = 'highpass';
  const gain = context.createGain();
  const compressor = context.createDynamicsCompressor();
  source.connect(highpass).connect(gain).connect(compressor).connect(context.destination);
  boost.graph = { context, highpass, gain, compressor };
  return boost.graph;
}
// Sets the audio graph to boost settings, or to pass the sound through unchanged (null).
function setGraph(settings) {
  const graph = boost.graph;
  if (!graph) return;
  const active = Boolean(settings);
  graph.highpass.frequency.value = active && settings.highpassHz ? settings.highpassHz : 10;
  graph.gain.gain.value = active ? Math.pow(10, (settings.gainDb || 0) / 20) : 1;
  graph.compressor.threshold.value = !active ? 0 : (settings.normalize ? -45 : -3);
  graph.compressor.ratio.value = !active ? 1 : (settings.normalize ? 8 : 20);
  graph.compressor.knee.value = active && settings.normalize ? 20 : 0;
  graph.compressor.attack.value = 0.005;
  graph.compressor.release.value = 0.25;
}
// The dialog's settings while it's open; otherwise whatever saved boost applies at this moment.
function applyLiveBoost(active) {
  $('boost-gain-value').textContent = (Number($('boost-gain').value) >= 0 ? '+' : '') + $('boost-gain').value + ' dB';
  if (active) setGraph(boostSettings());
  else { boost.playingKey = null; updatePlaybackBoost(); }
}

// Saved playback boosts ({session}/audio-boosts.json): ranges with the settings to hear them with.
let playbackBoosts = page.boosts;
function boostAt(seconds) {
  return playbackBoosts.find((item) => seconds >= item.from && seconds < item.to) || null;
}
const describeBoost = (settings) => ((settings.gainDb >= 0 ? '+' : '') + settings.gainDb + ' dB'
  + (settings.normalize ? ', evened' : '') + (settings.highpassHz ? ', rumble cut' : '') + (settings.denoise ? ', noise reduced' : ''));
function updatePlaybackBoost() {
  if ($('boost-dialog').open) return;
  const enabled = $('play-boosts').checked;
  const found = enabled ? boostAt(position) : null;
  const key = found ? found.id : '';
  if (key === boost.playingKey && key) return;
  boost.playingKey = key;
  if (found && !boost.graph && playerReady) {
    ensureGraph().context.resume().catch(() => {});
  }
  setGraph(found);
  // Short in the toolbar; the details are in its tooltip.
  $('boost-active').textContent = found ? '🔊 ' + (found.gainDb >= 0 ? '+' : '') + found.gainDb + ' dB' : (enabled && !playbackBoosts.length ? '🔊 none saved' : '');
  $('boost-active').title = found ? 'Boosted: ' + describeBoost(found) : (enabled && !playbackBoosts.length ? 'No boosts saved yet: save one in 🔊 Boost & re-transcribe' : '');
}
function setPlayBoosts(enabled) {
  $('play-boosts').checked = enabled;
  try { localStorage.setItem('thumbnails.playBoosts', enabled ? '1' : '0'); } catch {}
  boost.playingKey = null;
  updatePlaybackBoost();
}
$('play-boosts').addEventListener('change', () => setPlayBoosts($('play-boosts').checked));
video.addEventListener('play', () => { boost.graph?.context.resume().catch(() => {}); boost.playingKey = null; updatePlaybackBoost(); });
async function saveBoosts() {
  if (location.protocol === 'file:') throw new Error('saving needs the local server (npm start)');
  const response = await fetch('../audio-boosts.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ updatedAt: new Date().toISOString(), note: 'Volume boosts to play during playback; set from the thumbnails page.', boosts: playbackBoosts }, null, 2) });
  if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
}
// A new boost replaces whatever saved boosts covered the same stretch (the parts outside it stay).
async function addPlaybackBoost(from, to, settings) {
  const next = [];
  for (const item of playbackBoosts) {
    if (item.to <= from || item.from >= to) { next.push(item); continue; }
    if (item.from < from) next.push({ ...item, to: from });
    if (item.to > to) next.push({ ...item, id: item.id + '-b', from: to });
  }
  next.push({ id: Date.now().toString(36), from: Number(from.toFixed(3)), to: Number(to.toFixed(3)), ...settings, createdAt: new Date().toISOString() });
  playbackBoosts = next.sort((left, right) => left.from - right.from);
  await saveBoosts();
  renderSavedBoosts();
  boost.playingKey = null;
}
function renderSavedBoosts() {
  const list = $('boost-saved');
  list.textContent = '';
  if (!playbackBoosts.length) {
    const empty = document.createElement('li');
    empty.textContent = 'None yet.';
    list.appendChild(empty);
    return;
  }
  playbackBoosts.forEach((item) => {
    const row = document.createElement('li');
    const text = document.createElement('span');
    text.textContent = fmt(item.from) + '-' + fmt(item.to) + ' · ' + describeBoost(item);
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Go';
    go.addEventListener('click', () => showPosition(item.from));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      const before = playbackBoosts;
      playbackBoosts = playbackBoosts.filter((other) => other !== item);
      try {
        await saveBoosts();
        renderSavedBoosts();
      } catch (error) {
        playbackBoosts = before;
        $('boost-status').textContent = 'Not removed: ' + error.message;
      }
    });
    row.append(text, go, remove);
    list.appendChild(row);
  });
}
$('boost-save').addEventListener('click', async () => {
  if (!readBoostRange()) return;
  try {
    await addPlaybackBoost(boost.from, boost.to, boostSettings());
    if (!$('play-boosts').checked) setPlayBoosts(true);
    $('boost-status').textContent = 'Saved: ' + fmt(boost.from) + '-' + fmt(boost.to) + ' plays boosted while "Boost quiet speakers" is checked.';
  } catch (error) {
    $('boost-status').textContent = 'Not saved: ' + error.message;
  }
});
function stopBoostPreview() {
  if (boost.previewing) video.pause();
  boost.previewing = false;
  $('boost-preview').textContent = '▶ Listen here';
}
async function toggleBoostPreview() {
  if (boost.previewing) { stopBoostPreview(); return; }
  if (!readBoostRange()) return;
  try {
    $('boost-audio').pause();
    if (!playerReady) {
      $('boost-status').textContent = 'Loading video...';
      await initPlayer();
      setStatus('Play');
      $('play').disabled = false;
    }
    const graph = ensureGraph();
    await graph.context.resume();
    applyLiveBoost(true);
    showPosition(boost.from);
    await seekTo(toPlayerTime(boost.from));
    boost.previewing = true;
    $('boost-preview').textContent = '⏹ Stop';
    $('boost-status').textContent = '';
    await video.play();
  } catch (error) {
    stopBoostPreview();
    $('boost-status').textContent = 'Could not play: ' + error.message;
  }
}
video.addEventListener('timeupdate', () => {
  if (boost.previewing && toPosition(video.currentTime) >= boost.to) stopBoostPreview();
});
video.addEventListener('pause', () => { if (boost.previewing) { boost.previewing = false; $('boost-preview').textContent = '▶ Listen here'; } });

// Server jobs: POST ../retranscribe, then follow ../retranscribe/jobs/{job}.json until it finishes.
async function startBoostJob(body) {
  if (location.protocol === 'file:') throw new Error('this needs the local server (npm start)');
  const response = await fetch('../retranscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
  const started = await response.json();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = async () => {
      const job = await fetch('../' + started.statusUrl, { cache: 'no-store' }).then((reply) => (reply.ok ? reply.json() : null)).catch(() => null);
      if (job?.status === 'done') { resolve(job); return; }
      if (job?.status === 'failed') { reject(new Error(job.message || 'the job failed')); return; }
      if (job?.message) $('boost-status').textContent = job.message + ' (' + Math.round((Date.now() - startedAt) / 1000) + 's)';
      setTimeout(check, 1500);
    };
    setTimeout(check, 700);
  });
}
function setBoostBusy(busy) {
  ['boost-render', 'boost-send', 'boost-save'].forEach((id) => { $(id).disabled = busy; });
  if (!busy) readBoostRange();
}
$('boost-render').addEventListener('click', async () => {
  if (!readBoostRange()) return;
  stopBoostPreview();
  setBoostBusy(true);
  $('boost-status').textContent = 'Asking the server for the adjusted audio...';
  try {
    const job = await startBoostJob({ action: 'preview', from: boost.from, to: boost.to, ...boostSettings() });
    const audio = $('boost-audio');
    audio.src = '../retranscribe/' + job.preview;
    audio.hidden = false;
    $('boost-status').textContent = "This is the server's version of " + fmt(boost.from) + '-' + fmt(boost.to) + '.';
    await audio.play().catch(() => {});
  } catch (error) {
    $('boost-status').textContent = 'Could not make the adjusted audio: ' + error.message;
  } finally {
    setBoostBusy(false);
  }
});
$('boost-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!readBoostRange()) return;
  stopBoostPreview();
  setBoostBusy(true);
  $('boost-status').textContent = 'Sending to the server...';
  try {
    const job = await startBoostJob({ action: 'transcribe', from: boost.from, to: boost.to, quality: $('boost-quality').value, ...boostSettings() });
    $('boost-status').textContent = job.message;
    if ($('boost-keep').checked) {
      await addPlaybackBoost(boost.from, boost.to, boostSettings()).catch((error) => { $('boost-status').textContent += ' (playback boost not saved: ' + error.message + ')'; });
      if (!$('play-boosts').checked) setPlayBoosts(true);
    }
    await loadLatestTranscript();
    await renderPortions();
  } catch (error) {
    $('boost-status').textContent = 'Not re-transcribed: ' + error.message;
  } finally {
    setBoostBusy(false);
  }
});
async function renderPortions() {
  const list = $('boost-portions');
  list.textContent = '';
  const index = location.protocol === 'file:' ? null
    : await fetch('../transcripts/retranscribed.json', { cache: 'no-store' }).then((reply) => (reply.ok ? reply.json() : null)).catch(() => null);
  const portions = index?.portions || [];
  if (!portions.length) {
    const empty = document.createElement('li');
    empty.textContent = 'None yet.';
    list.appendChild(empty);
    return;
  }
  portions.forEach((portion) => {
    const item = document.createElement('li');
    const text = document.createElement('span');
    const settings = portion.settings || {};
    text.textContent = fmt(portion.from) + '-' + fmt(portion.to) + ' · ' + (settings.gainDb >= 0 ? '+' : '') + settings.gainDb + ' dB'
      + (settings.normalize ? ', evened' : '') + (settings.highpassHz ? ', rumble cut' : '') + (settings.denoise ? ', noise reduced' : '')
      + ' · ' + portion.quality + ' · ' + portion.lines.length + ' lines';
    const go = document.createElement('button');
    go.type = 'button';
    go.textContent = 'Go';
    go.addEventListener('click', () => showPosition(portion.from));
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.textContent = 'Undo';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        await startBoostJob({ action: 'remove', portionId: portion.id });
        $('boost-status').textContent = 'Undone; the original lines for ' + fmt(portion.from) + '-' + fmt(portion.to) + ' are back.';
        await loadLatestTranscript();
        await renderPortions();
      } catch (error) {
        $('boost-status').textContent = 'Not undone: ' + error.message;
        undo.disabled = false;
      }
    });
    // Older portions were made before playback boosts were saved automatically.
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.textContent = '🔊 Boost playback';
    keep.title = "Save this portion's settings as a playback boost";
    keep.addEventListener('click', async () => {
      try {
        await addPlaybackBoost(portion.from, portion.to, { gainDb: settings.gainDb || 0, highpassHz: settings.highpassHz || 0, normalize: Boolean(settings.normalize), denoise: Boolean(settings.denoise) });
        if (!$('play-boosts').checked) setPlayBoosts(true);
        $('boost-status').textContent = fmt(portion.from) + '-' + fmt(portion.to) + ' now plays boosted.';
      } catch (error) {
        $('boost-status').textContent = 'Not saved: ' + error.message;
      }
    });
    item.append(text, go, keep, undo);
    list.appendChild(item);
  });
}
$('boost-open').addEventListener('click', () => {
  // Start from the clip range, or the next 30 seconds from here.
  let from = start, to = end;
  if (from !== null && to !== null && to < from) [from, to] = [to, from];
  if (from === null || to === null || to <= from) { from = position; to = Math.min(endSeconds, position + 30); }
  openBoostDialog(from, to);
});
function openBoostDialog(from, to) {
  $('boost-from').value = fmtPrecise(Math.max(0, from));
  $('boost-to').value = fmtPrecise(Math.min(endSeconds, to));
  $('boost-status').textContent = location.protocol === 'file:' ? 'Listening works here once the video plays; sending needs the local server (npm start).' : '';
  readBoostRange();
  renderPortions();
  renderSavedBoosts();
  if (!$('boost-dialog').open) $('boost-dialog').showModal();
  applyLiveBoost(true);
  loadWaveform();
}
['boost-from', 'boost-to'].forEach((id) => $(id).addEventListener('input', () => { stopBoostPreview(); readBoostRange(); }));
['boost-gain', 'boost-normalize', 'boost-highpass'].forEach((id) => $(id).addEventListener('input', () => applyLiveBoost(true)));
$('boost-preview').addEventListener('click', toggleBoostPreview);
$('boost-close').addEventListener('click', () => $('boost-dialog').close());
$('boost-dialog').addEventListener('close', () => {
  stopBoostPreview();
  $('boost-audio').pause();
  applyLiveBoost(false);
});
