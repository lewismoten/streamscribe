import { useEffect, useRef, useState, type FormEvent } from 'react';
import { clock } from '../format.ts';
import LinkForm from './LinkForm.tsx';
import type { TranscriptLink } from './links.ts';
import { personName, type Person, type Word } from './words.ts';

// Changing one word of the transcript, opened by clicking it: correct, delete, or restore the word, say who is
// speaking from it on, add someone new speaking from it, or link a phrase from it (a web page, a Bible passage). It's
// shown in a dialog (see Transcript); Escape closes it.
export default function WordEditor({
  word,
  people,
  speakers,
  onWord,
  onSpeakers,
  onAdd,
  following,
  link,
  onLink,
  onUnlink,
  onClose
}: {
  word: Word;
  people: Person[];
  speakers: string[];
  onWord: (word: Word, text: string) => void;
  onSpeakers: (word: Word, speakers: string[]) => void;
  onAdd: (word: Word, name: string, role: string) => void;
  following: Word[];
  link: TranscriptLink | null;
  onLink: (link: Omit<TranscriptLink, 'id'> & { id?: string }) => void;
  onUnlink: (link: TranscriptLink) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(word.shown);
  const [newPerson, setNewPerson] = useState({ name: '', role: '' });
  const wordInput = useRef<HTMLInputElement>(null);
  // Ready to type the correction as soon as it opens.
  useEffect(() => wordInput.current?.focus(), []);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onWord(word, text.trim());
  };
  const current = speakers.join();
  return (
    <div className="word-editor">
      <form onSubmit={submit}>
        <label>
          Word at {clock(word.at)}{' '}
          <input ref={wordInput} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
        <span className="toolbar">
          <button type="submit" className="button primary">
            Correct
          </button>
          <button type="button" className="button" onClick={() => onWord(word, '')}>
            Delete word
          </button>
          {word.edit && (
            <button type="button" className="button" onClick={() => onWord(word, word.text)}>
              Restore “{word.text}”
            </button>
          )}
        </span>
      </form>
      <label>
        Speaking from here{' '}
        <select
          value={current}
          onChange={(event) => onSpeakers(word, event.target.value ? event.target.value.split(',') : [])}
        >
          <option value="">Nobody / unknown</option>
          {/* Speakers saved together (or someone no longer listed) keep a choice of their own. */}
          {!people.some((person) => person.id === current) && speakers.length > 0 && (
            <option value={current}>{speakers.join(', ')}</option>
          )}
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {personName(person, person.id)}
              {person.role && !person.nameUnknown ? `, ${person.role}` : ''}
            </option>
          ))}
        </select>
      </label>
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (newPerson.name.trim()) onAdd(word, newPerson.name.trim(), newPerson.role.trim());
        }}
      >
        <input
          placeholder="Someone new: name"
          value={newPerson.name}
          onChange={(event) => setNewPerson({ ...newPerson, name: event.target.value })}
          aria-label="New person's name"
        />
        <input
          placeholder="role"
          value={newPerson.role}
          onChange={(event) => setNewPerson({ ...newPerson, role: event.target.value })}
          aria-label="New person's role"
        />
        <button type="submit" className="button">
          Add, speaking from here
        </button>
      </form>
      <LinkForm word={word} following={following} link={link} onSave={onLink} onRemove={onUnlink} />
      <button type="button" className="link-button" onClick={onClose}>
        Close
      </button>
    </div>
  );
}
