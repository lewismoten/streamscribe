// Votes ({session}/votes.json, saved through the local server): the meeting's voting members (with when anyone
// left or arrived), and each vote's time, motion, every member's choice, and outcome.
let voteData = { members: page.votes.members || [], votes: page.votes.votes || [], seats: page.votes.seats ?? null, needed: page.votes.needed ?? null };
// Each vote keeps every member's status changes in order ({ id, choice, at }), so the roll call can be replayed.
const cycle = ['pending', 'for', 'against', 'abstain', 'absent'];
const choiceNames = { for: 'Aye', against: 'Nay', abstain: 'Abstain', absent: 'Absent', pending: 'Not voted' };
const choiceMarks = { for: '✔', against: '✖', abstain: '–', absent: '', pending: '' };
// Short label: a person's last name; a group entry (with an icon) or unknown name in full.
const lastName = (person) => (isNameUnknown(person) || person.icon ? shownName(person) : (person.name.split(' ').filter(Boolean).slice(-1)[0] || person.name));
// The district from a role such as "Supervisor, South River District" (shown without the word District).
function districtOf(person) {
  const parts = String(person.role || '').split(',').map((part) => part.trim()).filter(Boolean);
  const district = parts.find((part) => /district/i.test(part)) || (parts.length > 1 ? parts[parts.length - 1] : '');
  return district.replace(/ *district$/i, '');
}
function memberPresent(member, seconds) {
  return !((member.leftAt !== null && member.leftAt !== undefined && seconds >= member.leftAt)
    || (member.arrivedAt !== null && member.arrivedAt !== undefined && seconds < member.arrivedAt));
}
// Votes saved before the roll call was recorded only have final results: treat them as cast when the vote opened.
function voteChanges(vote) {
  if (Array.isArray(vote.changes)) return vote.changes;
  return Object.entries(vote.results || {}).filter(([, choice]) => choice !== 'absent').map(([id, choice]) => ({ id, choice, at: vote.at }));
}
function voterIds(vote, changes) {
  // Current members, plus anyone recorded in this vote who has since been unchecked.
  const ids = voteData.members.map((item) => item.id);
  (changes || (vote ? voteChanges(vote) : [])).forEach((change) => { if (!ids.includes(change.id)) ids.push(change.id); });
  Object.keys(vote?.results || {}).forEach((id) => { if (!ids.includes(id)) ids.push(id); });
  return ids;
}
// A member's status at a moment: their latest change by then; absent if they weren't in the meeting when the vote
// opened; otherwise not voted yet.
function statusAt(vote, id, seconds, changes) {
  let found = null;
  for (const change of changes || voteChanges(vote)) {
    if (change.id === id && change.at <= seconds + 0.05 && (!found || change.at >= found.at)) found = change;
  }
  if (found) return found.choice;
  const member = voteData.members.find((item) => item.id === id);
  return member && !memberPresent(member, vote.at) ? 'absent' : 'pending';
}
function voteRule(memberCount) {
  const seats = voteData.seats || memberCount;
  const needed = voteData.needed || Math.floor(seats / 2) + 1;
  return { seats, needed, failAt: Math.max(1, seats - needed + 1) };
}
// Counts and outcome at a moment. Passes once enough ayes are in; fails once nays and absences make that
// impossible, or when everyone has voted without enough ayes (abstentions); otherwise still voting.
function voteState(vote, seconds = Infinity, changes) {
  const list = changes || voteChanges(vote);
  const ids = voterIds(vote, list);
  const counts = { for: 0, against: 0, abstain: 0, absent: 0, pending: 0 };
  const statuses = {};
  ids.forEach((id) => { const status = statusAt(vote, id, seconds, list); statuses[id] = status; counts[status] += 1; });
  const rule = voteRule(ids.length);
  let outcome = 'pending';
  if (counts.for >= rule.needed) outcome = 'passed';
  else if (counts.against + counts.absent >= rule.failAt || counts.pending === 0) outcome = 'failed';
  if (seconds === Infinity && (vote.outcome === 'passed' || vote.outcome === 'failed')) outcome = vote.outcome;
  return { counts, statuses, outcome, rule };
}
// When the outcome was settled (the first moment it stopped being pending), or null.
function decidedAt(vote) {
  const times = [...new Set(voteChanges(vote).map((change) => change.at))].sort((a, b) => a - b);
  return times.find((time) => voteState(vote, time).outcome !== 'pending') ?? null;
}
function describeTally(vote, seconds = Infinity, changes) {
  const state = voteState(vote, seconds, changes);
  const { counts } = state;
  if (state.outcome === 'pending') {
    return (seconds === Infinity ? 'Undecided: ' : 'Voting: ') + counts.for + ' aye, ' + counts.against + ' nay'
      + (counts.abstain ? ', ' + counts.abstain + ' abstain' : '') + (counts.absent ? ', ' + counts.absent + ' absent' : '') + (counts.pending ? ', ' + counts.pending + ' not voted' : '');
  }
  const extras = [counts.abstain ? counts.abstain + ' abstained' : '', counts.absent ? counts.absent + ' absent' : '', counts.pending ? counts.pending + ' not voted' : ''].filter(Boolean).join(', ');
  return (state.outcome === 'passed' ? 'Passed ' : 'Failed ') + counts.for + '–' + counts.against + (extras ? ' (' + extras + ')' : '');
}
async function saveVotes(done) {
  try {
    if (location.protocol === 'file:') throw new Error('saving needs the local server (npm start)');
    const response = await fetch('../votes.json', { method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ updatedAt: new Date().toISOString(), seats: voteData.seats, needed: voteData.needed, members: voteData.members, votes: voteData.votes }, null, 2) });
    if (!response.ok) throw new Error('the server answered ' + response.status + ' ' + (await response.text().catch(() => '')));
    $('votes-status').textContent = done || 'Saved';
    renderVotes();
    renderTranscript();
    return true;
  } catch (error) {
    $('votes-status').textContent = 'Not saved: ' + error.message;
    return false;
  }
}

