import { useState, type FormEvent } from 'react';
import Dialog from '../Dialog.tsx';
import { newId } from '../../../src/sync/collections.js';
import type { Chapter } from './Chapters.tsx';
import { byNumber, parseDocumentName, type ConsentItem, type DocumentLink } from './documents.ts';

// Adding a meeting's documents, one after another: paste a document's name as copied from the agenda (its item's
// number and title, and which file it is) and its address, and add it to a consent agenda item (found by its number,
// or a new one) or to a chapter. The dialog stays open (switching to another window to copy doesn't close it) and is
// ready for the next as each is added.
type Target = { kind: 'consent'; itemId: string } | { kind: 'chapter'; chapterId: string };

export default function DocumentDialog({
  consent,
  chapters,
  start,
  onConsent,
  onChapterLink,
  onClose
}: {
  consent: ConsentItem[];
  chapters: Chapter[];
  start: Target | null;
  onConsent: (items: ConsentItem[], done: string) => Promise<void>;
  onChapterLink: (chapter: Chapter, link: DocumentLink) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [label, setLabel] = useState('');
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState<string>(
    start?.kind === 'chapter'
      ? `chapter:${start.chapterId}`
      : start?.kind === 'consent'
        ? `consent:${start.itemId}`
        : 'consent:new'
  );
  const [added, setAdded] = useState<string[]>([]);
  const [problem, setProblem] = useState('');
  const sorted = [...consent].sort(byNumber);

  // A pasted name fills in its parts (and finds its consent item by number).
  const readName = (text: string) => {
    setName(text);
    const parts = parseDocumentName(text);
    setLabel(parts.label || label);
    if (parts.number) {
      setNumber(parts.number);
      setTitle(parts.title);
      const found = consent.find((item) => item.number === parts.number);
      setTarget(found ? `consent:${found.id}` : 'consent:new');
    } else if (!title) setTitle(parts.title);
  };
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setProblem('');
    if (!/^https?:\/\/\S+$/.test(url.trim())) return setProblem('Paste its address (starting https://)');
    const link = { label: label.trim() || 'Document', url: url.trim() };
    if (target.startsWith('chapter:')) {
      const chapter = chapters.find((item) => item.id === target.slice(8));
      if (!chapter) return setProblem('Choose where it goes');
      await onChapterLink(chapter, link);
      setAdded([`${link.label} → ${chapter.title}`, ...added]);
    } else {
      const itemId = target.slice(8);
      const existing = consent.find((item) => item.id === itemId);
      if (!existing && !number.trim() && !title.trim()) return setProblem("Give the consent item's number or title");
      const item: ConsentItem = existing
        ? { ...existing, links: [...existing.links.filter((other) => other.url !== link.url), link] }
        : { id: newId(), number: number.trim(), title: title.trim(), links: [link] };
      await onConsent(
        [...consent.filter((other) => other.id !== item.id), item],
        `Added ${link.label} to ${item.number || item.title}`
      );
      setAdded([`${link.label} → ${item.number} ${item.title}`, ...added]);
      setTarget(`consent:${item.id}`);
    }
    // Ready for the next document (of the same item, usually).
    setName('');
    setUrl('');
    setLabel('');
  };

  return (
    <Dialog title="Add documents" onClose={onClose}>
      <form className="schedule-form document-form" onSubmit={add}>
        <label className="block">
          Its name, as copied from the agenda
          <textarea
            rows={3}
            value={name}
            onChange={(event) => readName(event.target.value)}
            placeholder="I.1. Authorization to Advertise for Public Hearing - … - Cover Sheet"
          />
        </label>
        <div className="form-grid">
          <label>
            Address
            <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" />
          </label>
          <label>
            This file is
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Cover Sheet" />
          </label>
          <label>
            It goes with
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              <optgroup label="Consent agenda">
                <option value="consent:new">A new consent item</option>
                {sorted.map((item) => (
                  <option key={item.id} value={`consent:${item.id}`}>
                    {item.number} {item.title.length > 60 ? `${item.title.slice(0, 57)}…` : item.title}
                  </option>
                ))}
              </optgroup>
              {chapters.length > 0 && (
                <optgroup label="Chapters">
                  {chapters.map((chapter) => (
                    <option key={chapter.id} value={`chapter:${chapter.id}`}>
                      {chapter.title}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
          {target === 'consent:new' && (
            <>
              <label>
                Item number
                <input value={number} onChange={(event) => setNumber(event.target.value)} placeholder="I.1" />
              </label>
              <label>
                Item title
                <input value={title} onChange={(event) => setTitle(event.target.value)} />
              </label>
            </>
          )}
        </div>
        {problem && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
        <div className="toolbar">
          <button type="submit" className="button primary">
            Add
          </button>
          <button type="button" className="button" onClick={onClose}>
            Done
          </button>
        </div>
        {added.length > 0 && (
          <output className="block">
            Added:
            <ul className="small">
              {added.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </output>
        )}
      </form>
    </Dialog>
  );
}
