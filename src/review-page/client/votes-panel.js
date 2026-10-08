// Voting members.
function renderMembers() {
  const list = $('member-list');
  list.textContent = '';
  if (!people.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No people yet; add them with 🗣️ Speakers.';
    list.appendChild(empty);
    return;
  }
  [...people]
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((person) => {
      const member = voteData.members.find((item) => item.id === person.id);
      const row = document.createElement('li');
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(member);
      box.addEventListener('change', () => {
        voteData.members = box.checked
          ? [...voteData.members, { id: person.id, leftAt: null, arrivedAt: null }]
          : voteData.members.filter((item) => item.id !== person.id);
        saveVotes(
          box.checked ? shownName(person) + ' votes in this meeting' : shownName(person) + ' no longer listed as voting'
        );
      });
      const name = document.createElement('span');
      name.textContent = nameAndRole(person);
      label.append(box, avatar(person), name);
      row.appendChild(label);
      if (member) {
        const moment = (field, verb) => {
          if (member[field] !== null && member[field] !== undefined) {
            const note = document.createElement('span');
            note.className = 'label';
            note.textContent = verb + ' ' + fmt(member[field]);
            const clear = document.createElement('button');
            clear.type = 'button';
            clear.title = 'Clear';
            clear.textContent = '✕';
            clear.addEventListener('click', () => {
              member[field] = null;
              saveVotes('Cleared');
            });
            row.append(note, clear);
          } else {
            const mark = document.createElement('button');
            mark.type = 'button';
            mark.textContent = verb[0].toUpperCase() + verb.slice(1) + ' here';
            mark.title =
              verb === 'left'
                ? 'They left the meeting at the current position'
                : 'They arrived at the current position';
            mark.addEventListener('click', () => {
              member[field] = Number(position.toFixed(1));
              saveVotes(shownName(person) + ' ' + verb + ' at ' + fmt(position));
            });
            row.appendChild(mark);
          }
        };
        moment('leftAt', 'left');
        moment('arrivedAt', 'arrived');
      }
      list.appendChild(row);
    });
}
// Left-to-right order of the voting members (the overlay and roll call follow it).
function renderSeatOrder() {
  const list = $('seat-order');
  list.textContent = '';
  voteData.members.forEach((member, index) => {
    const person = peopleMap.get(member.id) || { id: member.id, name: member.id };
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = lastName(person);
    const district = document.createElement('small');
    district.textContent = districtOf(person) || ' ';
    const buttons = document.createElement('div');
    const move = (delta, label) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.title = delta < 0 ? 'Move left' : 'Move right';
      button.disabled = index + delta < 0 || index + delta >= voteData.members.length;
      button.addEventListener('click', () => {
        const members = [...voteData.members];
        [members[index], members[index + delta]] = [members[index + delta], members[index]];
        voteData.members = members;
        saveVotes('Saved the seating order');
      });
      buttons.appendChild(button);
    };
    move(-1, '◀');
    move(1, '▶');
    item.append(avatar(person), name, district, buttons);
    list.appendChild(item);
  });
  if (!voteData.members.length) list.textContent = 'Check the voting members above first.';
}
function showVoteRule() {
  const rule = voteRule(voteData.members.length);
  $('vote-seats').value = voteData.seats ?? '';
  $('vote-needed').value = voteData.needed ?? '';
  $('vote-seats').placeholder = String(voteData.members.length || 'auto');
  $('vote-needed').placeholder = String(Math.floor(rule.seats / 2) + 1);
  $('vote-rule').textContent =
    'A motion passes once ' +
    rule.needed +
    ' vote aye; it fails once nays and absences reach ' +
    rule.failAt +
    ', or when everyone has voted without ' +
    rule.needed +
    ' ayes.';
}
for (const field of ['seats', 'needed']) {
  $('vote-' + field).addEventListener('change', () => {
    const value = Number($('vote-' + field).value);
    voteData[field] = Number.isInteger(value) && value > 0 ? value : null;
    showVoteRule();
    saveVotes('Saved the voting rule');
  });
}
$('members-toggle').addEventListener('click', () => {
  $('members-panel').hidden = !$('members-panel').hidden;
  renderMembers();
});

