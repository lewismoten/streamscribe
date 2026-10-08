// Agenda: items that start at video positions ({session}/agenda.json, saved through the local server). They are
// listed under the video (click to jump) and shown as headings in the transcript.
let agendaItems = [...page.agenda].sort((left, right) => left.at - right.at);
let agendaEditing = null;
let agendaCurrent = -2;
function agendaIndexAt(seconds) {
  let found = -1;
  agendaItems.forEach((item, index) => { if (item.at <= seconds + 0.25) found = index; });
  return found;
}
function updateAgendaCurrent() {
  const index = agendaIndexAt(position);
  if (index === agendaCurrent) return;
  agendaCurrent = index;
  [...$('agenda-list').children].forEach((item, itemIndex) => item.classList.toggle('current', itemIndex === index));
  // Keep the current item in view inside the list (without scrolling the page).
  const current = $('agenda-list').children[index];
  if (current) {
    const list = $('agenda-list');
    if (current.offsetTop < list.scrollTop || current.offsetTop + current.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTo({ top: Math.max(0, current.offsetTop - list.clientHeight / 3), behavior: 'smooth' });
    }
  }
  // The item being played, on the video (under the meeting name) when "Show agenda item" is checked.
  const overlay = $('agenda-overlay');
  if (!inlineEditing) overlay.textContent = index < 0 ? '' : agendaItems[index].title;
  overlay.hidden = !$('show-agenda').checked || index < 0;
  stackChapter();
}
$('agenda-overlay').classList.add('editable-text');
$('agenda-overlay').title = 'Click to edit this chapter title';
$('agenda-overlay').addEventListener('click', (event) => {
  event.stopPropagation();
  const item = agendaItems[agendaCurrent];
  if (!item) return;
  inlineEdit($('agenda-overlay'), item.title, async (title) => {
    if (!title) { $('agenda-overlay').textContent = item.title; return; }
    await changeAgenda(agendaItems.map((other) => (other.id === item.id ? { ...other, title } : other)), 'Saved');
    agendaCurrent = -2;
    updateAgendaCurrent();
  });
});
function setShowAgenda(visible) {
  $('show-agenda').checked = visible;
  try { localStorage.setItem('thumbnails.showAgenda', visible ? '1' : '0'); } catch {}
  agendaCurrent = -2;
  updateAgendaCurrent();
}
$('show-agenda').addEventListener('change', () => setShowAgenda($('show-agenda').checked));
try { if (localStorage.getItem('thumbnails.showAgenda') === '1') $('show-agenda').checked = true; } catch {}
function renderAgenda() {
  const list = $('agenda-list');
  list.textContent = '';
  agendaItems.forEach((item) => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    go.title = 'Go to ' + fmt(item.at);
    const when = document.createElement('time');
    when.textContent = fmt(item.at);
    const title = document.createElement('span');
    title.className = 'chapter-title';
    title.textContent = item.title;
    // How long it runs: to the next chapter, or the end of the video.
    const next = agendaItems[agendaItems.indexOf(item) + 1];
    const length = document.createElement('span');
    length.className = 'chapter-length';
    length.textContent = fmt((next ? next.at : endSeconds) - item.at);
    length.title = 'Length of this chapter';
    go.append(when, title, length);
    go.addEventListener('click', () => showPosition(item.at));
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'small';
    save.title = 'Download this chapter’s transcript as text';
    save.textContent = '⬇';
    save.addEventListener('click', () => downloadTranscript(chapterRange(item)));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'small';
    edit.title = 'Edit';
    edit.textContent = '✎';
    edit.addEventListener('click', () => startAgendaEdit(item));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'small';
    remove.title = 'Remove';
    remove.textContent = '✕';
    remove.addEventListener('click', async () => {
      if (!confirm('Remove the chapter "' + item.title + '"?')) return;
      await changeAgenda(agendaItems.filter((other) => other.id !== item.id), 'Removed');
    });
    row.append(go, save, edit, remove);
    list.appendChild(row);
  });
  $('agenda-empty').hidden = agendaItems.length > 0;
  agendaCurrent = -2;
  updateAgendaCurrent();
  sliderRangeKey = '';
  updateSliderRange();
  slider.value = position;
}
async function changeAgenda(items, done) {
  const previous = agendaItems;
  agendaItems = [...items].sort((left, right) => left.at - right.at);
  try {
    if (location.protocol === 'file:') throw new Error('saving needs the local server (npm start)');
    const response = await fetch('../agenda.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updatedAt: new Date().toISOString(), items: agendaItems }, null, 2) });
    if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
    $('agenda-status').textContent = done;
    renderAgenda();
    renderTranscript();
    return true;
  } catch (error) {
    agendaItems = previous;
    $('agenda-status').textContent = 'Not saved: ' + error.message;
    return false;
  }
}
function startAgendaEdit(item) {
  agendaEditing = item;
  $('agenda-time').value = fmtPrecise(item.at);
  $('agenda-title-input').value = item.title;
  $('agenda-save').textContent = 'Save';
  $('agenda-cancel').hidden = false;
  $('agenda-status').textContent = '';
  $('agenda-title-input').focus();
}
function resetAgendaForm() {
  agendaEditing = null;
  $('agenda-title-input').value = '';
  $('agenda-time').value = '';
  $('agenda-save').textContent = 'Add';
  $('agenda-cancel').hidden = true;
}
$('agenda-now').addEventListener('click', () => { $('agenda-time').value = fmtPrecise(position); });
$('agenda-cancel').addEventListener('click', resetAgendaForm);
$('agenda-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const title = $('agenda-title-input').value.trim();
  // An empty time means the current position.
  const at = $('agenda-time').value.trim() ? parse($('agenda-time').value) : position;
  if (!title) { $('agenda-status').textContent = 'Enter a title'; return; }
  if (at === null || at < 0 || at > endSeconds) { $('agenda-status').textContent = 'Enter a time between 00:00:00 and ' + fmt(endSeconds); return; }
  const item = { id: agendaEditing ? agendaEditing.id : Date.now().toString(36), at: Number(at.toFixed(3)), title };
  const items = agendaEditing ? agendaItems.map((other) => (other.id === agendaEditing.id ? item : other)) : [...agendaItems, item];
  if (await changeAgenda(items, (agendaEditing ? 'Saved ' : 'Added ') + fmt(item.at))) resetAgendaForm();
});
renderAgenda();
// Toolbar: show or hide the chapters, and jump between them.
function setChaptersShown(shown) {
  $('agenda-panel').hidden = !shown;
  $('chapters-toggle').setAttribute('aria-pressed', shown ? 'true' : 'false');
  try { localStorage.setItem('thumbnails.chaptersShown', shown ? '1' : '0'); } catch {}
}
$('chapters-toggle').addEventListener('click', () => setChaptersShown($('agenda-panel').hidden));
try { setChaptersShown(localStorage.getItem('thumbnails.chaptersShown') !== '0'); } catch { setChaptersShown(true); }
$('chapter-prev').addEventListener('click', () => {
  // To the start of this chapter, or the one before when already at its start.
  const previous = [...agendaItems].reverse().find((item) => item.at < position - 1.5);
  showPosition(previous ? previous.at : 0);
});
$('chapter-next').addEventListener('click', () => {
  const next = agendaItems.find((item) => item.at > position + 0.5);
  if (next) showPosition(next.at);
});
