import { useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { hubCall } from '../data/hub.ts';
import { syncClient, syncNow } from '../data/sync.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { clock, date, duration } from '../format.ts';
import type { Publication } from '../published/types.ts';
import VideoPreview from './VideoPreview.tsx';
import { itemOf, seconds, type Clip, type Video, type VideoItem } from './types.ts';

// Putting a video together: the clips of every meeting on one side (found by title or meeting), the video's clips in
// order on the other. Clips are added with their button or dragged in; the video's clips are dragged into order (or
// moved with their arrows), and removed. The preview plays them in a row. Publishing (for people who may publish)
// has an agent with those recordings join the clips into one video, on a page of its own for everyone.
const now = () => new Date().toISOString();
// DRAG_NOTE: dragging is for the mouse; the Add button and each clip's arrows and ✕ do the same from the keyboard.

export default function VideoPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const navigate = useNavigate();
  const { records: videos } = useRecords<Video>('videos');
  const { records: clips } = useRecords<Clip>('clips');
  const { records: publications } = useRecords<Publication>('publications');
  const [filter, setFilter] = useState('');
  const [dragging, setDragging] = useState<{ kind: 'clip' | 'item'; id: string } | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  // Changes are saved one at a time, each to the video as last saved (quick changes, such as a title then a clip
  // added, would otherwise overwrite each other).
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const save = (change: Partial<Video> | ((current: Video) => Partial<Video>)) => {
    queue.current = queue.current.then(async () => {
      const current = (await syncClient().get('videos', id))?.data as Video | undefined;
      if (!current) return;
      await putRecord('videos', id, {
        ...current,
        ...(typeof change === 'function' ? change(current) : change),
        updatedAt: now()
      });
    });
    return queue.current;
  };
  const record = videos?.find((item) => item.id === id);
  if (!can('view.meetings', account)) return <p className="empty">Videos are made from meetings, which are private.</p>;
  if (!videos || !clips) return <p className="empty">Loading…</p>;
  if (!record)
    return (
      <p>
        No such video. <Link to="/videos">All videos</Link>
      </p>
    );
  const video = record.data;
  const editable = Boolean(account.user);
  const publication = video.publicationId ? publications?.find((item) => item.id === video.publicationId) : undefined;

  const changeItems = (change: (items: VideoItem[]) => VideoItem[]) =>
    save((current) => ({ items: change(current.items) }));
  const insert = (at: number, item: VideoItem) =>
    changeItems((items) => [...items.slice(0, at), item, ...items.slice(at)]);
  const move = (from: number, to: number) =>
    changeItems((items) => {
      if (to < 0 || to >= items.length) return items;
      const moved = [...items];
      const [item] = moved.splice(from, 1);
      moved.splice(to, 0, item);
      return moved;
    });
  // Dropped at a place in the video: a clip from the library goes in there; one of the video's clips moves there.
  const drop = (at: number) => (event: DragEvent) => {
    event.preventDefault();
    setOver(null);
    if (!dragging) return;
    if (dragging.kind === 'clip') {
      const clip = clips.find((item) => item.id === dragging.id);
      if (clip) insert(at, itemOf(clip.id, clip.data));
    } else {
      const from = video.items.findIndex((item) => item.key === dragging.id);
      if (from >= 0) move(from, from < at ? at - 1 : at);
    }
    setDragging(null);
  };
  const dragOver = (at: number) => (event: DragEvent) => {
    event.preventDefault();
    setOver(at);
  };
  const publish = async () => {
    setMessage('');
    try {
      await queue.current;
      await syncNow();
      const reply = await hubCall<{ id: string }>('publish-video', { id });
      await syncNow();
      setMessage(`Published: an agent is joining the clips (see Agents). The page: /published/${reply.id}`);
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const needle = filter.trim().toLowerCase();
  const library = clips
    .filter(
      (item) => !needle || [item.data.title, item.data.meeting].some((text) => text?.toLowerCase().includes(needle))
    )
    .sort(
      (a, b) =>
        String(b.data.recordedAt).localeCompare(String(a.data.recordedAt)) ||
        a.data.part.localeCompare(b.data.part) ||
        a.data.from - b.data.from
    );
  const meetings = [...new Set(library.map((item) => `${item.data.recordedAt}|${item.data.meeting}`))];

  return (
    <article className="video-editor">
      <div className="card-kind">
        <Link to="/videos">Videos</Link>
      </div>
      <div className="toolbar">
        <input
          className="video-title grow"
          value={video.title}
          onChange={(event) => save({ title: event.target.value })}
          disabled={!editable}
          aria-label="The video's title"
        />
        {can('publish', account) && (
          <button type="button" className="button primary" onClick={publish} disabled={!video.items.length}>
            {publication ? 'Publish again' : 'Publish'}
          </button>
        )}
        {editable && (
          <button
            type="button"
            className="link-button danger"
            onClick={async () => {
              if (!confirm(`Delete the video “${video.title}”? (A published copy stays published.)`)) return;
              await removeRecord('videos', id);
              navigate('/videos');
            }}
          >
            Delete
          </button>
        )}
      </div>
      <label className="block">
        Description (shown with it when published)
        <textarea
          rows={2}
          value={video.description}
          onChange={(event) => save({ description: event.target.value })}
          disabled={!editable}
        />
      </label>
      {message && <p className="note">{message}</p>}
      {publication && (
        <p className="small">
          Published as <Link to={`/published/${publication.id}`}>{publication.data.title}</Link>
          {publication.data.clip?.status === 'ready'
            ? ' (ready)'
            : publication.data.clip?.status === 'failed'
              ? ` (couldn't be made: ${publication.data.clip.error || 'unknown error'})`
              : ' (an agent is joining the clips)'}
          . Changes here show there when it&apos;s published again.
        </p>
      )}

      <div className="video-columns">
        <section className="panel">
          <div className="toolbar">
            <h2 className="grow">Clips</h2>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find a clip or meeting"
              aria-label="Find a clip or meeting"
            />
          </div>
          {clips.length === 0 && (
            <p className="muted small">
              None yet: on a meeting&apos;s page, select words in its transcript and choose “Save as a clip…”.
            </p>
          )}
          {meetings.map((key) => {
            const [recordedAt, meeting] = key.split('|');
            return (
              <div key={key} className="clip-meeting">
                <h3>
                  {meeting} <span className="muted small">{recordedAt !== 'null' ? date(recordedAt) : ''}</span>
                </h3>
                <ul className="clip-library">
                  {library
                    .filter((item) => `${item.data.recordedAt}|${item.data.meeting}` === key)
                    .map((item) => (
                      // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- DRAG_NOTE
                      <li
                        key={item.id}
                        draggable={editable}
                        onDragStart={() => setDragging({ kind: 'clip', id: item.id })}
                        onDragEnd={() => setDragging(null)}
                      >
                        <span className="grow">
                          <strong>{item.data.title}</strong>{' '}
                          <span className="muted small">
                            <Link
                              to={`/meetings/${item.data.recordingId}?part=${encodeURIComponent(item.data.part)}&t=${Math.floor(item.data.from)}`}
                            >
                              {clock(item.data.from)}
                            </Link>{' '}
                            · {duration(item.data.to - item.data.from)}
                          </span>
                        </span>
                        {editable && (
                          <button
                            type="button"
                            className="button"
                            onClick={() => insert(video.items.length, itemOf(item.id, item.data))}
                            aria-label={`Add “${item.data.title}” to the video`}
                          >
                            Add →
                          </button>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            );
          })}
        </section>

        <section className="panel">
          <h2>
            The video <span className="muted small">{duration(seconds(video.items))}</span>
          </h2>
          <VideoPreview items={video.items} />
          <ol className="timeline">
            {video.items.map((item, index) => (
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- DRAG_NOTE
              <li
                key={item.key}
                className={`${over === index ? 'drop-before' : ''}${dragging?.id === item.key ? ' dragging' : ''}`}
                draggable={editable}
                onDragStart={() => setDragging({ kind: 'item', id: item.key })}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDragOver={dragOver(index)}
                onDrop={drop(index)}
              >
                <span className="drag-handle" aria-hidden="true">
                  ⠿
                </span>
                <span className="grow">
                  <strong>
                    {index + 1}. {item.title}
                  </strong>
                  <span className="muted small">
                    {' '}
                    {item.meeting} · {clock(item.from)}–{clock(item.to)} · {duration(item.to - item.from)}
                  </span>
                </span>
                {editable && (
                  <span className="toolbar">
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => move(index, index - 1)}
                      disabled={index === 0}
                      aria-label={`Move “${item.title}” earlier`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => move(index, index + 1)}
                      disabled={index === video.items.length - 1}
                      aria-label={`Move “${item.title}” later`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => changeItems((items) => items.filter((other) => other.key !== item.key))}
                      aria-label={`Take “${item.title}” out of the video`}
                    >
                      ✕
                    </button>
                  </span>
                )}
              </li>
            ))}
            {editable && (
              // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- DRAG_NOTE
              <li
                className={`timeline-end${over === video.items.length ? ' drop-before' : ''}`}
                onDragOver={dragOver(video.items.length)}
                onDrop={drop(video.items.length)}
              >
                {video.items.length ? 'Drop a clip here to add it at the end' : 'Add clips, or drag them here'}
              </li>
            )}
          </ol>
        </section>
      </div>
    </article>
  );
}