// Vote editor: a working copy of the roll call, saved with Save.
let voteEditing = null;
let editChanges = [];
let editVote = { at: 0, results: {} };
function renderVoteMembers() {
  const box = $('vote-members');
  box.textContent = '';
  editVote.at = parse($('vote-time').value) ?? position;
  const ids = voterIds(editVote, editChanges);
  if (!ids.length) {
    box.textContent = 'No voting members yet: check them under Voting members.';
    updateVoteTally();
    return;
  }
  ids.forEach((id) => {
    const person = peopleMap.get(id) || { id, name: id };
    const status = statusAt(editVote, id, position, editChanges);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vote-toggle choice-' + status;
    button.title = 'Click to record ' + shownName(person) + "'s vote at " + fmt(position);
    const name = document.createElement('span');
    name.textContent = lastName(person);
    const label = document.createElement('strong');
    label.textContent = choiceNames[status];
    const history = document.createElement('small');
    history.textContent =
      editChanges
        .filter((change) => change.id === id)
        .sort((a, b) => a.at - b.at)
        .map((change) => choiceNames[change.choice] + ' ' + fmt(change.at))
        .join(', ') || 'no votes recorded';
    button.append(avatar(person), name, label, history);
    button.addEventListener('click', () => toggleVote(id));
    box.appendChild(button);
  });
  updateVoteTally();
}
// Records a member's vote at the current moment: the next status after the one they have now. A click within two
// seconds of their last change changes that entry instead (cycling back to "not voted" removes it).
function toggledChanges(vote, changes, id, seconds) {
  const at = Number(seconds.toFixed(2));
  let next = [...changes];
  const last = next
    .filter((change) => change.id === id)
    .sort((a, b) => a.at - b.at)
    .at(-1);
  if (last && Math.abs(last.at - at) <= 2) {
    const choice = cycle[(cycle.indexOf(last.choice) + 1) % cycle.length];
    next = next.filter((change) => change !== last);
    if (choice !== 'pending') next.push({ id, choice, at: last.at });
  } else {
    const current = statusAt(vote, id, at, next);
    const choice = cycle[(cycle.indexOf(current) + 1) % cycle.length];
    next.push({ id, choice: choice === 'pending' ? 'absent' : choice, at });
  }
  return next.sort((a, b) => a.at - b.at);
}
function toggleVote(id) {
  editChanges = toggledChanges(editVote, editChanges, id, position);
  renderVoteMembers();
  voteOverlayKey = null;
  updateVoteOverlay();
}
function updateVoteTally() {
  const draft = { ...editVote, outcome: $('vote-outcome').value };
  $('vote-tally').textContent =
    'At ' +
    fmt(position) +
    ': ' +
    describeTally(draft, position, editChanges) +
    '. Final: ' +
    describeTally(draft, Infinity, editChanges) +
    '.';
}
function openVoteEditor(vote) {
  voteEditing = vote || null;
  const at = vote ? vote.at : position;
  editChanges = vote ? voteChanges(vote).map((change) => ({ ...change })) : [];
  editVote = { at, results: vote?.results || {} };
  $('vote-dialog-title').textContent = vote ? 'Edit vote' : 'Record a vote';
  $('vote-time').value = fmtPrecise(at);
  $('vote-show').value = vote?.showSeconds || 20;
  $('vote-motion').value = vote ? vote.motion || 'Motion' : 'Motion';
  $('vote-outcome').value = vote?.outcome || 'auto';
  $('vote-delete').hidden = !vote;
  $('vote-dialog-status').textContent = '';
  renderVoteMembers();
  fillMotionPeople(vote);
  // Not modal: the video can be played and scrubbed through the roll call while this is open.
  if ($('vote-dialog').open) $('vote-dialog').close();
  $('vote-dialog').show();
  voteOverlayKey = null;
  updateVoteOverlay();
}
$('vote-add').addEventListener('click', () => openVoteEditor(null));
$('vote-now').addEventListener('click', () => {
  $('vote-time').value = fmtPrecise(position);
  renderVoteMembers();
});
$('vote-time').addEventListener('change', renderVoteMembers);
$('vote-outcome').addEventListener('change', updateVoteTally);
$('vote-all-for').addEventListener('click', () => {
  const at = Number(position.toFixed(2));
  voterIds(editVote, editChanges).forEach((id) => {
    const member = voteData.members.find((item) => item.id === id);
    if (member && !memberPresent(member, at)) return;
    if (statusAt(editVote, id, at, editChanges) !== 'for') editChanges.push({ id, choice: 'for', at });
  });
  editChanges.sort((a, b) => a.at - b.at);
  renderVoteMembers();
});
$('vote-cancel').addEventListener('click', () => $('vote-dialog').close());
$('vote-dialog').addEventListener('close', () => {
  voteClickMode = 'vote';
  voteOverlayKey = null;
  updateVoteOverlay();
});
[
  'vote-motion',
  'vote-time',
  'vote-moved-by',
  'vote-moved-at',
  'vote-seconded-by',
  'vote-seconded-at',
  'vote-outcome'
].forEach((id) => {
  $(id).addEventListener('input', () => {
    voteOverlayKey = null;
    updateVoteOverlay();
  });
  $(id).addEventListener('change', () => {
    voteOverlayKey = null;
    updateVoteOverlay();
  });
});
$('vote-delete').addEventListener('click', async () => {
  if (!voteEditing || !confirm('Remove this vote?')) return;
  const before = voteData.votes;
  voteData.votes = voteData.votes.filter((item) => item.id !== voteEditing.id);
  if (await saveVotes('Removed the vote')) $('vote-dialog').close();
  else voteData.votes = before;
});
$('vote-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const at = parse($('vote-time').value);
  if (at === null || at < 0 || at > endSeconds) {
    $('vote-dialog-status').textContent = 'Enter a time between 00:00:00 and ' + fmt(endSeconds);
    return;
  }
  if (!$('vote-motion').value.trim()) {
    $('vote-dialog-status').textContent = 'Say what the motion is';
    return;
  }
  const vote = {
    id: voteEditing ? voteEditing.id : Date.now().toString(36),
    at: Number(at.toFixed(3)),
    motion: $('vote-motion').value.trim(),
    changes: [...editChanges].sort((a, b) => a.at - b.at),
    outcome: $('vote-outcome').value,
    showSeconds: Math.max(3, Math.min(600, Number($('vote-show').value) || 20)),
    movedBy: readMotionPerson('moved'),
    secondedBy: readMotionPerson('seconded')
  };
  // Final statuses, for anything that only needs the result.
  vote.results = {};
  Object.entries(voteState(vote, Infinity).statuses).forEach(([id, status]) => {
    if (status !== 'pending') vote.results[id] = status;
  });
  for (const [role, label] of [
    ['movedBy', 'motion'],
    ['secondedBy', 'second']
  ]) {
    if (vote[role] && vote[role].at === null) {
      $('vote-dialog-status').textContent = 'Enter when the ' + label + ' was made (or press ⏱ Now)';
      return;
    }
  }
  const before = voteData.votes;
  voteData.votes = voteEditing
    ? voteData.votes.map((item) => (item.id === vote.id ? vote : item))
    : [...voteData.votes, vote];
  if (await saveVotes((voteEditing ? 'Saved the vote at ' : 'Recorded the vote at ') + fmt(vote.at)))
    $('vote-dialog').close();
  else {
    voteData.votes = before;
    $('vote-dialog-status').textContent = $('votes-status').textContent;
  }
});

