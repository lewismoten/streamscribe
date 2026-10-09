import { useMemo } from 'react';
import { APPOINTED, ELECTED, placements, STAFF } from '../civic/categories.ts';
import { useCivic } from '../civic/useCivic.ts';
import { shownName } from '../people/usePeople.ts';

// Speakers as a topic's page lists them: by name, with their page, and ranked by who they are: vendors first, then
// voting members (elected or appointed), then staff, then residents and everyone else.
export const SPEAKER_RANKS = ['Vendors', 'Voting members', 'Staff', 'Residents and others'];

export function useSpeakerInfo() {
  const civic = useCivic();
  return useMemo(() => {
    return (sourceKey: string, id: string) => {
      const person = civic.people.get(`${sourceKey}/${id}`);
      if (!person) return { name: id, href: null as string | null, rank: 3 };
      const groups = placements(person, civic).map((placement) => placement.group);
      const rank = /vendor/i.test(person.group || '')
        ? 0
        : groups.includes(ELECTED) || groups.includes(APPOINTED)
          ? 1
          : groups.some((group) => group.startsWith(STAFF)) || /staff/i.test(person.group || '')
            ? 2
            : 3;
      return {
        name: shownName(person),
        href: `/people/${encodeURIComponent(sourceKey)}/${encodeURIComponent(id)}`,
        rank
      };
    };
    // placements reads the civic records; the hook's result changes with them.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [civic.people, civic.terms, civic.bodies, civic.organizations, civic.profiles]);
}
