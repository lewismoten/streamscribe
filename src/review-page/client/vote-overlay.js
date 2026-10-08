// On the video: each member's photo with their vote, and the outcome, for a while after each vote.
let voteOverlayKey = null;
// Shown from when the vote opens until 5 seconds after it passes or fails, then fades out over a second. A vote
// that's never decided stays up a while after its last recorded change.
const voteHoldSeconds = 5;
const voteFadeSeconds = 1;
function voteEnd(vote) {
  const decided = decidedAt(vote);
  if (decided !== null) return decided + voteHoldSeconds + voteFadeSeconds;
  const last = Math.max(vote.at, ...voteChanges(vote).map((change) => change.at));
  return last + (vote.showSeconds || 20);
}
function activeVote(seconds) {
  return [...voteData.votes].filter((vote) => vote.at <= seconds + 0.05 && seconds < voteEnd(vote)).sort((a, b) => b.at - a.at)[0] || null;
}
// The vote on the video: the one being edited while the vote panel is open (shown the whole time, so the motion
// and second can be found before the vote opens), otherwise the active one when "Show votes" is checked.
let voteClickMode = 'vote';
function overlayVote() {
  if ($('vote-dialog').open) {
    return {
      id: voteEditing?.id || 'draft',
      at: parse($('vote-time').value) ?? editVote.at,
      motion: $('vote-motion').value.trim(),
      changes: editChanges,
      movedBy: readMotionPerson('moved'),
      secondedBy: readMotionPerson('seconded'),
      outcome: $('vote-outcome').value,
      editing: true
    };
  }
  return $('show-votes').checked ? activeVote(position) : null;
}
// Clicking a member's photo on the video: records their vote now (or, in Moved / Seconded mode, that they made
// or seconded the motion now). In the vote panel this changes the draft; otherwise it saves right away.
async function overlayClick(id) {
  const vote = overlayVote();
  if (!vote) return;
  if (voteClickMode === 'vote') {
    if (vote.editing) { toggleVote(id); return; }
    const saved = voteData.votes.find((item) => item.id === vote.id);
    const before = saved.changes;
    saved.changes = toggledChanges(saved, voteChanges(saved), id, position);
    saved.results = {};
    Object.entries(voteState(saved, Infinity).statuses).forEach(([member, status]) => { if (status !== 'pending') saved.results[member] = status; });
    const person = peopleMap.get(id) || { id, name: id };
    if (!(await saveVotes(lastName(person) + ': ' + choiceNames[statusAt(saved, id, position)] + ' at ' + fmt(position)))) saved.changes = before;
    return;
  }
  const role = voteClickMode;
  voteClickMode = 'vote';
  const current = vote[role + 'By'];
  // Clicking the same person again at the same moment clears it.
  const entry = current?.id === id && current.at !== null && Math.abs(current.at - position) <= 2 ? null : { id, at: Number(position.toFixed(2)) };
  if (vote.editing) {
    $('vote-' + role + '-by').value = entry ? entry.id : '';
    $('vote-' + role + '-at').value = entry ? fmtPrecise(entry.at) : '';
    voteOverlayKey = null;
    updateVoteOverlay();
    return;
  }
  const saved = voteData.votes.find((item) => item.id === vote.id);
  const before = saved[role + 'By'];
  saved[role + 'By'] = entry;
  const person = peopleMap.get(id) || { id, name: id };
  if (!(await saveVotes(entry ? (role === 'moved' ? 'Moved by ' : 'Seconded by ') + lastName(person) + ' at ' + fmt(position) : 'Cleared'))) saved[role + 'By'] = before;
}
// Starts a new vote here and shows it, ready for members to be clicked as they vote.
async function startVoteNow() {
  const vote = { id: Date.now().toString(36), at: Number(position.toFixed(2)), motion: 'Motion',
    changes: [], results: {}, outcome: 'auto', showSeconds: 20 };
  voteData.votes = [...voteData.votes, vote];
  if (await saveVotes('Vote started at ' + fmt(vote.at) + ': click members on the video as they vote')) {
    if (!$('show-votes').checked) setShowVotes(true);
  } else {
    voteData.votes = voteData.votes.filter((item) => item !== vote);
  }
}
$('vote-start').addEventListener('click', startVoteNow);
// Toolbar: show or hide the votes, and jump between them.
function setVotesShown(shown) {
  $('votes-panel').hidden = !shown;
  $('votes-toggle').setAttribute('aria-pressed', shown ? 'true' : 'false');
  try { localStorage.setItem('thumbnails.votesShown', shown ? '1' : '0'); } catch {}
}
$('votes-toggle').addEventListener('click', () => setVotesShown($('votes-panel').hidden));
try { setVotesShown(localStorage.getItem('thumbnails.votesShown') !== '0'); } catch { setVotesShown(true); }
$('vote-prev').addEventListener('click', () => {
  const previous = [...voteData.votes].sort((a, b) => b.at - a.at).find((vote) => vote.at < position - 1.5);
  if (previous) showPosition(previous.at);
});
$('vote-next').addEventListener('click', () => {
  const next = [...voteData.votes].sort((a, b) => a.at - b.at).find((vote) => vote.at > position + 0.5);
  if (next) showPosition(next.at);
});
async function moveVoteStart(vote) {
  const at = Number(position.toFixed(2));
  if (vote.editing) { $('vote-time').value = fmtPrecise(at); renderVoteMembers(); voteOverlayKey = null; updateVoteOverlay(); return; }
  const saved = voteData.votes.find((item) => item.id === vote.id);
  const before = saved.at;
  saved.at = at;
  if (!(await saveVotes('The vote now starts at ' + fmt(at)))) saved.at = before;
}
function updateVoteOverlay() {
  const vote = overlayVote();
  const state = vote ? voteState(vote, position) : null;
  const decided = vote ? decidedAt(vote) : null;
  const fading = Boolean(vote && !vote.editing && decided !== null && position >= decided + voteHoldSeconds);
  $('vote-overlay').classList.toggle('fading', fading);
  if (inlineEditing && !$('vote-overlay').hidden) return;
  const key = vote ? JSON.stringify(vote) + JSON.stringify(state.statuses) + state.outcome + voteClickMode : '';
  if (key === voteOverlayKey) return;
  voteOverlayKey = key;
  const overlay = $('vote-overlay');
  overlay.hidden = !vote;
  overlay.textContent = '';
  if (!vote) return;
  overlay.classList.toggle('editing', Boolean(vote.editing));
  // What a click on a photo records (shown on hover, and always while editing).
  const modes = document.createElement('div');
  modes.className = 'vote-modes';
  const startButton = document.createElement('button');
  startButton.type = 'button';
  startButton.textContent = '⏱ Starts now';
  startButton.title = 'Move the start of this vote to ' + fmt(position);
  startButton.addEventListener('click', (event) => { event.stopPropagation(); moveVoteStart(vote); });
  modes.appendChild(startButton);
  [['vote', '🗳 Vote'], ['moved', '✋ Moved'], ['seconded', '✋ Seconded']].forEach(([mode, label]) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.title = mode === 'vote' ? "Click a photo to record that member's vote now" : 'Then click the member who ' + mode + ' the motion, at the moment they did';
    if (mode === voteClickMode) button.classList.add('on');
    button.addEventListener('click', (event) => { event.stopPropagation(); voteClickMode = mode; voteOverlayKey = null; updateVoteOverlay(); });
    modes.appendChild(button);
  });
  overlay.appendChild(modes);
  // The motion: click to edit it in place.
  const motion = document.createElement('div');
  motion.className = 'motion editable-text';
  motion.textContent = vote.motion || 'Motion';
  motion.title = (vote.motion ? vote.motion + ' — ' : '') + 'Click to edit the motion';
  motion.addEventListener('click', (event) => {
    event.stopPropagation();
    motion.classList.add('editing-inline');
    inlineEdit(motion, vote.motion || '', async (text) => {
      if (vote.editing) {
        $('vote-motion').value = text;
      } else {
        const saved = voteData.votes.find((item) => item.id === vote.id);
        const before = saved.motion;
        saved.motion = text;
        if (!(await saveVotes('Saved the motion'))) saved.motion = before;
      }
      voteOverlayKey = null;
      updateVoteOverlay();
    });
  });
  overlay.appendChild(motion);
  if (vote.movedBy?.id || vote.secondedBy?.id) {
    const credits = document.createElement('div');
    credits.className = 'credits';
    [[vote.movedBy, 'Moved', 'moved'], [vote.secondedBy, 'Seconded', 'seconded']].forEach(([entry, verb, mode]) => {
      if (!entry?.id) return;
      const person = peopleMap.get(entry.id) || { id: entry.id, name: entry.id };
      const item = document.createElement('span');
      item.title = verb + ' by ' + shownName(person) + (entry.at === null || entry.at === undefined ? '' : ' at ' + fmt(entry.at)) + ' — click to change';
      const text = document.createElement('span');
      text.textContent = verb + ': ' + lastName(person);
      item.append(avatar(person), text);
      item.addEventListener('click', (event) => { event.stopPropagation(); voteClickMode = mode; voteOverlayKey = null; updateVoteOverlay(); });
      credits.appendChild(item);
    });
    overlay.appendChild(credits);
  }
  const members = document.createElement('div');
  members.className = 'members';
  Object.entries(state.statuses).forEach(([id, choice]) => {
    const person = peopleMap.get(id) || { id, name: id };
    const item = document.createElement('div');
    item.className = 'vote-member' + (choice === 'absent' ? ' absent' : '') + (choice === 'pending' ? ' pending' : '');
    item.title = voteClickMode === 'vote' ? 'Click to record ' + shownName(person) + "'s vote at " + fmt(position) : shownName(person) + ' ' + voteClickMode + ' the motion at ' + fmt(position);
    const face = document.createElement('span');
    face.className = 'face';
    face.appendChild(avatar(person));
    if (choice !== 'absent' && choice !== 'pending') {
      const badge = document.createElement('span');
      badge.className = 'vote-badge choice-' + choice;
      badge.textContent = choiceMarks[choice];
      face.appendChild(badge);
    }
    const name = document.createElement('small');
    name.textContent = lastName(person);
    const district = document.createElement('small');
    district.className = 'district';
    district.textContent = choice === 'absent' ? 'absent' : districtOf(person);
    item.append(face, name, district);
    item.addEventListener('click', (event) => { event.stopPropagation(); overlayClick(id); });
    members.appendChild(item);
  });
  overlay.appendChild(members);
  const outcome = document.createElement('div');
  outcome.className = 'outcome ' + state.outcome;
  outcome.textContent = describeTally(vote, position);
  overlay.appendChild(outcome);
}
function setShowVotes(visible) {
  $('show-votes').checked = visible;
  try { localStorage.setItem('thumbnails.showVotes', visible ? '1' : '0'); } catch {}
  voteOverlayKey = null;
  updateVoteOverlay();
}
$('show-votes').addEventListener('change', () => setShowVotes($('show-votes').checked));
try { if (localStorage.getItem('thumbnails.showVotes') === '1') $('show-votes').checked = true; } catch {}

renderVotes();
