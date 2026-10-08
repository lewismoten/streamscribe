// Find: results in order, except that while the transcript shows one chapter, that chapter's results come first
// (then the rest of the meeting, from after the chapter around to before it). ◀ ▶ (or Shift+Enter / Enter) step
// through them; a result in another chapter moves the video there so its chapter is shown.
let findIndex = -1;
let findOrder = [];
let findCursor = -1;
let findNeedle = '';
function computeFindOrder(needle) {
  const matches = transcript.map((line, index) => (line[2].toLowerCase().includes(needle) ? index : -1)).filter((index) => index >= 0);
  const range = transcriptRange;
  if (!range) return { order: matches, inChapter: matches.length };
  const inside = matches.filter((index) => transcript[index][0] >= range.min - 0.01 && transcript[index][0] < range.max);
  const after = matches.filter((index) => transcript[index][0] >= range.max);
  const before = matches.filter((index) => transcript[index][0] < range.min - 0.01);
  return { order: [...inside, ...after, ...before], inChapter: inside.length };
}
let findInChapter = 0;
function stepFind(direction) {
  const needle = $('find').value.trim().toLowerCase();
  transcriptList.querySelectorAll('.match').forEach((line) => line.classList.remove('match'));
  if (!needle) { findIndex = -1; $('find-status').textContent = ''; return; }
  if (needle !== findNeedle) {
    // A new search starts over, in the current chapter when only one is shown.
    const result = computeFindOrder(needle);
    findOrder = result.order;
    findInChapter = result.inChapter;
    findNeedle = needle;
    findCursor = direction > 0 ? -1 : 0;
  }
  if (!findOrder.length) { findIndex = -1; $('find-status').textContent = 'no matches'; return; }
  findCursor = (findCursor + direction + findOrder.length) % findOrder.length;
  findIndex = findOrder[findCursor];
  // In another chapter: move there, which shows that chapter's lines.
  if (!lineElements[findIndex]) showPosition(transcript[findIndex][0]);
  const line = lineElements[findIndex];
  if (line) {
    transcriptList.querySelectorAll('.w[data-line="' + findIndex + '"]').forEach((span) => span.classList.add('match'));
    userScrolledAt = Date.now();
    scrollToLine(line);
  }
  $('find-status').textContent = (findCursor + 1) + ' of ' + findOrder.length + (transcriptRange ? ' (' + findInChapter + ' in this chapter)' : '');
}
$('find').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  stepFind(event.shiftKey ? -1 : 1);
});
$('find').addEventListener('input', () => { findNeedle = ''; });
$('find-next').addEventListener('click', () => stepFind(1));
$('find-prev').addEventListener('click', () => stepFind(-1));
let transcriptKey = '';
// Which transcript is shown: the usual one (transcripts/latest.json), or best.json from transcribe --best, which
// times every word. The choice is remembered.
let transcriptName = 'latest';
try { transcriptName = localStorage.getItem('thumbnails.transcript') === 'best' ? 'best' : 'latest'; } catch {}
function loadLatestTranscript() {
  return fetch('../transcripts/' + transcriptName + '.json', { cache: 'no-store' })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => {
      if (!data?.lines?.length) {
        if (transcriptName !== 'latest') { transcriptName = 'latest'; return loadLatestTranscript(); }
        return;
      }
      // Only redraw when it changed (a live session checks again every few seconds).
      const key = transcriptName + ':' + data.lines.length + ':' + (data.createdAt || data.updatedAt || '') + ':' + data.lines[data.lines.length - 1].text;
      if (key === transcriptKey) return;
      transcriptKey = key;
      transcript = data.lines.map((line) => [Number(line.startSeconds), Number(line.endSeconds), line.text, line.retranscribed ? 1 : 0, Array.isArray(line.words) ? line.words : null]);
      $('transcript-choice').value = transcriptName;
      renderTranscript();
    })
    .catch(() => {});
}
// The choice only shows when a best transcript exists.
if (location.protocol !== 'file:') {
  fetch('../transcripts/best.json', { method: 'HEAD', cache: 'no-store' }).then((response) => { $('transcript-choice').hidden = !response.ok; }).catch(() => {});
}
$('transcript-choice').addEventListener('change', () => {
  transcriptName = $('transcript-choice').value;
  try { localStorage.setItem('thumbnails.transcript', transcriptName); } catch {}
  loadLatestTranscript();
});
if (location.protocol !== 'file:') {
  fetch('../word-edits.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (Array.isArray(data?.edits)) { wordEdits = data.edits; renderTranscript(); }
  }).catch(() => {});
  loadLatestTranscript();
  fetch('../views.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (data) { viewData = { views: data.views || [], sceneViews: data.sceneViews || {} }; sceneViewCache.clear(); refreshCurrentView(); }
  }).catch(() => {});
  fetch('../votes.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (data) { voteData = { members: data.members || [], votes: data.votes || [], seats: data.seats ?? null, needed: data.needed ?? null }; renderVotes(); renderTranscript(); }
  }).catch(() => {});
  fetch('../agenda.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (data?.items) { agendaItems = data.items; renderAgenda(); renderTranscript(); }
  }).catch(() => {});
  fetch('../meeting-info.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (data && typeof data === 'object') meetingInfo = data;
    if (data && typeof data.name === 'string') showMeetingName(data.name);
  }).catch(() => {});
  fetch('../audio-boosts.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).then((data) => {
    if (data?.boosts) { playbackBoosts = data.boosts; boost.playingKey = null; updatePlaybackBoost(); }
  }).catch(() => {});
  Promise.all([
    fetch('../speakers.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null),
    fetch(page.peopleUrl + '/people.json', { cache: 'no-store' }).then((response) => (response.ok ? response.json() : null)).catch(() => null)
  ]).then(([speakers, roster]) => {
    if (speakers?.turns) turns = speakers.turns;
    if (roster?.people) { people = roster.people; peopleMap = mapPeople(); }
    if (Array.isArray(roster?.groups)) rosterGroups = roster.groups;
    renderPeople();
    speakersChanged();
  });
}

