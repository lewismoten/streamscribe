import { useMemo } from 'react';
import { can, useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import { useDirectory } from '../people/directory.ts';
import { publicPeople } from '../people/PeoplePage.tsx';
import { usePeople, type MeetingPerson } from '../people/usePeople.ts';
import type { Body, Election, Organization, Term } from './types.ts';

// Public bodies, their organizations, and everyone's terms, with the people they're about: everyone on the rosters
// for people who may see meetings, else the public directory (a term of someone not listed shows without a name).
export function useCivic() {
  const account = useAccount();
  const viewer = can('view.meetings', account);
  const { records: organizations } = useRecords<Organization>('organizations');
  const { records: bodies } = useRecords<Body>('bodies');
  const { records: terms } = useRecords<Term>('terms');
  const { records: elections } = useRecords<Election>('elections');
  const directories = useDirectory();
  const roster = usePeople();
  const people = useMemo(() => {
    const map = new Map<string, MeetingPerson>();
    for (const person of publicPeople(directories) || []) map.set(person.key, person);
    if (viewer) for (const person of roster.people || []) map.set(person.key, person);
    return map;
  }, [directories, roster.people, viewer]);
  return {
    account,
    viewer,
    editor: can('edit.bodies', account),
    organizations,
    bodies,
    terms,
    elections,
    people,
    directories,
    roster,
    loading: !organizations || !bodies || !terms || !elections
  };
}
export type Civic = ReturnType<typeof useCivic>;
