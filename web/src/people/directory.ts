import { hubCall } from '../data/hub.ts';
import { syncNow } from '../data/sync.ts';
import { useRecords } from '../data/useRecords.ts';
import { personKey, type MeetingPerson } from './usePeople.ts';

// The public directory (collection `directory`, one record per source; hub-php/lib/people-routes.php): who is listed
// for everyone, and the public copy of their photo when it's public. Anyone can read it.
export interface DirectoryPerson {
  id: string;
  name: string;
  role: string;
  group: string;
  icon: string;
  nameUnknown: boolean;
  photo: string | null;
}
export interface Directory {
  sourceKey: string;
  sourceName: string;
  groups: string[];
  people: DirectoryPerson[];
}

export function useDirectory() {
  const { records } = useRecords<Directory>('directory');
  return records ? records.map((record) => record.data) : null;
}

// A listed person, by source and roster id.
export const listedPerson = (directories: Directory[] | null, sourceKey: string, id: string) =>
  directories?.find((directory) => directory.sourceKey === sourceKey)?.people.find((person) => person.id === id) ||
  null;

// Lists a person publicly (or not), and their photo, on the hub (people who may publish). The person's details come
// from the roster as the publisher sees it.
export async function savePublic(person: MeetingPerson, groups: string[], listed: boolean, photo: boolean) {
  await hubCall('people-public', {
    sourceKey: person.sourceKey,
    sourceName: person.sourceName,
    groups,
    person: {
      id: person.id,
      name: person.name || '',
      role: person.role || '',
      group: person.group || '',
      icon: person.icon || '',
      nameUnknown: Boolean(person.nameUnknown)
    },
    listed,
    photo
  });
  await syncNow();
}

// The public directory as people (with their public photo, and no private speaking details).
export function publicPeople(directories: Directory[] | null): MeetingPerson[] | null {
  if (!directories) return null;
  return directories.flatMap((directory) =>
    directory.people.map((person) => ({
      ...person,
      key: personKey(directory.sourceKey, person.id),
      sourceKey: directory.sourceKey,
      sourceName: directory.sourceName,
      photo: person.photo,
      meetings: [],
      seconds: 0
    }))
  );
}