// Who moved and seconded, and when. People to pick from: the voting members first, then everyone else.
function fillMotionPeople(vote) {
  for (const role of ['moved', 'seconded']) {
    const select = $('vote-' + role + '-by');
    select.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '—';
    select.appendChild(none);
    const memberIds = voteData.members.map((item) => item.id);
    const groups = [
      ['Voting members', people.filter((person) => memberIds.includes(person.id))],
      ['Others', people.filter((person) => !memberIds.includes(person.id))]
    ];
    groups.forEach(([label, list]) => {
      if (!list.length) return;
      const group = document.createElement('optgroup');
      group.label = label;
      [...list]
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((person) => {
          const option = document.createElement('option');
          option.value = person.id;
          option.textContent = shownName(person);
          group.appendChild(option);
        });
      select.appendChild(group);
    });
    const entry = vote ? vote[role + 'By'] : null;
    select.value = entry?.id || '';
    $('vote-' + role + '-at').value = entry?.at === null || entry?.at === undefined ? '' : fmtPrecise(entry.at);
  }
}
function readMotionPerson(role) {
  const id = $('vote-' + role + '-by').value;
  if (!id) return null;
  const text = $('vote-' + role + '-at').value.trim();
  const at = text ? parse(text) : null;
  return { id, at: at === null ? null : Number(at.toFixed(3)) };
}
// When someone is picked, start from when they last began speaking before the vote (from the speaker marks).
function lastSpokeBefore(id, seconds) {
  let found = null;
  turns.forEach((turn, index) => {
    if (turn.at > seconds + 0.05 || !turn.speakers.includes(id)) return;
    if (index > 0 && turns[index - 1].speakers.includes(id)) return;
    found = turn.at;
  });
  return found;
}
for (const role of ['moved', 'seconded']) {
  $('vote-' + role + '-by').addEventListener('change', () => {
    const id = $('vote-' + role + '-by').value;
    if (!id || $('vote-' + role + '-at').value.trim()) return;
    const voteAt = parse($('vote-time').value) ?? position;
    const spoke = lastSpokeBefore(id, voteAt);
    if (spoke !== null) $('vote-' + role + '-at').value = fmtPrecise(spoke);
  });
  $('vote-' + role + '-now').addEventListener('click', () => {
    $('vote-' + role + '-at').value = fmtPrecise(position);
  });
}
