import { can } from '../data/account.ts';
import { listedPerson, savePublic } from '../people/directory.ts';
import type { MeetingPerson } from '../people/usePeople.ts';
import type { Civic } from './useCivic.ts';

// Someone with a term is a public figure: listed in the public directory (for people who may publish) if they
// aren't yet, so their name shows on the public pages. Their photo stays as chosen on the People page.
export async function listPublicly(civic: Civic, people: (MeetingPerson | undefined)[]) {
  if (!can('publish', civic.account)) return;
  for (const person of people) {
    if (!person || listedPerson(civic.directories, person.sourceKey, person.id)) continue;
    try {
      await savePublic(person, civic.roster.groups, true, false);
    } catch {
      /* the term is saved; listing can be done on the People page */
    }
  }
}
