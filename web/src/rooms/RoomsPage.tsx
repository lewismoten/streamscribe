import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import type { Body } from '../civic/types.ts';
import RoomForm from './RoomForm.tsx';
import { fullAddress, mapUrl, type Room } from './types.ts';

// Where meetings are held: rooms by building (with the building's address and a map), each with how many camera
// views it has and which bodies usually meet there.
export default function RoomsPage() {
  const account = useAccount();
  const navigate = useNavigate();
  const editor = can('edit.bodies', account);
  const { records: rooms } = useRecords<Room>('rooms');
  const { records: bodies } = useRecords<Body>('bodies');
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState('');
  if (!rooms) return <p className="empty">Loading…</p>;
  const buildings = [...new Set(rooms.map((room) => room.data.building))].sort();

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Rooms</h1>
        {editor && (
          <button type="button" className="button primary" onClick={() => setAdding(true)}>
            ＋ Room
          </button>
        )}
      </div>
      {message && <p className="note">{message}</p>}
      {adding && (
        <RoomForm
          id={null}
          value={{}}
          buildings={rooms.map((room) => room.data)}
          onDone={(text, id) => {
            setAdding(false);
            setMessage(text);
            if (id) navigate(`/rooms/${encodeURIComponent(id)}`);
          }}
        />
      )}
      {rooms.length === 0 && <p className="empty">No rooms yet.</p>}
      {buildings.map((building) => {
        const inside = rooms.filter((room) => room.data.building === building);
        const first = inside[0].data;
        return (
          <section key={building} className="building">
            <h2>{building}</h2>
            <p className="small">
              {fullAddress(first)}{' '}
              {fullAddress(first) && (
                <a href={mapUrl(first)} target="_blank" rel="noreferrer">
                  Map ↗
                </a>
              )}
            </p>
            <ul className="body-grid">
              {inside.map((room) => {
                const usual = (bodies || []).filter((body) => body.data.roomId === room.id);
                return (
                  <li key={room.id}>
                    <Link to={`/rooms/${encodeURIComponent(room.id)}`} className="body-card">
                      <strong>{room.data.name}</strong>
                      <span className="muted small">
                        {(room.data.views || []).length} camera view{(room.data.views || []).length === 1 ? '' : 's'}
                      </span>
                      {usual.length > 0 && (
                        <span className="small">Usually: {usual.map((body) => body.data.name).join(', ')}</span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
