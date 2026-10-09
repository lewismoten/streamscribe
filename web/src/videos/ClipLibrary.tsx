import { useState } from 'react';
import { Link } from 'react-router';
import { clock, date, duration } from '../format.ts';
import type { HubRecord } from '../data/useRecords.ts';
import type { Clip } from './types.ts';

// Every meeting's clips, by meeting (found by title or meeting): each added to the video at the playhead's clip, or
// at the end.
export default function ClipLibrary({
  clips,
  editable,
  onAdd
}: {
  clips: HubRecord<Clip>[];
  editable: boolean;
  onAdd: (record: HubRecord<Clip>) => void;
}) {
  const [filter, setFilter] = useState('');
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
    <section className="panel clip-bin">
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
                  <li key={item.id}>
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
                        onClick={() => onAdd(item)}
                        aria-label={`Add “${item.data.title}” to the timeline`}
                      >
                        Add
                      </button>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
