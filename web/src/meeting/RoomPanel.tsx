import { Link } from 'react-router';
import { can, type Account } from '../data/account.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { fullAddress, roomIdOf, roomLabel, type CameraView, type Room } from '../rooms/types.ts';
import type { Body } from '../civic/types.ts';

// Where the meeting was: its room (chosen here, else its schedule's, else where its body usually meets), with the
// building's address; and its camera views shared with the room's other meetings: saved to the room, or taken from
// it for a meeting that has none yet (the review page then has them too).
export default function RoomPanel({
  recordingId,
  part,
  occurrenceKey,
  meetingBodies,
  info,
  views,
  account,
  save
}: {
  recordingId: string;
  part: string;
  occurrenceKey?: string;
  meetingBodies: { id: string; data: Body }[];
  info: { roomId?: string } & Record<string, unknown>;
  views: CameraView[];
  account: Account;
  save: (markId: string, value: Record<string, unknown>, done: string) => Promise<void>;
}) {
  const { records: rooms } = useRecords<Room>('rooms');
  const { records: schedules } = useRecords<{ roomId?: string }>('schedules');
  const roomId = roomIdOf({ chosen: info.roomId, occurrenceKey, schedules: schedules || [], meetingBodies });
  const room = rooms?.find((item) => item.id === roomId);
  const canEdit = Boolean(account.user);
  const infoId = `${recordingId}:${part}:meeting-info`;
  const viewsId = `${recordingId}:${part}:views`;
  const roomViews = room?.data.views || [];
  if (!room && !canEdit) return null;

  // This meeting's views into the room's: by id (or name), replacing the room's copy of each.
  const shareViews = async () => {
    if (!room) return;
    const kept = roomViews.filter((view) => !views.some((item) => item.id === view.id || item.name === view.name));
    await putRecord('rooms', room.id, { ...room.data, views: [...kept, ...views] });
  };
  const takeViews = () => save(viewsId, { views: roomViews }, `Using ${room?.data.name}'s camera views`);

  return (
    <section className="panel room-panel">
      <h2>Where</h2>
      {room ? (
        <p>
          <Link to={`/rooms/${encodeURIComponent(room.id)}`}>{roomLabel(room.data)}</Link>
          <span className="muted small">
            <br />
            {fullAddress(room.data)}
            {!info.roomId && ' (as usual for its body or schedule)'}
          </span>
        </p>
      ) : (
        <p className="muted small">Not known yet.</p>
      )}
      {canEdit && (rooms || []).length > 0 && (
        <label className="inline small">
          Room{' '}
          <select
            value={info.roomId || ''}
            onChange={(event) => save(infoId, { ...info, roomId: event.target.value }, 'Room saved')}
          >
            <option value="">{room && !info.roomId ? `As usual (${room.data.name})` : 'Not known'}</option>
            {(rooms || []).map((item) => (
              <option key={item.id} value={item.id}>
                {roomLabel(item.data)}
              </option>
            ))}
          </select>
        </label>
      )}
      {room && canEdit && (
        <div className="toolbar small">
          {views.length > 0 && can('edit.bodies', account) && (
            <button type="button" className="link-button" onClick={shareViews}>
              Save this meeting&apos;s camera views to the room
            </button>
          )}
          {roomViews.length > 0 && views.length === 0 && (
            <button type="button" className="link-button" onClick={takeViews}>
              Use the room&apos;s {roomViews.length} camera view{roomViews.length === 1 ? '' : 's'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
