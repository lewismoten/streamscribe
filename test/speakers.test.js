// Who is speaking, word by word (web/src/meeting): a speaker change is saved at its word's time and replaces only a
// change on that same word, and a change counts from its own word, not the one before. A quick roll call is the case:
// "Mr. Carter?" (the clerk) "Aye." (Supervisor Carter) a fraction of a second apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcriptEdits } from '../web/src/meeting/edits.ts';
import { speakersIn } from '../web/src/meeting/words.ts';

const word = (at, text, index) => ({ text, shown: text, at, line: 10, index, edit: null, part: 'p0' });

test('a roll call: each quick word keeps its own speaker', async () => {
  let turns = [{ at: 0, speakers: ['chair'] }];
  const edits = transcriptEdits({
    id: 'r1',
    peopleId: 'town:people',
    people: [],
    markData: () => ({ turns }),
    save: async (markId, value) => {
      turns = value.turns;
    },
    closeEditor: () => {}
  });
  const words = [word(10.0, 'Mr.', 0), word(10.12, 'Carter?', 1), word(10.24, 'Aye.', 2), word(10.36, 'Mrs.', 3)];
  await edits.saveSpeakers(words[0], ['clerk']);
  await edits.saveSpeakers(words[2], ['carter']);
  await edits.saveSpeakers(words[3], ['clerk']);
  assert.deepEqual(
    turns.map((turn) => [turn.at, turn.speakers.join()]),
    [
      [0, 'chair'],
      [10, 'clerk'],
      [10.24, 'carter'],
      [10.36, 'clerk']
    ],
    'the clerk on "Mr." stays when Carter is marked on "Aye." a quarter second later'
  );
  assert.deepEqual(
    words.map((item) => speakersIn(turns, item.at).join()),
    ['clerk', 'clerk', 'carter', 'clerk'],
    '"Carter?" (0.12 s before "Aye.") is still the clerk'
  );
  // Changing a word's speaker again replaces the change on that word only.
  await edits.saveSpeakers(words[2], ['carter', 'everyone']);
  assert.equal(turns.length, 4);
  assert.equal(speakersIn(turns, 10.24).join(), 'carter,everyone');
});
