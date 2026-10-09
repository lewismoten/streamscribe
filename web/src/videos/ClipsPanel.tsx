import { useState } from 'react';
import { Link } from 'react-router';
import Dialog from '../Dialog.tsx';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { clock, duration } from '../format.ts';
import ClipForm from './ClipForm.tsx';
import { itemOf, saveClip, type Clip, type Video } from './types.ts';

// A meeting's clips (saved by selecting words in its transcript): each plays from its start, can be renamed or moved,
// removed, or added to a video (made on the Videos page, from clips of any meetings). Clips in the review page's
// playlist that aren't clips here yet can be brought in.
export default function ClipsPanel({
  recordingId,
  playlist,
  canEdit,
  playAt,
  newClip
}: {
  recordingId: string;
  // The review page's playlist, by part.
  playlist: { part: string; title: string; from: number; to: number }[];
  canEdit: boolean;
  playAt: ((part: string, seconds: number) => void) | null;
  newClip: (part: string, from: number, to: number, title: string) => Clip;
}) {
  const { records: clips } = useRecords<Clip>('clips');
  const { records: videos } = useRecords<Video>('videos');
  const [editing, setEditing] = useState<{ id: string; clip: Clip } | null>(null);
  const [message, setMessage] = useState('');
  const mine = (clips || [])
    .filter((record) => record.data.recordingId === recordingId)
    .sort((a, b) => a.data.part.localeCompare(b.data.part) || a.data.from - b.data.from);
  // The playlist's clips not saved as clips yet (the same part, start, and end).
  const waiting = playlist.filter(
    (item) =>
      !mine.some(
        (record) =>
          record.data.part === item.part &&
          Math.abs(record.data.from - item.from) < 0.5 &&
          Math.abs(record.data.to - item.to) < 0.5
      )
  );
  if (!mine.length && !waiting.length && !canEdit) return null;

  const bringIn = async () => {
    for (const item of waiting) await saveClip(null, newClip(item.part, item.from, item.to, item.title || 'Clip'));
    setMessage(`Brought in ${waiting.length} clip${waiting.length === 1 ? '' : 's'} from the playlist`);
  };
  const addTo = async (videoId: string, clipId: string, clip: Clip) => {
    const now = new Date().toISOString();
    if (videoId === 'new') {
      const title = prompt('The new video is called:', clip.title);
      if (!title?.trim()) return;
      await putRecord('videos', null, {
        title: title.trim(),
        description: '',
        items: [itemOf(clipId, clip)],
        createdAt: now,
        updatedAt: now
      } satisfies Video);
      setMessage(`Made the video “${title.trim()}” (Videos)`);
      return;
    }
    const video = videos?.find((record) => record.id === videoId);
    if (!video) return;
    await putRecord('videos', videoId, {
      ...video.data,
      items: [...video.data.items, itemOf(clipId, clip)],
      updatedAt: now
    });
    setMessage(`Added to “${video.data.title}”`);
  };

  return (
    <section className="panel clips">
      <div className="toolbar">
        <h2 className="grow">Clips</h2>
        <Link to="/videos" className="small">
          Videos
        </Link>
      </div>
      {message && <p className="note">{message}</p>}
      {mine.length === 0 && (
        <p className="muted small">None yet. Select words in the transcript and choose “Save as a clip…”.</p>
      )}
      <ul>
        {mine.map((record) => (
          <li key={record.id}>
            {playAt ? (
              <button
                type="button"
                className="time time-link"
                onClick={() => playAt(record.data.part, record.data.from)}
              >
                {clock(record.data.from)}
              </button>
            ) : (
              <span className="time">{clock(record.data.from)}</span>
            )}{' '}
            <strong>{record.data.title}</strong>{' '}
            <span className="muted small">{duration(record.data.to - record.data.from)}</span>
            {canEdit && (
              <div className="toolbar small">
                <select
                  value=""
                  onChange={(event) => event.target.value && addTo(event.target.value, record.id, record.data)}
                  aria-label={`Add “${record.data.title}” to a video`}
                >
                  <option value="">Add to a video…</option>
                  {(videos || []).map((video) => (
                    <option key={video.id} value={video.id}>
                      {video.data.title}
                    </option>
                  ))}
                  <option value="new">＋ A new video</option>
                </select>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setEditing({ id: record.id, clip: record.data })}
                >
                  Change
                </button>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => confirm(`Remove the clip “${record.data.title}”?`) && removeRecord('clips', record.id)}
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {canEdit && waiting.length > 0 && (
        <button type="button" className="button" onClick={bringIn}>
          Bring in {waiting.length} clip{waiting.length === 1 ? '' : 's'} from the review page&apos;s playlist
        </button>
      )}
      {editing && (
        <Dialog title={`Change “${editing.clip.title}”`} onClose={() => setEditing(null)}>
          <ClipForm
            title={editing.clip.title}
            from={editing.clip.from}
            to={editing.clip.to}
            onCancel={() => setEditing(null)}
            onSave={async (value) => {
              await saveClip(editing.id, { ...editing.clip, ...value });
              setEditing(null);
              setMessage('Saved');
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
