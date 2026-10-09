import { useState, type DragEvent, type FormEvent } from 'react';
import { officialLinks } from '../../../src/sync/official.js';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { uploadPicture } from '../data/upload.ts';
import { LAYER_KINDS, type LayerKind } from './layers.ts';
import type { Official } from '../meeting/OfficialPanel.tsx';

// What goes over the video: links (shown as QR codes) and pictures kept in the library (collection library, shared by
// every video), the documents of this video's meetings, and the other layers (a QR code to the official video that
// changes each second, a picture in picture, a blurred area). Drag one onto the preview to put it there at the
// playhead, or press its ＋.
export interface LibraryItem {
  kind: 'link' | 'image';
  label: string;
  url?: string;
  path?: string;
  width?: number;
  height?: number;
}
export const LIBRARY_DRAG = 'application/x-streamscribe-library';

export default function LibraryPanel({
  editable,
  officials,
  onAdd,
  onAddLayer
}: {
  editable: boolean;
  // The official sources of the video's meetings (their documents can be QR codes too).
  officials: (Official | null)[];
  onAdd: (item: LibraryItem) => void;
  onAddLayer: (kind: LayerKind) => void;
}) {
  const { records: library } = useRecords<LibraryItem>('library');
  const [link, setLink] = useState({ label: '', url: '' });
  const [message, setMessage] = useState('');
  const documents = [
    ...new Map(
      officials
        .flatMap((official) => officialLinks(official) as { group: string; label: string; url: string }[])
        .filter((item) => item.group === 'Documents' || item.label === 'Watch')
        .map((item): [string, LibraryItem] => [
          item.url,
          { kind: 'link', label: item.label === 'Watch' ? 'The official video' : item.label, url: item.url }
        ])
    ).values()
  ];
  const addLink = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^https?:\/\/\S+$/.test(link.url.trim())) return setMessage('A web address starts with https://');
    await putRecord('library', null, {
      kind: 'link',
      label: link.label.trim() || link.url.trim(),
      url: link.url.trim()
    });
    setLink({ label: '', url: '' });
    setMessage('');
  };
  const addPicture = async (file: File | undefined) => {
    if (!file) return;
    setMessage(`Sending ${file.name}…`);
    try {
      const sent = await uploadPicture(file);
      await putRecord('library', null, {
        kind: 'image',
        label: file.name.replace(/\.[^.]+$/, ''),
        path: sent.path,
        width: sent.width,
        height: sent.height
      });
      setMessage('');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const dragStart = (item: LibraryItem) => (event: DragEvent<HTMLElement>) => {
    event.dataTransfer.setData(LIBRARY_DRAG, JSON.stringify(item));
    event.dataTransfer.effectAllowed = 'copy';
  };
  const row = (item: LibraryItem, key: string, remove?: () => void) => (
    // Dragging onto the preview is for the pointer; ＋ adds it from the keyboard.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li key={key} draggable={editable} onDragStart={dragStart(item)} className="library-item">
      <span className="grow" title={item.url || item.label}>
        {item.kind === 'image' ? '🖼' : '▦'} {item.label}
      </span>
      {editable && (
        <button type="button" className="link-button" onClick={() => onAdd(item)} aria-label={`Add ${item.label}`}>
          ＋
        </button>
      )}
      {editable && remove && (
        <button type="button" className="link-button danger" onClick={remove} aria-label={`Remove ${item.label}`}>
          ×
        </button>
      )}
    </li>
  );

  return (
    <section className="panel library-panel">
      <h2>Over the video</h2>
      {editable && (
        <div className="toolbar small">
          {(['official-qr', 'pip', 'blur'] as LayerKind[]).map((kind) => (
            <button key={kind} type="button" className="button" onClick={() => onAddLayer(kind)}>
              {LAYER_KINDS[kind].icon}{' '}
              {kind === 'official-qr' ? 'Official video QR' : LAYER_KINDS[kind].label.split(' (')[0]}
            </button>
          ))}
        </div>
      )}
      <h3>Library</h3>
      <ul className="library-list">
        {(library || [])
          .sort((a, b) => a.data.label.localeCompare(b.data.label))
          .map((item) => row(item.data, item.id, () => removeRecord('library', item.id)))}
      </ul>
      {(library || []).length === 0 && (
        <p className="muted small">Links and pictures you add stay here for any video.</p>
      )}
      {editable && (
        <>
          <form className="toolbar small" onSubmit={addLink}>
            <input
              value={link.label}
              onChange={(event) => setLink({ ...link, label: event.target.value })}
              placeholder="Label"
              aria-label="The link's label"
            />
            <input
              type="url"
              value={link.url}
              onChange={(event) => setLink({ ...link, url: event.target.value })}
              placeholder="https://"
              aria-label="The link's address"
            />
            <button type="submit" className="button">
              Add link
            </button>
          </form>
          <label className="small">
            Add a picture{' '}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => addPicture(event.target.files?.[0])}
            />
          </label>
        </>
      )}
      {message && <p className="note small">{message}</p>}
      {documents.length > 0 && (
        <>
          <h3>From this video&apos;s meetings</h3>
          <ul className="library-list">{documents.map((item) => row(item, item.url!))}</ul>
        </>
      )}
    </section>
  );
}
