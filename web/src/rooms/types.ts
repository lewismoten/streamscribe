import type { Body } from '../civic/types.ts';

// Where meetings are held (collection rooms, public, edited with edit.bodies): a room in a building, its address, and
// the camera views its meetings share (a view is a camera angle, with a zoom area for each seat; the same shape as a
// meeting's `views` mark, which the review page edits). A meeting's room is the one chosen for it (its meeting-info
// mark's roomId), else its schedule's (location), else where its body usually meets.
export interface CameraView {
  id: string;
  name: string;
  scene?: string;
  fingerprint?: string;
  regions?: Record<string, unknown>;
}
export interface Room {
  name: string; // Board Room
  building: string; // Warren County Government Center
  address: string; // 220 North Commerce Avenue
  city: string;
  state: string;
  postal: string;
  note?: string;
  views?: CameraView[];
}

export const fullAddress = (room: Room) =>
  [room.address, room.city, [room.state, room.postal].filter(Boolean).join(' ')].filter(Boolean).join(', ');
export const roomLabel = (room: Room) => [room.name, room.building].filter(Boolean).join(', ');
export const mapUrl = (room: Room) =>
  `https://www.openstreetmap.org/search?query=${encodeURIComponent([room.building, fullAddress(room)].filter(Boolean).join(', '))}`;

// The room a meeting was in: chosen for it, else its schedule's, else its body's usual room.
export function roomIdOf({
  chosen,
  occurrenceKey,
  schedules,
  meetingBodies
}: {
  chosen?: string;
  occurrenceKey?: string;
  schedules: { id: string; data: { roomId?: string } }[];
  meetingBodies: { id: string; data: Body }[];
}) {
  if (chosen) return chosen;
  const scheduleId = (occurrenceKey || '').split('@')[0];
  const schedule = scheduleId ? schedules.find((item) => item.id === scheduleId) : undefined;
  if (schedule?.data.roomId) return schedule.data.roomId;
  return meetingBodies.find((body) => body.data.roomId)?.data.roomId || '';
}