// Votes list under the video.
function renderVotes() {
  voteData.votes.sort((left, right) => left.at - right.at);
  const list = $('vote-list');
  list.textContent = '';
  voteData.votes.forEach((vote) => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    const when = document.createElement('time');
    when.textContent = fmt(vote.at);
    const text = document.createElement('span');
    text.className = 'vote-text';
    text.textContent = vote.motion || 'Vote';
    // Members' icons with their votes, 1 and 2 on whoever moved and seconded, and a border showing the result:
    // solid green when it passed, dotted red when it failed (not by color alone), dashed while undecided.
    const state = voteState(vote, Infinity);
    const faces = document.createElement('span');
    faces.className = 'vote-faces ' + state.outcome;
    const credit = (entry, verb) => (entry?.id ? verb + ' by ' + shownName(peopleMap.get(entry.id) || { id: entry.id, name: entry.id }) : '');
    faces.title = [describeTally(vote), credit(vote.movedBy, 'moved'), credit(vote.secondedBy, 'seconded')].filter(Boolean).join('; ');
    faces.setAttribute('aria-label', faces.title);
    voterIds(vote, voteChanges(vote)).forEach((id) => {
      const person = peopleMap.get(id) || { id, name: id };
      const status = state.statuses[id] || statusAt(vote, id, Infinity);
      const face = document.createElement('span');
      face.className = 'vote-face' + (status === 'absent' ? ' absent' : '') + (status === 'pending' ? ' pending' : '');
      const order = vote.movedBy?.id === id ? 1 : (vote.secondedBy?.id === id ? 2 : 0);
      face.title = shownName(person) + ': ' + choiceNames[status] + (order === 1 ? ' (moved)' : order === 2 ? ' (seconded)' : '');
      face.appendChild(avatar(person));
      if (status !== 'absent' && status !== 'pending') {
        const badge = document.createElement('span');
        badge.className = 'vote-badge choice-' + status;
        badge.textContent = choiceMarks[status];
        face.appendChild(badge);
      }
      if (order) {
        const number = document.createElement('span');
        number.className = 'vote-order';
        number.textContent = String(order);
        face.appendChild(number);
      }
      faces.appendChild(face);
    });
    go.append(when, text, faces);
    go.addEventListener('click', () => showPosition(vote.at));
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'small';
    edit.title = 'Edit';
    edit.textContent = '✎';
    edit.addEventListener('click', () => openVoteEditor(vote));
    row.append(go, edit);
    list.appendChild(row);
  });
  $('votes-empty').hidden = voteData.votes.length > 0;
  if (pageReady) renderScrubMarks();
  renderMembers();
  renderSeatOrder();
  showVoteRule();
  voteOverlayKey = null;
  updateVoteOverlay();
}

