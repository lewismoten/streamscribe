// Playlist: clips (from the ✂⟦ ⟧✂ marks) collected one after another, saved in {session}/playlist.json. They can be
// played in a row, joined into one video by the server (render-playlist), or downloaded as text or captions timed
// to that video.
let playlist = [];
let playlistPlaying = -1;
const playlistRanges = () => playlist.map((clip) => ({ title: clip.title, from: clip.from, to: clip.to }));
async function savePlaylist(done) {
  renderPlaylist();
  try {
    await putFile('../playlist.json', JSON.stringify({ updatedAt: new Date().toISOString(), clips: playlist }, null, 2), 'application/json');
    $('playlist-status').textContent = done;
  } catch (error) {
    $('playlist-status').textContent = 'Not saved: ' + error.message;
  }
}
function renderPlaylist() {
  const list = $('playlist-list');
  list.textContent = '';
  playlist.forEach((clip, index) => {
    const row = document.createElement('li');
    if (index === playlistPlaying) row.classList.add('current');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.title = 'Go to this clip (and mark it with the cut marks)';
    const when = document.createElement('time');
    when.textContent = fmt(clip.from) + '–' + fmt(clip.to);
    const title = document.createElement('span');
    title.className = 'chapter-title';
    title.textContent = (index + 1) + '. ' + clip.title;
    const length = document.createElement('span');
    length.className = 'chapter-length';
    length.textContent = fmt(clip.to - clip.from);
    go.append(when, title, length);
    go.addEventListener('click', () => { start = clip.from; end = clip.to; update(); renderCutMarks(); showPosition(clip.from); });
    const button = (text, label, action, disabled = false) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'small';
      element.textContent = text;
      element.title = label;
      element.disabled = disabled;
      element.addEventListener('click', action);
      return element;
    };
    const move = (step) => {
      const moved = [...playlist];
      const [item] = moved.splice(index, 1);
      moved.splice(index + step, 0, item);
      playlist = moved;
      savePlaylist('Moved');
    };
    row.append(go,
      button('↑', 'Move up', () => move(-1), index === 0),
      button('↓', 'Move down', () => move(1), index === playlist.length - 1),
      button('✎', 'Rename', () => {
        const name = (prompt('Clip name:', clip.title) || '').trim();
        if (name) { clip.title = name; savePlaylist('Renamed'); }
      }),
      button('✕', 'Remove from the playlist', () => { playlist = playlist.filter((other) => other !== clip); savePlaylist('Removed'); }));
    list.appendChild(row);
  });
  const total = playlist.reduce((sum, clip) => sum + (clip.to - clip.from), 0);
  $('playlist-total').textContent = playlist.length ? playlist.length + ' clip' + (playlist.length === 1 ? '' : 's') + ', ' + fmt(total) : '';
  $('playlist-empty').hidden = playlist.length > 0;
  ['playlist-play', 'playlist-video', 'playlist-text', 'playlist-captions'].forEach((id) => { $(id).disabled = playlist.length === 0; });
}
function setPlaylistShown(shown) {
  $('playlist-panel').hidden = !shown;
  $('playlist-toggle').setAttribute('aria-pressed', shown ? 'true' : 'false');
  try { localStorage.setItem('thumbnails.playlistShown', shown ? '1' : '0'); } catch {}
}
$('playlist-toggle').addEventListener('click', () => setPlaylistShown($('playlist-panel').hidden));
try { setPlaylistShown(localStorage.getItem('thumbnails.playlistShown') === '1'); } catch {}
$('playlist-add').addEventListener('click', () => {
  if (start === null || end === null || !(end > start)) {
    $('snapshot-status').textContent = 'Mark the clip first: ✂⟦ where it starts and ⟧✂ where it ends';
    return;
  }
  // Named after its chapter, or else the first words said in it.
  const chapter = agendaIndexAt(start + 0.01);
  const firstWords = wordsIn({ from: start, to: end }).slice(0, 8).map((word) => word.text).join(' ');
  const title = chapter >= 0 ? agendaItems[chapter].title : (firstWords || 'Clip at ' + fmt(start));
  playlist = [...playlist, { id: Date.now().toString(36), from: Number(start.toFixed(3)), to: Number(end.toFixed(3)), title }];
  setPlaylistShown(true);
  savePlaylist('Added ' + fmt(start) + '–' + fmt(end) + ' as clip ' + playlist.length);
  $('snapshot-status').textContent = 'Added to the playlist as clip ' + playlist.length + '; mark the next one';
});
// Play all: each clip in turn, moving on when one ends.
$('playlist-play').addEventListener('click', async () => {
  if (!playlist.length) return;
  playlistPlaying = 0;
  renderPlaylist();
  showPosition(playlist[0].from);
  if (video.paused) await togglePlay();
});
video.addEventListener('timeupdate', () => {
  if (playlistPlaying < 0) return;
  const clip = playlist[playlistPlaying];
  const now = toPosition(video.currentTime);
  if (!clip) { playlistPlaying = -1; return; }
  if (now < clip.from - 1 || now > clip.to + 2) { playlistPlaying = -1; renderPlaylist(); return; } // moved elsewhere
  if (now >= clip.to) {
    playlistPlaying += 1;
    if (playlistPlaying >= playlist.length) { playlistPlaying = -1; video.pause(); } else showPosition(playlist[playlistPlaying].from);
    renderPlaylist();
  }
});
$('playlist-text').addEventListener('click', () => {
  const NL = String.fromCharCode(10);
  const lines = [meetingName || document.title || 'Meeting', 'Playlist: ' + playlist.length + ' clips, ' + fmt(playlist.reduce((sum, clip) => sum + (clip.to - clip.from), 0)), ''];
  playlistRanges().forEach((range, index) => {
    lines.push('== Clip ' + (index + 1) + ': ' + range.title + ' (' + fmt(range.from) + '–' + fmt(range.to) + ') ==', '');
    lines.push(...transcriptLines(range, false), '');
  });
  downloadFile((meetingName || 'transcript') + ' - playlist.txt', lines.join(NL) + NL, 'text/plain;charset=utf-8');
});
$('playlist-captions').addEventListener('click', () => {
  downloadFile((meetingName || 'transcript') + ' - playlist.srt', captionsFor(playlistRanges()), 'application/x-subrip;charset=utf-8');
});
$('playlist-video').addEventListener('click', async () => {
  const button = $('playlist-video');
  button.disabled = true;
  try {
    if (location.protocol === 'file:') throw new Error('this needs the local server (npm start)');
    $('playlist-status').textContent = 'Asking the server to join the clips…';
    const response = await fetch('../render-playlist', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clips: playlist.map(({ from, to }) => ({ from, to })) }) });
    if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
    const started = await response.json();
    const startedAt = Date.now();
    const job = await new Promise((resolve, reject) => {
      const check = async () => {
        const state = await fetch('../' + started.statusUrl, { cache: 'no-store' }).then((reply) => (reply.ok ? reply.json() : null)).catch(() => null);
        if (state?.status === 'done') { resolve(state); return; }
        if (state?.status === 'failed') { reject(new Error(state.message || 'the job failed')); return; }
        if (state?.message) $('playlist-status').textContent = state.message + ' (' + Math.round((Date.now() - startedAt) / 1000) + 's)';
        setTimeout(check, 1500);
      };
      setTimeout(check, 700);
    });
    const link = document.createElement('a');
    link.href = '../' + job.file.split('/').map(encodeURIComponent).join('/');
    link.download = ((meetingName || 'meeting') + ' - playlist.mp4').replace(/[^a-zA-Z0-9 ,.()-]+/g, '').trim();
    document.body.appendChild(link);
    link.click();
    link.remove();
    $('playlist-status').textContent = job.message + ' — downloading (also saved in the session folder as ' + job.file + ')';
  } catch (error) {
    $('playlist-status').textContent = 'Could not make the video: ' + error.message;
  } finally {
    button.disabled = playlist.length === 0;
  }
});
if (location.protocol !== 'file:') {
  fetch('../playlist.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (Array.isArray(data?.clips)) { playlist = data.clips; renderPlaylist(); }
  }).catch(() => {});
}
renderPlaylist();

