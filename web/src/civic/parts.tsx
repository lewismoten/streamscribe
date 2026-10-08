import { Link } from 'react-router';
import Avatar from '../people/Avatar.tsx';
import { shownName, type MeetingPerson } from '../people/usePeople.ts';
import { TERM_KINDS, type Body, type Organization, type Term } from './types.ts';

// Small pieces the civic pages share.

export const personHref = (person: MeetingPerson) =>
  `/people/${encodeURIComponent(person.sourceKey)}/${encodeURIComponent(person.id)}`;

export function PersonLink({ person, size = 32 }: { person: MeetingPerson; size?: number }) {
  return (
    <Link to={personHref(person)} className="person-link">
      <Avatar person={person} size={size} />
      <span>{shownName(person)}</span>
    </Link>
  );
}

export const districtName = (organization: Organization | undefined, term: Term) =>
  term.districtId ? organization?.districts.find((district) => district.id === term.districtId)?.name || '' : '';

// "Interim", "Appointed", "Elected" next to a title, unless the title says it already.
export const kindTag = (term: Term) =>
  term.title.toLowerCase().includes(TERM_KINDS[term.kind].toLowerCase()) ? '' : TERM_KINDS[term.kind];

// Kinds of bodies in the order they're listed: the governing body first, staff last.
const ORDER: Body['kind'][] = ['governing', 'board', 'commission', 'committee', 'other', 'staff'];
export const byBodyOrder = (a: { data: Body }, b: { data: Body }) =>
  ORDER.indexOf(a.data.kind) - ORDER.indexOf(b.data.kind) || a.data.name.localeCompare(b.data.name);

// A person serving on a body: their photo and name, what they serve as, and the details (district, since when).
export function MemberCard({ person, title, details }: { person: MeetingPerson; title: string; details: string }) {
  return (
    <Link to={personHref(person)} className="person-card">
      <Avatar person={person} size={48} />
      <span>
        <strong>{shownName(person)}</strong>
        <span>{title}</span>
        <span className="muted small">{details}</span>
      </span>
    </Link>
  );
}
