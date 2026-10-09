import { useState } from 'react';
import Dialog from '../Dialog.tsx';

// Choosing one of the meeting's documents (consent agenda, chapters' files, official sources) to link words to,
// grouped, with a find box.
export interface MeetingDocument {
  group: string;
  label: string;
  url: string;
}

export default function DocumentPicker({
  words,
  documents,
  onPick,
  onClose
}: {
  words: string;
  documents: MeetingDocument[];
  onPick: (document: MeetingDocument) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  return (
    <Dialog title="Link to a meeting document" onClose={onClose}>
      <p className="muted small">“{words}”</p>
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Find a document"
        aria-label="Find a document"
      />
      {[...new Set(documents.map((document) => document.group))].map((group) => (
        <div key={group} className="document-group">
          <h3>{group}</h3>
          <ul className="document-pick">
            {documents
              .filter(
                (document) => document.group === group && (!needle || document.label.toLowerCase().includes(needle))
              )
              .map((document) => (
                <li key={document.url}>
                  <button type="button" className="link-button" onClick={() => onPick(document)}>
                    {document.label}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </Dialog>
  );
}
