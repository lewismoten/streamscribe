// Speakers: who is talking when. The roster (names, roles, and circle-cropped face photos) is shared by every
// meeting from this source, in {source}/people/; when each set of speakers starts is kept per session, in
// {session}/speakers.json as turns ({ at: video position, speakers: [person ids] }). Both save through the local server.
let people = page.people;
let turns = page.turns;
const mapPeople = () => new Map(people.map((person) => [person.id, person]));
let peopleMap = mapPeople();
let lastSpeakerKey = null;
function turnIndexAt(seconds) {
  let found = -1;
  // A change counts from its own word only (it's saved at the word's time, to the hundredth): more slack would give a
  // quick word's speaker to the word before it, as in a roll call.
  for (let index = 0; index < turns.length && turns[index].at <= seconds + 0.05; index += 1) found = index;
  return found;
}
function speakersAt(seconds) {
  const index = turnIndexAt(seconds);
  return index < 0 ? [] : turns[index].speakers;
}
const photoUrl = (person) =>
  page.peopleUrl + '/' + encodeURIComponent(person.photo) + '?v=' + (person.photoVersion || 0);
const initialsOf = (name) =>
  String(name || '?')
    .split(' ')
    .filter(Boolean)
    .map((word) => word[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
// A name that isn't known (marked so, blank, or "Unknown") shows the person's role instead, or "Unknown".
const isNameUnknown = (person) =>
  Boolean(person?.nameUnknown) ||
  !String(person?.name || '').trim() ||
  /^unknown$/i.test(String(person?.name || '').trim());
const shownName = (person) => (!person ? 'Unknown' : isNameUnknown(person) ? person.role || 'Unknown' : person.name);
const nameAndRole = (person) =>
  isNameUnknown(person) ? shownName(person) : person.name + (person.role ? ', ' + person.role : '');
function avatar(person) {
  // A group entry (such as everyone reciting the Pledge together) shows its emoji instead of a photo.
  if (person?.icon) {
    const icon = document.createElement('span');
    icon.className = 'avatar icon';
    icon.textContent = person.icon;
    return icon;
  }
  if (person?.photo) {
    const image = document.createElement('img');
    image.className = 'avatar';
    image.alt = '';
    image.src = photoUrl(person);
    return image;
  }
  const initials = document.createElement('span');
  initials.className = 'avatar';
  initials.textContent = isNameUnknown(person) ? '?' : initialsOf(person?.name);
  return initials;
}
async function putFile(url, body, type) {
  if (location.protocol === 'file:') throw new Error('saving needs the local server (npm start)');
  const response = await fetch(url, { method: 'PUT', headers: { 'content-type': type }, body });
  if (!response.ok)
    throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
}
async function saveTurns() {
  try {
    await putFile(
      '../speakers.json',
      JSON.stringify({ updatedAt: new Date().toISOString(), turns }, null, 2),
      'application/json'
    );
    $('speakers-status').textContent = 'Saved';
  } catch (error) {
    $('speakers-status').textContent = 'Not saved: ' + error.message;
  }
}
// Sets who is speaking from the current position on. A change within a second of an existing one edits that one
// (so picking several people in a row makes one change), and a change that repeats the one before is dropped.
function setSpeakersNow(ids) {
  setSpeakersAt(Math.round(position * 10) / 10, ids, 1);
}
// Sets who is speaking from a moment on; a change within tolerance seconds of an existing one edits that one.
function setSpeakersAt(moment, ids, tolerance) {
  const at = Math.round(moment * 100) / 100;
  const existing = turns.find((turn) => Math.abs(turn.at - at) <= tolerance);
  if (existing) existing.speakers = ids;
  else turns.push({ at, speakers: ids });
  turns.sort((a, b) => a.at - b.at);
  turns = turns.filter((turn, index) => turn.speakers.join(',') !== (index ? turns[index - 1].speakers.join(',') : ''));
  speakersChanged();
  saveTurns();
}
function toggleSpeaker(id) {
  const current = speakersAt(position);
  setSpeakersNow(current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
}
function speakersChanged() {
  if (spokePerson && $('spoke-dialog').open) renderSpoke();
  if (pageReady) renderScrubMarks();
  lastSpeakerKey = null;
  updateSpeakerUi();
  renderTranscript();
}
// Groups of people (saved with the roster, so every meeting shares them). Voting members of this meeting come first.
let rosterGroups = Array.isArray(page.peopleGroups)
  ? page.peopleGroups
  : ['Elected officials', 'County staff', 'Residents', 'Vendors', 'Other organizations'];
// Starts as compact circles grouped side by side; Names shows the full details.
let peopleView = 'icons';
try {
  peopleView = localStorage.getItem('thumbnails.peopleLayout') === 'names' ? 'names' : 'icons';
} catch {}
function personChip(person, voting) {
  const chip = document.createElement('span');
  chip.className = 'person-chip';
  chip.draggable = true;
  chip.addEventListener('dragstart', (event) => {
    event.dataTransfer.setData('text/plain', JSON.stringify({ id: person.id, voting }));
    event.dataTransfer.effectAllowed = 'move';
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'person';
  button.dataset.id = person.id;
  button.title = nameAndRole(person) + (voting ? ' (votes in this meeting)' : '');
  const text = document.createElement('span');
  text.className = 'person-text';
  const name = document.createElement('strong');
  name.textContent = shownName(person);
  const role = document.createElement('small');
  role.textContent = isNameUnknown(person) ? 'name not known' : person.role || '';
  text.append(name, role);
  button.append(avatar(person), text);
  button.addEventListener('click', () => toggleSpeaker(person.id));
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'edit';
  edit.title = 'Edit ' + shownName(person);
  edit.textContent = '✎';
  edit.addEventListener('click', () => openPersonEditor(person));
  const times = document.createElement('button');
  times.type = 'button';
  times.className = 'times';
  times.title = 'When ' + shownName(person) + ' spoke';
  times.textContent = '🕑';
  times.addEventListener('click', () => openSpokeDialog(person.id));
  chip.append(button, times, edit);
  return chip;
}
// A section people can be dragged onto: target is { voting: true } or { group: name ('' for none) }.
function peopleSection(title, target, list, extras) {
  const section = document.createElement('section');
  section.className = 'people-section' + (target.voting ? ' voting' : '');
  const heading = document.createElement('h3');
  heading.append(...extras(title));
  const chips = document.createElement('div');
  chips.className = 'people-chips';
  list.forEach((person) => chips.appendChild(personChip(person, Boolean(target.voting))));
  section.append(heading, chips);
  section.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    section.classList.add('drop');
  });
  section.addEventListener('dragleave', (event) => {
    if (!section.contains(event.relatedTarget)) section.classList.remove('drop');
  });
  section.addEventListener('drop', (event) => {
    event.preventDefault();
    section.classList.remove('drop');
    let dragged = null;
    try {
      dragged = JSON.parse(event.dataTransfer.getData('text/plain'));
    } catch {}
    if (dragged?.id) dropPerson(dragged, target);
  });
  return section;
}
async function dropPerson(dragged, target) {
  const person = peopleMap.get(dragged.id);
  if (!person) return;
  const status = $('speakers-status');
  try {
    if (target.voting) {
      if (voteData.members.some((member) => member.id === person.id)) return;
      voteData.members = [...voteData.members, { id: person.id, leftAt: null, arrivedAt: null }];
      await saveVotes(shownName(person) + ' votes in this meeting');
      status.textContent = shownName(person) + ' votes in this meeting';
    } else {
      // Out of the voting members, into a group.
      if (dragged.voting) {
        voteData.members = voteData.members.filter((member) => member.id !== person.id);
        await saveVotes(shownName(person) + ' no longer votes in this meeting');
      }
      const list = await latestPeople();
      await savePeople(list.map((item) => (item.id === person.id ? { ...item, group: target.group } : item)));
      status.textContent = shownName(person) + (target.group ? ' is in ' + target.group : ' is not in a group');
    }
  } catch (error) {
    status.textContent = 'Not saved: ' + error.message;
  }
  renderPeople();
}
async function saveGroups(groups, list, done) {
  // Read the latest roster first: reading it also refreshes the saved group list, which must not replace the new one.
  const fresh = list || (await latestPeople());
  const before = rosterGroups;
  rosterGroups = groups;
  try {
    await savePeople(fresh);
    $('speakers-status').textContent = done;
  } catch (error) {
    rosterGroups = before;
    $('speakers-status').textContent = 'Not saved: ' + error.message;
  }
  renderPeople();
}
$('group-add').addEventListener('click', async () => {
  await latestPeople();
  const name = (prompt('Name of the new group (for example VDOT):') || '').trim();
  if (!name || rosterGroups.includes(name)) return;
  await saveGroups([...rosterGroups, name], null, 'Added the group ' + name);
});
function setPeopleView(view) {
  peopleView = view;
  try {
    localStorage.setItem('thumbnails.peopleLayout', view);
  } catch {}
  $('people').classList.toggle('icons-only', view === 'icons');
  $('people-names').classList.toggle('on', view === 'names');
  $('people-icons').classList.toggle('on', view === 'icons');
}
$('people-names').addEventListener('click', () => setPeopleView('names'));
$('people-icons').addEventListener('click', () => setPeopleView('icons'));
function renderPeople() {
  const box = $('people');
  box.textContent = '';
  setPeopleView(peopleView);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const memberIds = voteData.members.map((member) => member.id);
  const voting = memberIds.map((id) => peopleMap.get(id)).filter(Boolean);
  const others = people.filter((person) => !memberIds.includes(person.id));
  const label = (text) => {
    const span = document.createElement('span');
    span.textContent = text;
    return [span];
  };
  box.appendChild(peopleSection('🗳 Voting members', { voting: true }, voting, label));
  // Groups in their saved order, then any group someone has that isn't listed yet.
  const groups = [...rosterGroups];
  others.forEach((person) => {
    if (person.group && !groups.includes(person.group)) groups.push(person.group);
  });
  groups.forEach((group) => {
    const members = others.filter((person) => person.group === group).sort(byName);
    box.appendChild(
      peopleSection(group, { group }, members, (title) => {
        const name = document.createElement('span');
        name.className = 'group-name';
        name.textContent = title;
        name.title = 'Click to rename';
        name.addEventListener('click', async () => {
          const renamed = (prompt('Rename the group "' + title + '" to:', title) || '').trim();
          if (!renamed || renamed === title) return;
          const list = (await latestPeople()).map((person) =>
            person.group === title ? { ...person, group: renamed } : person
          );
          await saveGroups(
            rosterGroups.includes(title)
              ? rosterGroups.map((item) => (item === title ? renamed : item))
              : [...rosterGroups, renamed],
            list,
            'Renamed the group to ' + renamed
          );
        });
        const parts = [name];
        if (!members.length) {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = '✕';
          remove.title = 'Remove this empty group';
          remove.addEventListener('click', () =>
            saveGroups(
              rosterGroups.filter((item) => item !== title),
              null,
              'Removed the group ' + title
            )
          );
          parts.push(remove);
        }
        return parts;
      })
    );
  });
  box.appendChild(
    peopleSection('Not grouped', { group: '' }, others.filter((person) => !person.group).sort(byName), label)
  );
  $('people-empty').hidden = people.length > 0;
  lastSpeakerKey = null;
  updateSpeakerUi();
  // The voting member list and vote overlay show the same people.
  renderMembers();
  renderSeatOrder();
  voteOverlayKey = null;
  updateVoteOverlay();
}
function updateSpeakerUi() {
  $('speaker-remove').disabled = !turns.some((turn) => Math.abs(turn.at - position) <= 1);
  const index = turnIndexAt(position);
  const ids = index < 0 ? [] : turns[index].speakers;
  const key = index + ':' + ids.join(',');
  if (key === lastSpeakerKey) return;
  lastSpeakerKey = key;
  updateNowSpeakers(ids);
  document
    .querySelectorAll('#people .person')
    .forEach((button) => button.setAttribute('aria-pressed', ids.includes(button.dataset.id) ? 'true' : 'false'));
  const names = ids.map((id) => (peopleMap.get(id) ? shownName(peopleMap.get(id)) : id));
  $('speakers-now').textContent =
    (names.length ? names.join(', ') : 'nobody marked') + (index >= 0 ? ' (since ' + fmt(turns[index].at) + ')' : '');
  // Cards of people still speaking stay; new speakers' cards slide in (stacked upward from the first: the cards are a
  // column from the bottom, so a second speaker appears above and nobody goes off the video), and those who stopped
  // fade out.
  const cards = $('speaker-cards');
  const kept = new Map(
    [...cards.querySelectorAll('.speaker-card:not(.leaving)')].map((card) => [card.dataset.id, card])
  );
  kept.forEach((card, id) => {
    if (ids.includes(id)) return;
    card.classList.add('leaving');
    setTimeout(() => card.remove(), 300);
  });
  ids.forEach((id, order) => {
    if (kept.has(id)) {
      kept.get(id).style.order = String(order);
      return;
    }
    const person = peopleMap.get(id) || { id, name: id };
    const card = document.createElement('div');
    card.className = 'speaker-card entering';
    card.dataset.id = id;
    card.style.order = String(order);
    card.addEventListener('animationend', () => card.classList.remove('entering'), { once: true });
    const text = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = shownName(person);
    text.appendChild(name);
    if (person.role && !isNameUnknown(person)) {
      const role = document.createElement('small');
      role.textContent = person.role;
      text.appendChild(role);
    }
    card.append(avatar(person), text);
    cards.appendChild(card);
  });
}
$('speakers-toggle').addEventListener('click', () => {
  const panel = $('speakers-panel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderPeople();
});
$('speaker-none').addEventListener('click', () => setSpeakersNow([]));
$('speaker-remove').addEventListener('click', () => {
  const index = turns.findIndex((turn) => Math.abs(turn.at - position) <= 1);
  if (index < 0) return;
  turns.splice(index, 1);
  speakersChanged();
  saveTurns();
});
$('speaker-prev').addEventListener('click', () => {
  const previous = [...turns].reverse().find((turn) => turn.at < position - 0.5);
  if (previous) showPosition(previous.at);
});
$('speaker-next').addEventListener('click', () => {
  const next = turns.find((turn) => turn.at > position + 0.5);
  if (next) showPosition(next.at);
});
function setSpeakerOverlay(visible) {
  $('show-speakers').checked = visible;
  $('speaker-cards').hidden = !visible;
  try {
    localStorage.setItem('thumbnails.showSpeakers', visible ? '1' : '0');
  } catch {}
}
$('show-speakers').addEventListener('change', () => setSpeakerOverlay($('show-speakers').checked));
try {
  if (localStorage.getItem('thumbnails.showSpeakers') === '1') setSpeakerOverlay(true);
} catch {}
