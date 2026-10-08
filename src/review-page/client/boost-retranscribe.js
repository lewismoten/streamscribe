// Boost & re-transcribe, the local server's part: its jobs (the adjusted audio, the new transcript of a portion,
// and the waveforms and clips the clip dialogs ask for), and the portions already re-transcribed.
// Server jobs: POST ../retranscribe, then follow ../retranscribe/jobs/{job}.json until it finishes.
async function startBoostJob(body) {
  if (location.protocol === 'file:') throw new Error('this needs the local server (npm start)');
  const response = await fetch('../retranscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok)
    throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
  const started = await response.json();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const check = async () => {
      const job = await fetch('../' + started.statusUrl, { cache: 'no-store' })
        .then((reply) => (reply.ok ? reply.json() : null))
        .catch(() => null);
      if (job?.status === 'done') {
        resolve(job);
        return;
      }
      if (job?.status === 'failed') {
        reject(new Error(job.message || 'the job failed'));
        return;
      }
      if (job?.message)
        $('boost-status').textContent = job.message + ' (' + Math.round((Date.now() - startedAt) / 1000) + 's)';
      setTimeout(check, 1500);
    };
    setTimeout(check, 700);
  });
}
function setBoostBusy(busy) {
  ['boost-render', 'boost-send', 'boost-save'].forEach((id) => {
    $(id).disabled = busy;
  });
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
    const job = await startBoostJob({
      action: 'transcribe',
      from: boost.from,
      to: boost.to,
      quality: $('boost-quality').value,
      ...boostSettings()
    });
    $('boost-status').textContent = job.message;
    if ($('boost-keep').checked) {
      await addPlaybackBoost(boost.from, boost.to, boostSettings()).catch((error) => {
        $('boost-status').textContent += ' (playback boost not saved: ' + error.message + ')';
      });
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
  const index =
    location.protocol === 'file:'
      ? null
      : await fetch('../transcripts/retranscribed.json', { cache: 'no-store' })
          .then((reply) => (reply.ok ? reply.json() : null))
          .catch(() => null);
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
    text.textContent =
      fmt(portion.from) +
      '-' +
      fmt(portion.to) +
      ' · ' +
      (settings.gainDb >= 0 ? '+' : '') +
      settings.gainDb +
      ' dB' +
      (settings.normalize ? ', evened' : '') +
      (settings.highpassHz ? ', rumble cut' : '') +
      (settings.denoise ? ', noise reduced' : '') +
      ' · ' +
      portion.quality +
      ' · ' +
      portion.lines.length +
      ' lines';
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
        $('boost-status').textContent =
          'Undone; the original lines for ' + fmt(portion.from) + '-' + fmt(portion.to) + ' are back.';
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
        await addPlaybackBoost(portion.from, portion.to, {
          gainDb: settings.gainDb || 0,
          highpassHz: settings.highpassHz || 0,
          normalize: Boolean(settings.normalize),
          denoise: Boolean(settings.denoise)
        });
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
