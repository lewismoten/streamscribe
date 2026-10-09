import { useState, type FormEvent } from 'react';
import { BOOKS, passageName, validReference } from '../religion/bible.ts';
import type { TranscriptLink } from './links.ts';
import type { Word } from './words.ts';

// Linking a phrase of the transcript: to a web page, or naming a Bible passage (book, chapters and verses), which
// links through the scripture site. In a word's editor (from that word through a later one), or for words selected
// in the transcript (the phrase is fixed: those words).
export default function LinkForm({
  word,
  following,
  link,
  fixed = false,
  startWith,
  onSave,
  onRemove
}: {
  word: Word;
  // The clicked word and the ones after it (into the next lines), to end the phrase on.
  following: Word[];
  link: TranscriptLink | null;
  // The phrase is exactly the words given (selected in the transcript): no choosing where it ends.
  fixed?: boolean;
  startWith?: 'web' | 'passage';
  onSave: (link: Omit<TranscriptLink, 'id'> & { id?: string }) => void;
  onRemove: (link: TranscriptLink) => void;
}) {
  const startsHere = !link || (link.from.line === word.line && link.from.index === word.index);
  const last = following.at(-1) || word;
  const [through, setThrough] = useState(
    link ? `${link.to.line}:${link.to.index}` : fixed ? `${last.line}:${last.index}` : `${word.line}:${word.index}`
  );
  const [kind, setKind] = useState<'web' | 'passage'>(
    link?.passage ? 'passage' : link?.url ? 'web' : startWith || 'passage'
  );
  const [url, setUrl] = useState(link?.url || '');
  const [book, setBook] = useState(link?.passage?.book || '');
  const [reference, setReference] = useState(link?.passage?.reference || '');
  const [problem, setProblem] = useState('');
  const end = following.find((item) => `${item.line}:${item.index}` === through) || word;
  const phrase = following
    .slice(0, following.indexOf(end) + 1)
    .map((item) => item.shown)
    .filter(Boolean)
    .join(' ');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const base = {
      ...(link ? { id: link.id } : {}),
      from: link && !startsHere ? link.from : { line: word.line, index: word.index },
      to: { line: end.line, index: end.index },
      at: link && !startsHere ? link.at : word.at,
      text: phrase
    };
    if (kind === 'web') {
      if (!/^https?:\/\/\S+$/.test(url.trim())) return setProblem('A web address starts with https://');
      onSave({ ...base, url: url.trim() });
    } else {
      if (!BOOKS.includes(book)) return setProblem('Choose a book of the Bible');
      if (!validReference(reference)) return setProblem('Chapters and verses, such as 121-122 or 3:16-18');
      onSave({ ...base, passage: { book, reference: reference.trim() } });
    }
  };

  return (
    <form className="link-form" onSubmit={submit}>
      <strong>{link ? 'This link' : 'Link from here'}</strong>
      {startsHere && !fixed && (
        <label>
          Through{' '}
          <select value={through} onChange={(event) => setThrough(event.target.value)}>
            {following.map((item) => (
              <option key={`${item.line}:${item.index}`} value={`${item.line}:${item.index}`}>
                {item.shown || '(deleted)'}
              </option>
            ))}
          </select>
        </label>
      )}
      <span className="muted small">“{phrase}”</span>
      <fieldset className="segmented" aria-label="Link to">
        <button type="button" className={kind === 'passage' ? 'on' : ''} onClick={() => setKind('passage')}>
          Bible passage
        </button>
        <button type="button" className={kind === 'web' ? 'on' : ''} onClick={() => setKind('web')}>
          Web page
        </button>
      </fieldset>
      {kind === 'passage' ? (
        <span className="toolbar">
          <label>
            Book{' '}
            <input
              value={book}
              onChange={(event) => setBook(event.target.value)}
              list="bible-books"
              placeholder="Psalms"
            />
          </label>
          <datalist id="bible-books">
            {BOOKS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </datalist>
          <label>
            Chapters and verses{' '}
            <input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="121-122" />
          </label>
        </span>
      ) : (
        <label>
          Web address{' '}
          <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
        </label>
      )}
      {problem && (
        <span className="error" role="alert">
          {problem}
        </span>
      )}
      <span className="toolbar">
        <button type="submit" className="button">
          {link ? 'Save link' : kind === 'passage' && book ? `Link ${passageName({ book, reference })}` : 'Add link'}
        </button>
        {link && (
          <button type="button" className="link-button" onClick={() => onRemove(link)}>
            Remove link
          </button>
        )}
      </span>
    </form>
  );
}
