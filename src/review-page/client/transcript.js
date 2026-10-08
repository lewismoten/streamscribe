// Above the transcript: the camera or slide showing at the current moment (it switches the instant a change
// happens), with the faces of whoever is speaking.
let nowScene = -2;
function updateNowScene() {
  const scenes = page.scenes;
  let index = -1;
  for (let next = 0; next < scenes.length && scenes[next][0] <= position + 0.05; next += 1) index = next;
  if (index === nowScene) return;
  nowScene = index;
  $('now-scene').hidden = index < 0 || !transcript.length;
  if (index < 0) return;
  $('now-scene-image').src = scenes[index][1];
  renderViewSelect();
  $('now-scene-time').textContent = fmt(scenes[index][0]) + (clockMs(scenes[index][0]) === null ? '' : '  ~' + clockFormat.format(new Date(clockMs(scenes[index][0]))));
}
$('now-scene').addEventListener('click', () => { if (nowScene >= 0) showPosition(page.scenes[nowScene][0]); });
function updateNowSpeakers(ids) {
  const faces = $('now-speakers');
  faces.textContent = '';
  ids.forEach((id) => {
    const person = peopleMap.get(id) || { id, name: id };
    const face = avatar(person);
    face.title = nameAndRole(person) + ' — click to clip everything they say here';
    face.addEventListener('click', (event) => { event.stopPropagation(); clipSpeaker(id, position); });
    faces.appendChild(face);
  });
}
// Transcript panel: the line being spoken is highlighted and kept in view; clicking a line jumps there.
// Served pages load the latest transcript (with current corrections); otherwise the copy built into the page.
let transcript = page.transcript;
let userScrolledAt = 0;
const transcriptList = $('transcript-list');
// Lines are grouped into sections, one per camera or slide change, each opened by a small image of the change.
// Each line is split wherever the speaker changes within it, into pieces shown like a conversation: voting members
// on the right, everyone else on the left. pieceList holds every piece in order ({ start, end, el, words: [[at,
// span]] }); lineElements holds each line's first piece (for find).
let lineElements = [];
let pieceList = [];
const silenceMinimumSeconds = 8;
const paragraphPauseSeconds = 2;
// Word corrections ({ transcript, line, index, original, text }; text '' deletes the word, and several words replace
// it), saved in {session}/word-edits.json. Each applies only while the word there is still the one corrected.
let wordEdits = [];
const wordEditFor = (line, index, original) => wordEdits.find((edit) => edit.transcript === transcriptName && edit.line === line && edit.index === index && edit.original === original);
async function saveWordEdit(word, text) {
  const original = word.edited ? word.original : word.text;
  wordEdits = wordEdits.filter((edit) => !(edit.transcript === transcriptName && edit.line === word.line && edit.index === word.index));
  if (text !== original) wordEdits.push({ transcript: transcriptName, line: word.line, index: word.index, at: word.at, original, text, updatedAt: new Date().toISOString() });
  renderTranscript();
  try {
    await putFile('../word-edits.json', JSON.stringify({ updatedAt: new Date().toISOString(), note: 'Word corrections from the thumbnails page: line is the line start (seconds), index the word number in it.', edits: wordEdits }, null, 2), 'application/json');
    $('snapshot-status').textContent = text === original ? 'Restored “' + original + '”' : (text ? 'Corrected “' + original + '” to “' + text + '”' : 'Deleted “' + original + '”');
  } catch (error) {
    $('snapshot-status').textContent = 'Correction not saved: ' + error.message;
  }
}
let activePiece = -1;
let nowWord = null;
// A transcript line's words, each { text, at, end, line, index } with any correction (edited, display, original):
// times from the transcript where it has them (transcribe --best), or else estimated.
function lineWordList(startSeconds, endSeconds, text, timedWords) {
  const words = timedWords && timedWords.length
    ? timedWords.map(([at, end, said]) => ({ text: said, at: Math.round(at * 100) / 100, end: Number(end) }))
    : lineWords(startSeconds, endSeconds, text);
  // Corrections made on this page (word-edits.json), matched by line, word number, and the word as transcribed.
  const lineKey = Math.round(startSeconds * 100) / 100;
  words.forEach((word, wordIndex) => {
    word.line = lineKey;
    word.index = wordIndex;
    if (!(word.end > word.at)) word.end = wordIndex + 1 < words.length ? words[wordIndex + 1].at : endSeconds;
    const edit = wordEditFor(lineKey, wordIndex, word.text);
    if (edit) { word.original = word.text; word.edited = true; word.display = edit.text; }
  });
  return words;
}
// A line's words with estimated times (whisper times whole lines): the line's time shared out by word length.
function lineWords(startSeconds, endSeconds, text) {
  const parts = String(text).split(' ').filter(Boolean);
  const total = parts.reduce((sum, word) => sum + word.length + 1, 0) || 1;
  const span = Math.max(0.01, endSeconds - startSeconds);
  let used = 0;
  return parts.map((word) => {
    const at = Math.round((startSeconds + span * used / total) * 100) / 100;
    used += word.length + 1;
    return { text: word, at };
  });
}
function renderTranscript() {
  const keepScroll = transcriptList.scrollTop;
  transcriptList.textContent = '';
  lineElements = [];
  pieceList = [];
  nowWord = null;
  const votingIds = new Set(voteData.members.map((member) => member.id));
  $('transcript').hidden = transcript.length === 0;
  nowScene = -2;
  const scenes = page.scenes;
  let sceneIndex = -1;
  let section = document.createElement('section');
  transcriptList.appendChild(section);
  let previousSpeakers = '';
  let agendaIndex = 0;
  let shownLines = 0;
  const range = transcriptRange;
  const inRange = (seconds) => !range || (seconds >= range.min - 0.01 && seconds < range.max);
  // Each vote puts rows in the transcript: when the motion was made, when it was seconded, and the vote itself.
  const voteEvents = [];
  voteData.votes.forEach((vote) => {
    const nameOf = (entry) => shownName(peopleMap.get(entry.id) || { id: entry.id, name: entry.id });
    if (vote.movedBy?.id && vote.movedBy.at !== null && vote.movedBy.at !== undefined) {
      voteEvents.push({ at: vote.movedBy.at, text: '✋ ' + fmt(vote.movedBy.at) + '  Motion by ' + nameOf(vote.movedBy) + (vote.motion ? ': ' + vote.motion : '') });
    }
    if (vote.secondedBy?.id && vote.secondedBy.at !== null && vote.secondedBy.at !== undefined) {
      voteEvents.push({ at: vote.secondedBy.at, text: '✋ ' + fmt(vote.secondedBy.at) + '  Seconded by ' + nameOf(vote.secondedBy) });
    }
    const decided = decidedAt(vote);
    voteEvents.push({ at: vote.at, text: '🗳 ' + fmt(vote.at) + '  Vote: ' + (vote.motion || 'motion') + ' — ' + describeTally(vote) + (decided !== null ? ' (decided ' + fmt(decided) + ')' : '') });
  });
  const sortedVotes = voteEvents.sort((left, right) => left.at - right.at);
  let voteIndex = 0;
  const voteRow = (event) => {
    const row = document.createElement('div');
    row.className = 'vote-row';
    row.textContent = event.text;
    row.addEventListener('click', () => showPosition(event.at));
    section.appendChild(row);
  };
  const agendaHeading = (item) => {
    const heading = document.createElement('h3');
    heading.className = 'agenda-heading';
    heading.textContent = item.title;
    const when = document.createElement('small');
    when.textContent = fmt(item.at) + (clockMs(item.at) === null ? '' : '  ~' + clockFormat.format(new Date(clockMs(item.at))));
    heading.appendChild(when);
    heading.addEventListener('click', () => showPosition(item.at));
    section.appendChild(heading);
    previousSpeakers = '';
  };
  const startSection = (scene) => {
    previousSpeakers = '';
    section = document.createElement('section');
    const figure = document.createElement('figure');
    const image = document.createElement('img');
    image.loading = 'lazy';
    image.alt = '';
    image.src = scene[1];
    const caption = document.createElement('figcaption');
    caption.textContent = fmt(scene[0]) + (clockMs(scene[0]) === null ? '' : '  ~' + clockFormat.format(new Date(clockMs(scene[0]))));
    figure.append(image, caption);
    figure.addEventListener('click', () => showPosition(scene[0]));
    section.appendChild(figure);
    transcriptList.appendChild(section);
  };
  // Stretches with no words transcribed, as rows between the lines: silence, or speech too quiet or unclear to
  // make out, which can be boosted and transcribed again.
  let lastEnd = null;
  const silenceRow = (from, to) => {
    const row = document.createElement('div');
    row.className = 'silence-row';
    const length = to - from;
    const label = document.createElement('span');
    label.textContent = '⏸ No words for ' + (length >= 60 ? Math.floor(length / 60) + ' min ' + Math.round(length % 60) + ' s' : Math.round(length) + ' s');
    row.title = 'Nothing was transcribed from ' + fmt(from) + ' to ' + fmt(to) + ' (silence, or speech too quiet to make out) — click to go there';
    const boostGap = document.createElement('button');
    boostGap.type = 'button';
    boostGap.textContent = '🔊 Boost & re-transcribe';
    boostGap.title = 'Raise the volume of this stretch, listen, and transcribe it again';
    boostGap.addEventListener('click', (event) => { event.stopPropagation(); openBoostDialog(Math.max(0, from - 0.5), to + 0.5); });
    row.append(label, boostGap);
    row.addEventListener('click', () => showPosition(from));
    section.appendChild(row);
  };
  // Words flow together while the same people are speaking; a new speaker starts a new bubble at the word where they
  // begin, a pause of paragraphPauseSeconds starts a new paragraph, and the time is shown on its own, centered, as
  // each minute begins. Headings, votes, camera changes, and gaps also end a bubble.
  let bubble = null;
  let paragraph = null;
  let lastMinute = null;
  let lastWordEnd = null;
  const turnTimes = turns.map((turn) => turn.at);
  const speakersFor = (seconds) => {
    let low = 0, high = turnTimes.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (turnTimes[middle] <= seconds + 0.15) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found < 0 ? [] : turns[found].speakers;
  };
  const minuteRow = (minute) => {
    const row = document.createElement('div');
    row.className = 'minute-row';
    const at = minute * 60;
    row.textContent = fmt(at) + (clockMs(at) === null ? '' : ' · ' + clockFormat.format(new Date(clockMs(at))).replace(':00 ', ' '));
    row.addEventListener('click', () => showPosition(at));
    section.appendChild(row);
  };
  const openBubble = (ids) => {
    const row = document.createElement('div');
    row.className = 'turn ' + (ids.length && ids.every((id) => votingIds.has(id)) ? 'right' : 'left');
    const face = document.createElement('div');
    face.className = 'face';
    // Faces at the start of each speaker change (and again after a heading, camera change, or gap).
    const key = ids.join(',');
    if (ids.length && key !== previousSpeakers) {
      ids.forEach((id) => {
        const person = peopleMap.get(id) || { id, name: id };
        const item = document.createElement('span');
        item.className = 'who-person';
        item.title = nameAndRole(person) + ' — click to clip everything they say here';
        const at = lastWordEnd ?? 0;
        item.addEventListener('click', (event) => { event.stopPropagation(); clipSpeaker(id, Number(row.dataset.start || at) + 0.01); });
        const label = document.createElement('small');
        label.textContent = lastName(person);
        item.append(avatar(person), label);
        face.appendChild(item);
      });
      row.classList.add('first');
    }
    previousSpeakers = key;
    const body = document.createElement('div');
    body.className = 'bubble';
    row.append(face, body);
    section.appendChild(row);
    bubble = { key, row, body };
    paragraph = null;
  };
  const openParagraph = (startAt) => {
    const element = document.createElement('p');
    element.className = 'para';
    // On hover: boost this paragraph (and a moment either side).
    const boostButton = document.createElement('button');
    boostButton.type = 'button';
    boostButton.className = 'line-boost';
    boostButton.textContent = '🔊';
    boostButton.title = 'Boost this and transcribe it again';
    element.appendChild(boostButton);
    element.addEventListener('click', () => showPosition(Number(element.dataset.start)));
    element.dataset.start = startAt;
    bubble.body.appendChild(element);
    const own = { el: element, element, start: startAt, end: startAt, words: [] };
    boostButton.addEventListener('click', (event) => { event.stopPropagation(); openBoostDialog(Math.max(0, own.start - 0.5), own.end + 0.5); });
    if (!bubble.row.dataset.start) bubble.row.dataset.start = startAt;
    pieceList.push(own);
    paragraph = own;
  };
  transcript.forEach(([startSeconds, endSeconds, text, retranscribed, timedWords], index) => {
    if (!inRange(startSeconds)) return;
    if (lastEnd !== null && startSeconds - lastEnd >= silenceMinimumSeconds) silenceRow(lastEnd, startSeconds);
    lastEnd = Math.max(lastEnd ?? 0, endSeconds);
    // Open a section for every scene change up to this line (the last one before the line gets its own).
    while (sceneIndex + 1 < scenes.length && scenes[sceneIndex + 1][0] <= startSeconds + 0.5) {
      sceneIndex += 1;
      if (sceneIndex + 1 < scenes.length && scenes[sceneIndex + 1][0] <= startSeconds + 0.5) continue;
      startSection(scenes[sceneIndex]);
    }
    // Agenda items that start by this line come first, as headings.
    while (agendaIndex < agendaItems.length && agendaItems[agendaIndex].at <= startSeconds + 0.5) {
      const item = agendaItems[agendaIndex++];
      if (!range || item.at >= range.min - 0.01) agendaHeading(item);
    }
    // Votes taken by this line, as a row with the result.
    while (voteIndex < sortedVotes.length && sortedVotes[voteIndex].at <= startSeconds + 0.5) {
      const event = sortedVotes[voteIndex++];
      if (!range || event.at >= range.min - 0.01) voteRow(event);
    }
    const words = lineWordList(startSeconds, endSeconds, text, timedWords);
    words.forEach((word, wordIndex) => {
      const minute = Math.floor(word.at / 60);
      if (minute !== lastMinute) { minuteRow(minute); lastMinute = minute; }
      const ids = speakersFor(word.at + 0.01);
      // Anything added to the section since (a heading, a vote, an image, a gap, a minute) ends the bubble.
      if (!bubble || bubble.key !== ids.join(',') || section.lastElementChild !== bubble.row) openBubble(ids);
      if (!paragraph || (lastWordEnd !== null && word.at - lastWordEnd >= paragraphPauseSeconds)) openParagraph(word.at);
      const span = document.createElement('span');
      span.className = 'w';
      span.dataset.line = index;
      span.textContent = word.edited ? (word.display || word.original) : word.text;
      if (word.edited) {
        span.classList.add(word.display ? 'edited' : 'deleted');
        span.title = word.display ? 'Corrected from “' + word.original + '”' : 'Deleted: “' + word.original + '”';
      } else if (retranscribed) {
        span.classList.add('retranscribed');
        span.title = 'Re-transcribed after a volume boost';
      }
      if (turns.some((turn) => Math.abs(turn.at - word.at) < 0.06)) span.classList.add('change');
      if (index === findIndex) span.classList.add('match');
      span.addEventListener('click', (event) => {
        event.stopPropagation();
        showPosition(word.at);
        openWordPicker(word, span);
      });
      paragraph.element.append(span, ' ');
      paragraph.words.push([word.at, span]);
      paragraph.end = Math.max(paragraph.end, word.end);
      lastWordEnd = word.end;
      if (wordIndex === 0 && !lineElements[index]) lineElements[index] = span;
    });
    shownLines += 1;
  });
  if (!shownLines && transcript.length) {
    const empty = document.createElement('p');
    empty.className = 'transcript-empty';
    empty.textContent = 'Nothing was said in this chapter.';
    transcriptList.appendChild(empty);
  }
  transcriptList.scrollTop = keepScroll;
  activePiece = -1;
  syncTranscript();
  updateNowScene();
}
// Scrolls the list so a line sits a third of the way down.
function scrollToLine(line) {
  const offset = line.getBoundingClientRect().top - transcriptList.getBoundingClientRect().top;
  transcriptList.scrollTo({ top: Math.max(0, transcriptList.scrollTop + offset - transcriptList.clientHeight / 3), behavior: 'smooth' });
}
function pieceAt(seconds) {
  let low = 0, high = pieceList.length - 1, found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (pieceList[middle].start <= seconds + 0.05) { found = middle; low = middle + 1; } else high = middle - 1;
  }
  return found;
}
function syncTranscript() {
  if (!transcript.length) return;
  const index = pieceAt(position);
  if (index !== activePiece) {
    pieceList[activePiece]?.el.classList.remove('active');
    activePiece = index;
    const piece = pieceList[index];
    if (piece) {
      piece.el.classList.add('active');
      // Don't pull the list away while someone is reading or scrolling it.
      if (Date.now() - userScrolledAt > 4000) scrollToLine(piece.el);
    }
  }
  updateNowWord();
}
// The word being said, highlighted (smoothly while playing).
function updateNowWord() {
  const piece = pieceList[activePiece];
  let found = null;
  if (piece && position <= piece.end + 0.3) {
    for (const [at, span] of piece.words) { if (at <= position + 0.02) found = span; else break; }
  }
  if (found === nowWord) return;
  nowWord?.classList.remove('now');
  found?.classList.add('now');
  nowWord = found;
}
function followWords() {
  if (video.paused || !playerReady) return;
  const current = toPosition(video.currentTime);
  if (Math.abs(current - position) < 1) { position = current; updateNowWord(); }
  requestAnimationFrame(followWords);
}
video.addEventListener('play', () => requestAnimationFrame(followWords));

