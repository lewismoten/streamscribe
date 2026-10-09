import { clock } from '../format.ts';
import { personName, round, SAME_MOMENT, type Person, type Turn, type Word, type WordEdit } from './words.ts';

// The changes a signed-in person makes from the transcript: correcting (or deleting, or restoring) a word, saying who
// is speaking from a word on, and adding someone new to the source's people. Each is saved as their own layer of the
// mark it changes (save, from useMeetingMarks), which reports what was done; the word's editor closes as it saves.
export function transcriptEdits({
  id,
  peopleId,
  people,
  markData,
  save,
  closeEditor
}: {
  id: string;
  peopleId: string;
  people: Person[];
  markData: <T>(markId: string) => T | null;
  save: (markId: string, value: Record<string, unknown>, done: string) => Promise<void>;
  closeEditor: () => void;
}) {
  const peopleMap = new Map(people.map((person) => [person.id, person]));

  const saveWord = (word: Word, text: string) => {
    const markId = `${id}:${word.part}:word-edits`;
    const current = markData<{ edits?: WordEdit[] }>(markId) || {};
    const original = word.text;
    const edits = (current.edits || []).filter(
      (edit) => !(edit.transcript === 'latest' && edit.line === word.line && edit.index === word.index)
    );
    if (text !== original)
      edits.push({
        transcript: 'latest',
        line: word.line,
        index: word.index,
        at: word.at,
        original,
        text,
        updatedAt: new Date().toISOString()
      });
    closeEditor();
    return save(
      markId,
      { ...current, edits },
      text === original
        ? `Restored “${original}”`
        : text
          ? `Corrected “${original}” to “${text}”`
          : `Deleted “${original}”`
    );
  };

  // Who is speaking from a word on, at the word's own time: a change already on that word is replaced (only that one:
  // in a quick roll call, the clerk's change on the word before stays); one repeating the turn before goes.
  const saveSpeakers = (word: Word, speakers: string[], names: Record<string, string> = {}) => {
    const markId = `${id}:${word.part}:speakers`;
    const current = markData<{ turns?: Turn[] }>(markId) || {};
    const at = round(word.at);
    let turns = (current.turns || []).filter((turn) => Math.abs(turn.at - at) > SAME_MOMENT);
    turns.push({ at, speakers });
    turns.sort((a, b) => a.at - b.at);
    turns = turns.filter(
      (turn, index) => index === 0 || JSON.stringify(turn.speakers) !== JSON.stringify(turns[index - 1].speakers)
    );
    closeEditor();
    return save(
      markId,
      { ...current, turns },
      `${speakers.map((speaker) => names[speaker] || personName(peopleMap.get(speaker), speaker)).join(' and ') || 'Nobody'} speaking from ${clock(at)}`
    );
  };

  // Someone new, with an id made from their name (and a few random letters so two of the same name differ), then
  // speaking from the word.
  const addPerson = async (word: Word, name: string, role: string) => {
    const current = markData<{ people?: Person[]; groups?: unknown[] }>(peopleId) || {};
    const person = {
      id: `${
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '') || 'person'
      }-${Math.random().toString(36).slice(2, 6)}`,
      name,
      role
    };
    await save(peopleId, { ...current, people: [...(current.people || []), person] }, `Added ${name}`);
    await saveSpeakers(word, [person.id], { [person.id]: name });
  };

  return { saveWord, saveSpeakers, addPerson };
}
