import { useRecords } from '../data/useRecords.ts';

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
