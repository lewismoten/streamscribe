import type { MeetingPerson } from '../people/usePeople.ts';
import {
  electionLabel,
  electionOf,
  isCurrent,
  MEMBER_KINDS,
  personKeyOf,
  shortDate,
  STAFF_KINDS,
  TERM_KINDS,
  today,
  type Body,
  type Term
} from './types.ts';
import type { Civic } from './useCivic.ts';

// Where a person belongs on the People page, from their terms: serving now (elected by the public, appointed or
// chosen by a board, on staff of each organization, running for a seat), or having served. Someone belongs in every
// group that fits (a former appointee who is now a library trustee is in both), each with what puts them there.
// People with no terms are in the group their source's roster gives them (Residents, Vendors…).
export interface Placement {
  group: string;
  detail: string;
}

export const ELECTED = 'Elected officials';
export const APPOINTED = 'Appointed and board-chosen members';
export const CANDIDATES = 'Candidates';
export const STAFF = 'Staff';
export const FORMER_ELECTED = 'Former elected officials';
export const FORMER_APPOINTED = 'Former appointees and board members';
export const FORMER_STAFF = 'Former staff';
export const UNDATED = 'Served on a public body (dates not known yet)';

// Groups in the order they're shown; staff groups (one per organization) come after candidates.
export function groupOrder(groups: string[]) {
  const fixed = [ELECTED, APPOINTED, CANDIDATES];
  const staff = groups.filter((group) => group.startsWith(`${STAFF} · `)).sort();
  const former = [FORMER_ELECTED, FORMER_APPOINTED, FORMER_STAFF, UNDATED];
  return [...fixed, ...staff, ...former];
}

const publiclyElected = (term: Term, body: Body | undefined) =>
  term.kind === 'elected' && (!body || body.selection === 'elected' || body.selection === 'mixed');

export function placements(person: MeetingPerson, civic: Civic): Placement[] {
  const terms = (civic.terms || []).map((term) => term.data).filter((term) => personKeyOf(term) === person.key);
  if (!terms.length) return [];
  const bodyOf = (term: Term) => civic.bodies?.find((item) => item.id === term.bodyId)?.data;
  const organizationOf = (body: Body | undefined) =>
    civic.organizations?.find((item) => item.id === body?.organizationId)?.data;
  const districtOf = (term: Term) =>
    organizationOf(bodyOf(term))?.districts.find((item) => item.id === term.districtId)?.name;
  const years = (term: Term) =>
    [term.start.slice(0, 4), term.end?.slice(0, 4)]
      .filter((item, index, list) => item && list.indexOf(item) === index)
      .join('–');
  // Offices someone holds now on a body, shown with their seat there (Chair · Supervisor, South River).
  const officesNow = (bodyId: string) =>
    terms
      .filter((term) => term.kind === 'officer' && term.bodyId === bodyId && isCurrent(term))
      .map((term) => term.title);

  // Bodies someone serves on now: their earlier terms there aren't "former" (a re-elected Supervisor, say).
  const servingOn = new Set(terms.filter((term) => term.start && isCurrent(term)).map((term) => term.bodyId));
  const found = new Map<string, string[]>();
  const add = (group: string, detail: string) => {
    const list = found.get(group) || [];
    if (!list.includes(detail)) list.push(detail);
    found.set(group, list);
  };
  for (const term of terms) {
    if (term.kind === 'officer') continue;
    const body = bodyOf(term);
    const where = body?.name || '';
    const seat = [
      term.title,
      districtOf(term) && `${districtOf(term)} District`,
      term.start > today() && term.kind !== 'candidate' && `from ${shortDate(term.start)}`
    ]
      .filter(Boolean)
      .join(', ');
    const member = MEMBER_KINDS.includes(term.kind);
    const staff = STAFF_KINDS.includes(term.kind);
    if (!term.start) {
      add(UNDATED, [seat, where].filter(Boolean).join(' · '));
      continue;
    }
    // Taking office later (won an election, say): with those serving now, saying from when.
    const upcoming = term.start > today();
    if (isCurrent(term) || upcoming) {
      if (term.kind === 'candidate') {
        const election = electionOf(civic.elections, term);
        add(CANDIDATES, [`for ${seat}`, where, election && electionLabel(election)].filter(Boolean).join(' · '));
      } else if (member) {
        const now = [...officesNow(term.bodyId), seat].join(' · ');
        if (publiclyElected(term, body)) add(ELECTED, [now, where].filter(Boolean).join(' · '));
        else
          add(
            APPOINTED,
            [
              now,
              where,
              term.kind === 'chosen' || term.kind === 'elected'
                ? 'chosen by the board'
                : TERM_KINDS[term.kind].toLowerCase()
            ]
              .filter(Boolean)
              .join(' · ')
          );
      } else if (staff) {
        add(`${STAFF} · ${organizationOf(body)?.name || 'Other'}`, seat);
      }
    } else if (term.kind !== 'candidate' && !servingOn.has(term.bodyId)) {
      const past = [seat, where, years(term)].filter(Boolean).join(' · ');
      if (member && publiclyElected(term, body)) add(FORMER_ELECTED, past);
      else if (member) add(FORMER_APPOINTED, past);
      else if (staff) add(FORMER_STAFF, past);
    }
  }
  return [...found].map(([group, details]) => ({ group, detail: details.join('; ') }));
}
