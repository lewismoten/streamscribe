// Person editor: name, role, and a face photo cropped with a circle from the paused video frame (full resolution).
let editing = null;
let cropFrame = null;
let removePhoto = false;
const crop = { x: 0, y: 0, r: 0 };
const cropCanvas = $('crop-canvas');
function openPersonEditor(person) {
  editing = person || null;
  $('person-title').textContent = person ? 'Edit ' + shownName(person) : 'Add a person';
  $('person-unknown').checked = Boolean(person) && isNameUnknown(person);
  $('person-name').value = person && !isNameUnknown(person) ? person.name : '';
  removePhoto = false;
  $('person-role').value = person?.role || '';
  $('person-group').value = person?.group || '';
  $('person-icon').value = person?.icon || '';
  $('group-list').textContent = '';
  rosterGroups.forEach((group) => {
    const option = document.createElement('option');
    option.value = group;
    $('group-list').appendChild(option);
  });
  $('person-status').textContent = '';
  $('person-delete').hidden = !person;
  cropFrame = null;
  cropCanvas.hidden = true;
  $('person-photo').hidden = !person?.photo;
  if (person?.photo) $('person-photo').src = photoUrl(person);
  $('person-dialog').showModal();
  if (!person) captureForCrop();
}
async function captureForCrop() {
  const status = $('person-status');
  try {
    status.textContent = 'Getting the current frame...';
    if (!playerReady) {
      await initPlayer();
      setStatus('Play');
      $('play').disabled = false;
    }
    if (!video.paused) video.pause();
    await waitForFrame(15000);
    cropFrame = document.createElement('canvas');
    cropFrame.width = video.videoWidth;
    cropFrame.height = video.videoHeight;
    cropFrame.getContext('2d').drawImage(video, 0, 0);
    cropCanvas.width = cropFrame.width;
    cropCanvas.height = cropFrame.height;
    // Keep the last circle (the next person is often in the same spot on the same camera).
    if (!crop.r || crop.x > cropFrame.width || crop.y > cropFrame.height) {
      crop.x = cropFrame.width / 2;
      crop.y = cropFrame.height / 3;
      crop.r = Math.round(cropFrame.height / 8);
    }
    $('crop-size').max = Math.round(cropFrame.height / 2);
    $('crop-size').value = crop.r;
    cropCanvas.hidden = false;
    $('person-photo').hidden = true;
    drawCrop();
    status.textContent = '';
  } catch (error) {
    status.textContent = 'No photo: ' + error.message;
  }
}
function drawCrop() {
  if (!cropFrame) return;
  const context = cropCanvas.getContext('2d');
  context.drawImage(cropFrame, 0, 0);
  context.beginPath();
  context.rect(0, 0, cropCanvas.width, cropCanvas.height);
  context.arc(crop.x, crop.y, crop.r, 0, Math.PI * 2);
  context.fillStyle = 'rgba(0, 0, 0, 0.6)';
  context.fill('evenodd');
  context.beginPath();
  context.arc(crop.x, crop.y, crop.r, 0, Math.PI * 2);
  context.lineWidth = Math.max(2, cropCanvas.width / 400);
  context.strokeStyle = '#ffffff';
  context.stroke();
}
function cropPoint(event) {
  const rect = cropCanvas.getBoundingClientRect();
  const scale = cropCanvas.width / rect.width;
  return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale };
}
function moveCrop(x, y) {
  crop.x = Math.max(0, Math.min(cropCanvas.width, x));
  crop.y = Math.max(0, Math.min(cropCanvas.height, y));
  drawCrop();
}
function resizeCrop(radius) {
  crop.r = Math.round(Math.max(16, Math.min(cropCanvas.height / 2, radius)));
  $('crop-size').value = crop.r;
  drawCrop();
}
let dragFrom = null;
cropCanvas.addEventListener('pointerdown', (event) => {
  const point = cropPoint(event);
  // Outside the circle: put it there first, then drag from there.
  if (Math.hypot(point.x - crop.x, point.y - crop.y) > crop.r) moveCrop(point.x, point.y);
  dragFrom = { pointX: point.x, pointY: point.y, x: crop.x, y: crop.y };
  cropCanvas.setPointerCapture(event.pointerId);
});
cropCanvas.addEventListener('pointermove', (event) => {
  if (!dragFrom) return;
  const point = cropPoint(event);
  moveCrop(dragFrom.x + point.x - dragFrom.pointX, dragFrom.y + point.y - dragFrom.pointY);
});
cropCanvas.addEventListener('pointerup', () => {
  dragFrom = null;
});
cropCanvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    resizeCrop(crop.r * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
  },
  { passive: false }
);
$('crop-size').addEventListener('input', () => resizeCrop(Number($('crop-size').value)));
$('crop-capture').addEventListener('click', () => {
  removePhoto = false;
  captureForCrop();
});
$('photo-none').addEventListener('click', () => {
  removePhoto = true;
  cropFrame = null;
  cropCanvas.hidden = true;
  $('person-photo').hidden = true;
  $('person-status').textContent = 'No photo: they will show as initials (or ? when the name is not known).';
});
$('person-cancel').addEventListener('click', () => $('person-dialog').close());
$('person-add').addEventListener('click', () => openPersonEditor(null));

