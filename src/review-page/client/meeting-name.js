// Edits text on the video in place: Enter (or clicking elsewhere) saves, Escape cancels.
let inlineEditing = false;
function inlineEdit(element, current, save) {
  if (inlineEditing) return;
  inlineEditing = true;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'inline-edit';
  input.value = current;
  element.classList.remove('editable-text');
  element.textContent = '';
  element.appendChild(input);
  let done = false;
  const finish = async (keep) => {
    if (done) return;
    done = true;
    inlineEditing = false;
    element.classList.add('editable-text');
    const value = input.value.trim();
    if (keep && value !== current) await save(value);
    else element.textContent = current;
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('blur', () => finish(true));
  input.focus();
  input.select();
}
// Meeting name: the page title and, with "Show meeting name", on the video, where clicking it edits it. Saved to
// {session}/meeting-info.json through the local server.
let meetingName = page.meetingName;
function showMeetingName(name) {
  meetingName = name;
  document.title = name || 'Meeting Thumbnails';
  // Without a name yet, a placeholder on the video is what gets clicked to name the meeting.
  if (!inlineEditing) $('title-overlay').textContent = name || 'Meeting name';
  $('title-overlay').classList.toggle('placeholder', !name);
  $('title-overlay').hidden = !$('show-name').checked;
  stackChapter();
}
// The rest of meeting-info.json (such as the meeting's official sources, set in the hub's web app) is kept.
let meetingInfo = {};
async function saveMeetingName(name) {
  try {
    if (location.protocol === 'file:') throw new Error('saving needs the local server (npm start)');
    const response = await fetch('../meeting-info.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...meetingInfo, name, updatedAt: new Date().toISOString() }, null, 2) });
    meetingInfo = { ...meetingInfo, name };
    if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
    showMeetingName(name);
    $('snapshot-status').textContent = 'Saved the meeting name';
    return true;
  } catch (error) {
    showMeetingName(meetingName);
    $('snapshot-status').textContent = 'Meeting name not saved: ' + error.message;
    return false;
  }
}
$('title-overlay').classList.add('editable-text');
$('title-overlay').title = 'Click to edit the meeting name';
$('title-overlay').addEventListener('click', (event) => {
  event.stopPropagation();
  inlineEdit($('title-overlay'), meetingName, saveMeetingName);
});
function setShowName(visible) {
  $('show-name').checked = visible;
  try { localStorage.setItem('thumbnails.showName', visible ? '1' : '0'); } catch {}
  showMeetingName(meetingName);
}
$('show-name').addEventListener('change', () => setShowName($('show-name').checked));
try { if (localStorage.getItem('thumbnails.showName') === '1') $('show-name').checked = true; } catch {}
showMeetingName(meetingName);
