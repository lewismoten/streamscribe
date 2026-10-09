import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { upcoming } from '../../../src/sync/recurrence.js';
import type { Body } from '../civic/types.ts';
import { can, useAccount } from '../data/account.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { date } from '../format.ts';
import type { Schedule } from '../schedules/form.ts';
import { useNow } from '../useNow.ts';
import RoomForm from './RoomForm.tsx';
import { fullAddress, mapUrl, type Room } from './types.ts';
import { useMeetingRooms } from './useMeetingRooms.ts';

// One room: where it is (with a map), the camera views its meetings share (saved from a meeting's page), the bodies
// that usually meet there, what's coming up there, and (for people who may see meetings) the meetings held there.
export default function RoomPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const editor = can('edit.bodies', account);
  const { records: rooms } = useRecords<Room>('rooms');
  const { records: bodies } = useRecords<Body>('bodies');
  const { records: schedules } = useRecords<Schedule>('schedules');
  const meetingRooms = useMeetingRooms();
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState('');
  const now = useNow(60000);
  const room = rooms?.find((item) => item.id === id);
  // Schedules here: their own location, else their body's usual room.
  const here = useMemo(
    () =>
      (schedules || []).filter(
        (schedule) =>
          schedule.data.roomId === id ||
          (!schedule.data.roomId && bodies?.find((body) => body.id === schedule.data.bodyId)?.data.roomId === id)
      ),
    [schedules, bodies, id]
  );
  const next = useMemo(
    () =>
      upcoming(
        here.map((schedule) => ({ ...schedule.data, id: schedule.id })),
        now,
        now + 90 * 86400000
      ).slice(0, 10),
    [here, now]
  );
  if (!rooms) return <p className="empty">Loading…</p>;
  if (!room)
    return (
      <p>
        No such room. <Link to="/rooms">All rooms</Link>
      </p>
    );
  const usual = (bodies || []).filter((body) => body.data.roomId === id);
  const held = [...meetingRooms.values()]
    .filter((item) => item.roomId === id)
    .sort((a, b) => String(b.recording.data.startedAt).localeCompare(String(a.recording.data.startedAt)));
  const views = room.data.views || [];

  return (
    <article>
      <div className="card-kind">
        <Link to="/rooms">Rooms</Link> · {room.data.building}
      </div>
      <div className="toolbar">
        <h1 className="grow">{room.data.name}</h1>
        {editor && (
          <button type="button" className="button" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
      </div>
      <p>
        {room.data.building}
        {fullAddress(room.data) && (
          <>
            <br />
            {fullAddress(room.data)}{' '}
            <a href={mapUrl(room.data)} target="_blank" rel="noreferrer">
              Map ↗
            </a>
          </>
        )}
      </p>
      {room.data.note && <p className="muted">{room.data.note}</p>}
      {message && <p className="note">{message}</p>}
      {editing && (
        <RoomForm
          id={id}
          value={room.data}
          buildings={rooms.map((item) => item.data)}
          onDone={(text) => {
            setEditing(false);
            setMessage(text);
          }}
        />
      )}

      <section className="panel">
        <h2>Camera views</h2>
        {views.length === 0 ? (
          <p className="muted small">
            None yet. On the page of a meeting held here, “Save this meeting&apos;s camera views to the room” shares
            them with the room&apos;s other meetings.
          </p>
        ) : (
          <ul>
            {views.map((view) => (
              <li key={view.id}>
                <strong>{view.name}</strong>{' '}
                <span className="muted small">
                  {Object.keys(view.regions || {}).length} zoom area
                  {Object.keys(view.regions || {}).length === 1 ? '' : 's'}
                </span>
                {editor && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      confirm(`Remove the camera view “${view.name}” from the room?`) &&
                      putRecord('rooms', id, { ...room.data, views: views.filter((item) => item.id !== view.id) })
                    }
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {usual.length > 0 && (
        <section className="panel">
          <h2>Usually meets here</h2>
          <ul>
            {usual.map((body) => (
              <li key={body.id}>
                <Link to={`/bodies/${encodeURIComponent(body.id)}`}>{body.data.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {next.length > 0 && (
        <section className="panel">
          <h2>Coming up</h2>
          <ul>
            {next.map((item) => (
              <li key={item.key}>
                {date(new Date(item.start).toISOString())} · {item.title}
              </li>
            ))}
          </ul>
        </section>
      )}
      {held.length > 0 && (
        <section className="panel">
          <h2>Meetings held here</h2>
          <ul>
            {held.map(({ recording }) => (
              <li key={recording.id}>
                <Link to={`/meetings/${recording.id}`}>{recording.data.title}</Link>{' '}
                <span className="muted small">· {date(recording.data.startedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