async function latestPeople() {
  // Start from the saved roster, so people added from another meeting's page aren't lost.
  const roster = await fetch(page.peopleUrl + '/people.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  if (Array.isArray(roster?.groups)) rosterGroups = roster.groups;
  return roster?.people || people;
}
async function savePeople(list) {
  await putFile(
    page.peopleUrl + '/people.json',
    JSON.stringify({ updatedAt: new Date().toISOString(), groups: rosterGroups, people: list }, null, 2),
    'application/json'
  );
  people = list;
  peopleMap = mapPeople();
}
function uniqueId(name, list) {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'person';
  let id = base;
  for (let count = 2; list.some((person) => person.id === id); count += 1) id = base + '-' + count;
  return id;
}
$('person-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('person-status');
  const name = $('person-name').value.trim();
  const unknown = $('person-unknown').checked || /^unknown$/i.test(name);
  if (!name && !unknown) {
    status.textContent = 'Enter a name, or check Name not known';
    return;
  }
  if (unknown && !$('person-role').value.trim()) {
    status.textContent = 'Enter a role (it shows in place of the name)';
    return;
  }
  $('person-save').disabled = true;
  status.textContent = 'Saving...';
  try {
    const list = await latestPeople();
    const isNew = !editing;
    const person = editing
      ? { ...(list.find((item) => item.id === editing.id) || editing) }
      : { id: uniqueId(unknown ? 'unknown ' + $('person-role').value.trim() : name, list) };
    person.name = unknown && /^unknown$/i.test(name) ? '' : name;
    person.nameUnknown = unknown;
    person.role = $('person-role').value.trim();
    person.group = $('person-group').value.trim();
    person.icon = $('person-icon').value.trim();
    if (!person.icon) delete person.icon;
    if (person.group && !rosterGroups.includes(person.group)) rosterGroups = [...rosterGroups, person.group];
    if (cropFrame) {
      const size = 256;
      const output = document.createElement('canvas');
      output.width = size;
      output.height = size;
      const context = output.getContext('2d');
      context.beginPath();
      context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      context.clip();
      context.drawImage(cropFrame, crop.x - crop.r, crop.y - crop.r, crop.r * 2, crop.r * 2, 0, 0, size, size);
      const blob = await new Promise((resolve) => output.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('the browser could not encode the photo');
      await putFile(page.peopleUrl + '/' + person.id + '.png', blob, 'image/png');
      person.photo = person.id + '.png';
      person.photoVersion = Date.now();
      person.photoFrom = { session: page.sessionArg, positionSeconds: Number(position.toFixed(3)) };
    }
    if (removePhoto && !cropFrame) {
      delete person.photo;
      delete person.photoVersion;
      delete person.photoFrom;
    }
    person.updatedAt = new Date().toISOString();
    await savePeople([...list.filter((item) => item.id !== person.id), person]);
    $('person-dialog').close();
    renderPeople();
    // Someone just added is usually the one speaking.
    if (isNew) toggleSpeaker(person.id);
    else speakersChanged();
  } catch (error) {
    status.textContent = 'Not saved: ' + error.message;
  } finally {
    $('person-save').disabled = false;
  }
});
$('person-delete').addEventListener('click', async () => {
  if (
    !editing ||
    !confirm('Remove ' + editing.name + ' from the list of people? Their marks in meetings stay, shown by id.')
  )
    return;
  try {
    await savePeople((await latestPeople()).filter((item) => item.id !== editing.id));
    $('person-dialog').close();
    renderPeople();
    speakersChanged();
  } catch (error) {
    $('person-status').textContent = 'Not removed: ' + error.message;
  }
});
// Clicking a face clips that person's whole stretch: from the change where they started speaking to the change
// where they stopped (consecutive changes they stay part of, such as someone else joining in, count as one).
// Then it opens Boost & re-transcribe for that range.
function clipSpeaker(id, seconds) {
  const index = turnIndexAt(seconds);
  if (index < 0 || !turns[index].speakers.includes(id)) return;
  let first = index;
  while (first > 0 && turns[first - 1].speakers.includes(id)) first -= 1;
  let last = index;
  while (last + 1 < turns.length && turns[last + 1].speakers.includes(id)) last += 1;
  start = turns[first].at;
  end = last + 1 < turns.length ? turns[last + 1].at : endSeconds;
  update();
  showPosition(start);
  const person = peopleMap.get(id);
  $('boost-open').click();
  $('boost-status').textContent =
    'Clip set to ' +
    (person ? shownName(person) : id) +
    ' speaking, ' +
    fmt(start) +
    '-' +
    fmt(end) +
    '. Close this to keep the clip for extracting instead.';
}
