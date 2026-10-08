// When a person spoke: their stretches (from the speaker marks), on a bar across the meeting and as a list.
let spokePerson = null;
let spokeCurrent = -2;
function speakingStretches(id) {
  const stretches = [];
  turns.forEach((turn, index) => {
    const speaking = turn.speakers.includes(id);
    const before = index > 0 && turns[index - 1].speakers.includes(id);
    if (speaking && !before) stretches.push({ from: turn.at, to: endSeconds });
    if (!speaking && before && stretches.length) stretches[stretches.length - 1].to = turn.at;
  });
  return stretches;
}
function openSpokeDialog(id) {
  spokePerson = id;
  renderSpoke();
  if (!$('spoke-dialog').open) $('spoke-dialog').show();
}
function renderSpoke() {
  if (!spokePerson) return;
  const person = peopleMap.get(spokePerson) || { id: spokePerson, name: spokePerson };
  const stretches = speakingStretches(spokePerson);
  $('spoke-title').textContent = 'When ' + shownName(person) + ' spoke';
  const total = stretches.reduce((sum, item) => sum + (item.to - item.from), 0);
  $('spoke-summary').textContent = stretches.length
    ? stretches.length + ' time' + (stretches.length === 1 ? '' : 's') + ', ' + fmt(total) + ' in all'
    : 'Not marked as speaking yet';
  const bar = $('spoke-bar');
  bar.textContent = '';
  stretches.forEach((item) => {
    const segment = document.createElement('span');
    segment.style.left = (item.from / endSeconds) * 100 + '%';
    segment.style.width = ((item.to - item.from) / endSeconds) * 100 + '%';
    segment.title = fmt(item.from) + '-' + fmt(item.to);
    bar.appendChild(segment);
  });
  const marker = document.createElement('i');
  marker.id = 'spoke-marker';
  bar.appendChild(marker);
  const list = $('spoke-list');
  list.textContent = '';
  stretches.forEach((item) => {
    const row = document.createElement('li');
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'go';
    const when = document.createElement('time');
    when.textContent = fmt(item.from);
    const length = document.createElement('span');
    length.className = 'label';
    length.textContent = fmt(item.to - item.from) + ' ';
    const words = document.createElement('span');
    words.className = 'spoke-text';
    // Their first words in that stretch.
    words.textContent = transcript
      .filter((line) => line[0] >= item.from - 0.5 && line[0] < item.to)
      .slice(0, 2)
      .map((line) => line[2])
      .join(' ');
    go.append(when, length, words);
    go.addEventListener('click', () => showPosition(item.from));
    const boostButton = document.createElement('button');
    boostButton.type = 'button';
    boostButton.className = 'small';
    boostButton.textContent = '🔊';
    boostButton.title = 'Boost this stretch and transcribe it again';
    boostButton.addEventListener('click', () => openBoostDialog(item.from, item.to));
    const clipButton = document.createElement('button');
    clipButton.type = 'button';
    clipButton.className = 'small';
    clipButton.textContent = '✂';
    clipButton.title = 'Use this stretch as the clip';
    clipButton.addEventListener('click', () => {
      start = item.from;
      end = item.to;
      update();
      showPosition(item.from);
    });
    row.append(go, boostButton, clipButton);
    list.appendChild(row);
  });
  spokeCurrent = -2;
  updateSpokeCurrent();
}
// While open: mark where the video is, and highlight the stretch being played.
function updateSpokeCurrent() {
  if (!spokePerson || !$('spoke-dialog').open) return;
  const marker = $('spoke-marker');
  if (marker) marker.style.left = (position / endSeconds) * 100 + '%';
  const stretches = speakingStretches(spokePerson);
  const index = stretches.findIndex((item) => position >= item.from - 0.05 && position < item.to);
  if (index === spokeCurrent) return;
  spokeCurrent = index;
  [...$('spoke-list').children].forEach((row, rowIndex) => row.classList.toggle('current', rowIndex === index));
  [...$('spoke-bar').children].forEach((segment, segmentIndex) => {
    if (segment.tagName === 'SPAN') segment.classList.toggle('now', segmentIndex === index);
  });
}
$('spoke-bar').addEventListener('click', (event) => {
  const rect = $('spoke-bar').getBoundingClientRect();
  const seconds = ((event.clientX - rect.left) / rect.width) * endSeconds;
  // Jump to the stretch clicked, or the nearest one.
  const stretches = speakingStretches(spokePerson);
  if (!stretches.length) return;
  const hit =
    stretches.find((item) => seconds >= item.from && seconds < item.to) ||
    stretches.reduce((best, item) => (Math.abs(item.from - seconds) < Math.abs(best.from - seconds) ? item : best));
  showPosition(hit.from);
});
$('spoke-prev').addEventListener('click', () => {
  const previous = [...speakingStretches(spokePerson)].reverse().find((item) => item.from < position - 1.5);
  if (previous) showPosition(previous.from);
});
$('spoke-next').addEventListener('click', () => {
  const next = speakingStretches(spokePerson).find((item) => item.from > position + 0.5);
  if (next) showPosition(next.from);
});
$('spoke-close').addEventListener('click', () => $('spoke-dialog').close());
// Chapter scope: markers above the scrubber for speaker changes, motions, and each vote's last vote.
function renderScrubMarks() {
  const box = $('scrub-marks');
  const range = transcriptRange;
  box.hidden = !range;
  if (!range) return;
  const speakersLane = $('marks-speakers');
  const eventsLane = $('marks-events');
  speakersLane.textContent = '';
  eventsLane.textContent = '';
  const span = Math.max(0.001, range.max - range.min);
  const place = (element, seconds, lane, title, jumpTo) => {
    element.style.left = ((Math.max(range.min, seconds) - range.min) / span) * 100 + '%';
    element.title = fmt(seconds) + '  ' + title;
    element.addEventListener('click', () => showPosition(jumpTo ?? seconds));
    lane.appendChild(element);
  };
  // Speaker changes in the chapter, plus whoever is already speaking when it starts.
  turns.forEach((turn, index) => {
    const inside = turn.at >= range.min && turn.at < range.max;
    const atStart = turn.at < range.min && (index + 1 >= turns.length || turns[index + 1].at > range.min);
    if ((!inside && !atStart) || !turn.speakers.length) return;
    const people = turn.speakers.map((id) => peopleMap.get(id) || { id, name: id });
    const mark = document.createElement('button');
    mark.type = 'button';
    mark.className = 'scrub-mark';
    mark.appendChild(avatar(people[0]));
    if (people.length > 1) {
      const more = document.createElement('span');
      more.className = 'more';
      more.textContent = '+' + (people.length - 1);
      mark.appendChild(more);
    }
    place(
      mark,
      inside ? turn.at : range.min,
      speakersLane,
      people.map(shownName).join(', ') + ' speaking',
      inside ? turn.at : range.min
    );
  });
  // Motions (when they were made) and each vote's first vote cast (clicking it plays the roll call from just before).
  voteData.votes.forEach((vote) => {
    if (vote.movedBy?.id && vote.movedBy.at >= range.min && vote.movedBy.at < range.max) {
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'scrub-mark event';
      mark.textContent = '✋';
      place(
        mark,
        vote.movedBy.at,
        eventsLane,
        'Motion by ' +
          shownName(peopleMap.get(vote.movedBy.id) || { id: vote.movedBy.id, name: vote.movedBy.id }) +
          (vote.motion ? ': ' + vote.motion : '')
      );
    }
    const changes = voteChanges(vote);
    const first = changes.length ? Math.min(...changes.map((change) => change.at)) : vote.at;
    if (first >= range.min && first < range.max) {
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'scrub-mark event vote-mark ' + voteState(vote, Infinity).outcome;
      mark.textContent = '🗳';
      place(
        mark,
        first,
        eventsLane,
        'Voting begins: ' + (vote.motion || 'Vote') + ' — ' + describeTally(vote),
        Math.max(range.min, first - 1)
      );
    }
  });
}
