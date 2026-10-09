import { useMemo } from 'react';
import { stackMarks } from '../../../src/sync/layers.js';
import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';

// The people in meetings, from each source's roster (the `<source>:people` mark the review page keeps), their photos
// (`<source>:people-photos`, sent by publish-library), and every meeting's speaker marks: who spoke in which meetings,
// when first, and for how long; and each meeting's attendance. Marks are seen as the viewer sees them (people's own
// layers applied).
export interface RosterPerson {
  id: string;
  name?: string;
  role?: string;
  group?: string;
  icon?: string;
  nameUnknown?: boolean;
}
export interface Appearance {
  recordingId: string;
  title: string;
  startedAt: string;
  part: string;
  firstAt: number;
  seconds: number;
  turns: number;
}
export interface MeetingPerson extends RosterPerson {
  key: string;
  sourceKey: string;
  sourceName: string;
  photo: string | null;
  meetings: Appearance[];
  seconds: number;
}
// Who was at a meeting (an `<recordingId>:attendance` mark, edited on the meeting page): present, absent, and who
// presided; and the body it was a meeting of, when matching by source and title isn't right.
export interface Attendance {
  bodyId?: string;
  present?: string[];
  absent?: string[];
  presiding?: string;
  // People seen in the audience, and when.
  audience?: AudienceMember[];
}
export interface AudienceMember {
  id: string;
  part?: string;
  at?: number;
}
interface Turn {
  at: number;
  speakers: string[];
}

// Who a person is shown as: their name, or (when it isn't known) their role.
export const shownName = (person: RosterPerson) =>
  person.nameUnknown || !person.name?.trim() ? person.role || 'Unknown' : person.name;
export const initials = (person: RosterPerson) =>
  person.nameUnknown || !person.name?.trim()
    ? '?'
    : person.name
        .split(/\s+/)
        .filter(Boolean)
        .map((word) => word[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
export const personKey = (sourceKey: string, id: string) => `${sourceKey}/${id}`;

export function usePeople() {
  const account = useAccount();
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const viewerId = account.user?.id || 0;
  return useMemo(() => {
    if (!marks || !recordings)
      return { people: null, groups: [] as string[], attendance: new Map<string, Attendance>() };
    const stacks = stackMarks(marks, viewerId) as Map<string, { data: Record<string, unknown> | null }>;
    const byRecording = new Map(recordings.map((record) => [record.id, record.data]));
    const people = new Map<string, MeetingPerson>();
    const groups: string[] = [];
    const attendance = new Map<string, Attendance>();
    for (const [markId, stack] of stacks) {
      const match = markId.match(/^([^:]+):attendance$/);
      if (match && stack.data) attendance.set(match[1], stack.data as Attendance);
    }

    for (const [markId, stack] of stacks) {
      const match = markId.match(/^([^:]+):people$/);
      if (!match || !stack.data) continue;
      const sourceKey = match[1];
      const roster = stack.data as { people?: RosterPerson[]; groups?: string[] };
      const photos = (stacks.get(`${sourceKey}:people-photos`)?.data?.photos || {}) as Record<string, { path: string }>;
      const sourceName = recordings.find((record) => record.data.sourceKey === sourceKey)?.data.sourceName || sourceKey;
      for (const group of roster.groups || []) if (!groups.includes(group)) groups.push(group);
      for (const person of roster.people || []) {
        const key = personKey(sourceKey, person.id);
        people.set(key, {
          ...person,
          key,
          sourceKey,
          sourceName,
          photo: photos[person.id]?.path || null,
          meetings: [],
          seconds: 0
        });
      }
    }

    // Speaking time: each turn lasts until the next (the last until the part ends), counted for everyone in it.
    for (const [markId, stack] of stacks) {
      const match = markId.match(/^([^:]+):(.+):speakers$/);
      const recording = match && byRecording.get(match[1]);
      if (!match || !recording || !stack.data) continue;
      const [, recordingId, part] = match;
      const turns = [...(((stack.data as { turns?: Turn[] }).turns || []) as Turn[])].sort((a, b) => a.at - b.at);
      const partSeconds =
        recording.parts?.find((item) => item.name === part)?.seconds || recording.durationSeconds || 0;
      turns.forEach((turn, index) => {
        const end = index + 1 < turns.length ? turns[index + 1].at : Math.max(turn.at, partSeconds);
        for (const id of turn.speakers || []) {
          const person = people.get(personKey(recording.sourceKey, id));
          if (!person) continue;
          let appearance = person.meetings.find((item) => item.recordingId === recordingId && item.part === part);
          if (!appearance) {
            appearance = {
              recordingId,
              title: recording.title,
              startedAt: recording.startedAt,
              part,
              firstAt: turn.at,
              seconds: 0,
              turns: 0
            };
            person.meetings.push(appearance);
          }
          appearance.seconds += Math.max(0, end - turn.at);
          appearance.turns += 1;
          person.seconds += Math.max(0, end - turn.at);
        }
      });
    }
    for (const person of people.values())
      person.meetings.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return { people: [...people.values()], groups, attendance };
  }, [marks, recordings, viewerId]);
}
