// The transcript's words: corrections made on this page, each line's words with their times, and the word being
// said as the video plays.
// Word corrections ({ transcript, line, index, original, text }; text '' deletes the word, and several words replace
// it), saved in {session}/word-edits.json. Each applies only while the word there is still the one corrected.
let wordEdits = [];
const wordEditFor = (line, index, original) =>
  wordEdits.find(
    (edit) =>
      edit.transcript === transcriptName && edit.line === line && edit.index === index && edit.original === original
  );
async function saveWordEdit(word, text) {
  const original = word.edited ? word.original : word.text;
  wordEdits = wordEdits.filter(
    (edit) => !(edit.transcript === transcriptName && edit.line === word.line && edit.index === word.index)
  );
  if (text !== original)
    wordEdits.push({
      transcript: transcriptName,
      line: word.line,
      index: word.index,
      at: word.at,
      original,
      text,
      updatedAt: new Date().toISOString()
    });
  renderTranscript();
  try {
    await putFile(
      '../word-edits.json',
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          note: 'Word corrections from the thumbnails page: line is the line start (seconds), index the word number in it.',
          edits: wordEdits
        },
        null,
        2
      ),
      'application/json'
    );
    $('snapshot-status').textContent =
      text === original
        ? 'Restored “' + original + '”'
        : text
          ? 'Corrected “' + original + '” to “' + text + '”'
          : 'Deleted “' + original + '”';
  } catch (error) {
    $('snapshot-status').textContent = 'Correction not saved: ' + error.message;
  }
}
// A transcript line's words, each { text, at, end, line, index } with any correction (edited, display, original):
// times from the transcript where it has them (transcribe --best), or else estimated.
function lineWordList(startSeconds, endSeconds, text, timedWords) {
  const words =
    timedWords && timedWords.length
      ? timedWords.map(([at, end, said]) => ({ text: said, at: Math.round(at * 100) / 100, end: Number(end) }))
      : lineWords(startSeconds, endSeconds, text);
  // Corrections made on this page (word-edits.json), matched by line, word number, and the word as transcribed.
  const lineKey = Math.round(startSeconds * 100) / 100;
  words.forEach((word, wordIndex) => {
    word.line = lineKey;
    word.index = wordIndex;
    if (!(word.end > word.at)) word.end = wordIndex + 1 < words.length ? words[wordIndex + 1].at : endSeconds;
    const edit = wordEditFor(lineKey, wordIndex, word.text);
    if (edit) {
      word.original = word.text;
      word.edited = true;
      word.display = edit.text;
    }
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
    const at = Math.round((startSeconds + (span * used) / total) * 100) / 100;
    used += word.length + 1;
    return { text: word, at };
  });
}
// The word being said, highlighted (smoothly while playing).
function updateNowWord() {
  const piece = pieceList[activePiece];
  let found = null;
  if (piece && position <= piece.end + 0.3) {
    for (const [at, span] of piece.words) {
      if (at <= position + 0.02) found = span;
      else break;
    }
  }
  if (found === nowWord) return;
  nowWord?.classList.remove('now');
  found?.classList.add('now');
  nowWord = found;
}
function followWords() {
  if (video.paused || !playerReady) return;
  const current = toPosition(video.currentTime);
  if (Math.abs(current - position) < 1) {
    position = current;
    updateNowWord();
  }
  requestAnimationFrame(followWords);
}
video.addEventListener('play', () => requestAnimationFrame(followWords));
