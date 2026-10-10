// A meeting's transcript as a download (src/sync/transcript-export.js): the simple transcript with chapter headings,
// motions, seconds, and votes where they happened; one chapter alone; word for word; and closed captions timed from
// the start of what's downloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportTranscript, voteResult } from '../src/sync/transcript-export.js';

const said = (at, text, speakers) =>
  text
    .split(' ')
    .map((word, index) => ({ at: at + index * 0.5, end: at + index * 0.5 + 0.4, text: word, speakers, clock: null }));
const parts = [
  {
    name: 'p1',
    index: 0,
    words: [
      ...said(10, 'The meeting will come to order.', ['Chair Pat Lee']),
      ...said(70, 'I move we adopt the agenda.', ['Sam Ray']),
      ...said(75, 'Second.', ['Jo Kim']),
      ...said(130, 'Next is public comment.', ['Chair Pat Lee'])
    ]
  }
];
const chapters = [
  { part: 'p1', at: 0, title: 'Call to Order' },
  { part: 'p1', at: 120, title: 'Public Comment' }
];
const votes = [
  {
    part: 'p1',
    at: 80,
    motion: 'Adopt the agenda',
    movedBy: { name: 'Sam Ray', at: 70 },
    secondedBy: { name: 'Jo Kim', at: 75 },
    result: voteResult({ results: { a: 'for', b: 'for', c: 'for', d: 'against', e: 'absent' } })
  }
];

test('the whole meeting, simple: chapter headings, motions, seconds, and votes in place', () => {
  const file = exportTranscript({ title: 'Town Council, Oct 6', parts, chapters, votes, stamps: 'video' });
  assert.equal(file.name, 'Town Council, Oct 6.txt');
  assert.equal(
    file.text,
    [
      'Town Council, Oct 6',
      '',
      '== Call to Order ==',
      '',
      '[0:00:10]',
      'Chair Pat Lee: The meeting will come to order.',
      '',
      '[0:01:10]',
      '✋ Motion by Sam Ray: Adopt the agenda',
      'Sam Ray: I move we adopt the agenda.',
      '✋ Seconded by Jo Kim',
      'Jo Kim: Second.',
      '🗳 Vote: Adopt the agenda — Passed 3–1 (1 absent)',
      '',
      '== Public Comment ==',
      '',
      '[0:02:10]',
      'Chair Pat Lee: Next is public comment.',
      ''
    ].join('\n')
  );
});

test('one chapter, word for word, and captions', () => {
  const chapter = exportTranscript({
    title: 'Council',
    parts,
    chapters,
    votes,
    range: { part: 'p1', from: 120, to: 200, title: 'Public Comment' }
  });
  assert.equal(chapter.name, 'Council - Public Comment.txt');
  assert.match(
    chapter.text,
    /^Council\nChapter: Public Comment\n\n\[0:02:10\]\nChair Pat Lee: Next is public comment\.\n$/
  );
  assert.doesNotMatch(chapter.text, /== Public Comment ==/, 'its own heading is at the top, not repeated');

  const words = exportTranscript({ title: 'Council', format: 'words', parts, chapters: [], votes: [] });
  assert.equal(words.name, 'Council - word for word.txt');
  assert.match(words.text, /\[0:00:10\.0\]  >> Chair Pat Lee\n\[0:00:10\.0\]  The\n\[0:00:10\.5\]  meeting/);

  const captions = exportTranscript({
    title: 'Council',
    format: 'captions',
    parts,
    range: { part: 'p1', from: 60, to: 100, title: 'Motion' }
  });
  assert.equal(captions.name, 'Council - Motion.srt');
  const cues = captions.text.trim().split('\n\n');
  assert.equal(cues.length, 2, 'a new caption at the speaker change');
  assert.equal(cues[0], '1\n00:00:10,000 --> 00:00:12,900\nSam Ray: I move we adopt the agenda.');
  assert.match(cues[1], /^2\n00:00:15,000 --> /, 'timed from the start of the chapter');
});
