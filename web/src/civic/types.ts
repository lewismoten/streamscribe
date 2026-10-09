import { dayKey } from '../format.ts';

// Public bodies and who serves on them (collections organizations, bodies, and terms; public, edited with
// edit.bodies). An organization (a county, a town, a school division, a nonprofit) has districts and bodies; a body
// (a board, a committee under it, its staff) says how its members are chosen and which sources' meetings are its
// own; a term says who served on a body, as what, from when to when. A person holds many terms over the years:
// appointed to a seat, then elected to it, Chair for a year, interim administrator between hires, or running for a
// seat (a candidate) whether or not they win. Elections are records of their own (collection elections), which
// candidates' and elected members' terms point at. People are the ones on each source's roster (see ../people).

export type OrganizationKind = 'county' | 'town' | 'city' | 'school-division' | 'nonprofit' | 'other';
export interface District {
  id: string;
  name: string;
}
export interface Organization {
  name: string;
  kind: OrganizationKind;
  districts: District[];
  website?: string;
  note?: string;
}

export type BodyKind = 'governing' | 'board' | 'committee' | 'commission' | 'staff' | 'other';
export type Selection = 'elected' | 'appointed' | 'self-selected' | 'mixed' | 'hired';
// Which recordings are this body's: a source's meetings, or only those whose title contains some text.
export interface MeetingMatch {
  sourceKey: string;
  match: string;
}
export interface Body {
  organizationId: string;
  name: string;
  kind: BodyKind;
  parentId?: string;
  selection: Selection;
  meetings: MeetingMatch[];
  // What its members are called (such as Supervisor): the title new members' terms get.
  memberTitle?: string;
  // How many years an elected seat lasts (such as 4): winners' terms run that long from taking office.
  termYears?: number;
  // The body's offices, such as Chair and Vice Chair; officer terms hold them, usually a year at a time.
  offices?: string[];
  website?: string;
  note?: string;
}

export type ElectionKind = 'general' | 'special' | 'primary' | 'other';
export interface Election {
  date: string; // YYYY-MM-DD
  name: string;
  // Older elections named one organization; an election day is one ballot, with races for any body.
  organizationId?: string;
  kind: ElectionKind;
  // When those elected take office (default: January 1 after the election).
  takesOffice?: string;
  note?: string;
}

export type TermKind =
  'elected' | 'appointed' | 'citizen' | 'ex-officio' | 'officer' | 'staff' | 'interim' | 'candidate';
export type EndReason = '' | 'term-ended' | 'resigned' | 'replaced' | 'removed' | 'died' | 'other';
export type Result = '' | 'won' | 'lost' | 'withdrew';
export interface Term {
  sourceKey: string;
  personId: string;
  bodyId: string;
  kind: TermKind;
  title: string;
  districtId?: string;
  start: string; // YYYY-MM-DD, or '' when not known yet (someone known to have served, dates to come)
  end?: string; // YYYY-MM-DD, inclusive; none while it lasts
  endReason?: EndReason;
  electionId?: string; // candidates: the election they ran in; elected members: the one they won
  election?: string; // an election's date, from before elections were records of their own
  electionNote?: string; // about this person in that election, such as "First woman elected Sheriff"
  result?: Result;
  note?: string;
}

export const ORGANIZATION_KINDS: Record<OrganizationKind, string> = {
  county: 'County',
  town: 'Town',
  city: 'City',
  'school-division': 'School division',
  nonprofit: 'Nonprofit',
  other: 'Other'
};
export const BODY_KINDS: Record<BodyKind, string> = {
  governing: 'Governing body',
  board: 'Board',
  committee: 'Committee',
  commission: 'Commission or authority',
  staff: 'Staff',
  other: 'Other'
};
export const SELECTIONS: Record<Selection, string> = {
  elected: 'Members elected by the public',
  appointed: 'Members appointed (by another body or official)',
  'self-selected': 'Members chosen by the body itself',
  mixed: 'Some elected, some appointed',
  hired: 'Hired staff'
};
export const TERM_KINDS: Record<TermKind, string> = {
  elected: 'Elected',
  appointed: 'Appointed',
  citizen: 'Citizen appointee',
  'ex-officio': 'Ex officio',
  officer: 'Officer',
  staff: 'Staff',
  interim: 'Interim',
  candidate: 'Candidate'
};
export const TERM_HELP: Record<TermKind, string> = {
  elected: 'A seat won in an election',
  appointed: 'A seat filled by appointment (such as before an election, or after a resignation), not elected',
  citizen: 'A member of the public appointed to the body (often a committee)',
  'ex-officio': 'A member because of another office they hold',
  officer: 'An office on the body, such as Chair or Vice Chair, held by a member',
  staff: 'A staff position, such as County Administrator or County Attorney',
  interim: 'A staff position held for now, until someone is hired',
  candidate: 'Running for a seat (whether or not they win)'
};
export const END_REASONS: Record<EndReason, string> = {
  '': '',
  'term-ended': 'Term ended',
  resigned: 'Resigned',
  replaced: 'Replaced',
  removed: 'Removed',
  died: 'Died',
  other: 'Other'
};
export const ELECTION_KINDS: Record<ElectionKind, string> = {
  general: 'General election',
  special: 'Special election',
  primary: 'Primary',
  other: 'Election'
};
// Kinds of term that go with an election.
export const ELECTED_KINDS: TermKind[] = ['elected', 'candidate'];
// The election a term went with: its record, or the date given before elections were records.
export function electionOf(elections: { id: string; data: Election }[] | null, term: Term) {
  const found = term.electionId ? elections?.find((item) => item.id === term.electionId)?.data : undefined;
  if (found) return found;
  return term.election ? { date: term.election, name: 'Election', kind: 'other' as const } : null;
}
// One election per day and kind: its id.
export const electionId = (date: string, kind: ElectionKind) => `${date}-${kind}`;
export const takesOfficeOn = (election: Election) =>
  election.takesOffice || (election.date ? `${Number(election.date.slice(0, 4)) + 1}-01-01` : '');
// The last day of a term that starts on a day and lasts some years: the day before the same date that many years on.
export function termEnd(start: string, years: number) {
  const [year, month, day] = start.split('-').map(Number);
  const end = new Date(Date.UTC(year + years, month - 1, day - 1));
  return end.toISOString().slice(0, 10);
}
export const electionLabel = (election: Election) => `${election.name}, ${shortDate(election.date)}`;

export const RESULTS: Record<Result, string> = {
  '': 'Not decided yet',
  won: 'Won',
  lost: 'Lost',
  withdrew: 'Withdrew'
};
// Titles to suggest for each kind of term (any title may be typed).
export const TITLE_SUGGESTIONS: Record<TermKind, string[]> = {
  elected: ['Supervisor', 'Council member', 'Mayor', 'School board member', 'Member'],
  appointed: ['Supervisor', 'Council member', 'Trustee', 'Member'],
  citizen: ['Citizen member', 'Member'],
  'ex-officio': ['Member (ex officio)'],
  officer: ['Chair', 'Vice Chair', 'Vice Mayor', 'Secretary', 'Treasurer', 'President', 'Vice President'],
  staff: [
    'County Administrator',
    'Assistant to the County Administrator',
    'Deputy County Administrator',
    'County Attorney',
    'Town Manager',
    'Town Attorney',
    'Clerk',
    'Superintendent',
    'Director'
  ],
  interim: ['Interim County Administrator', 'Interim Town Manager', 'Interim Superintendent', 'Interim Director'],
  candidate: ['Supervisor', 'Council member', 'Mayor', 'School board member']
};

// Kinds that make someone a member of the body (officers are members too; staff and candidates are not).
export const MEMBER_KINDS: TermKind[] = ['elected', 'appointed', 'citizen', 'ex-officio'];
export const STAFF_KINDS: TermKind[] = ['staff', 'interim'];

export const today = () => dayKey(new Date().toISOString());
export const activeOn = (term: Term, day: string) =>
  Boolean(term.start) && term.start <= day && (!term.end || day <= term.end);
// Whether a term covers any day of a year (one with unknown dates may have).
export const servedIn = (term: Term, year: number) =>
  !term.start || (term.start.slice(0, 4) <= String(year) && (!term.end || term.end.slice(0, 4) >= String(year)));
// The kind of term a new member of a body gets, from how its members are chosen.
export const memberKindFor = (body: Body | undefined): TermKind =>
  body?.selection === 'hired'
    ? 'staff'
    : body?.selection === 'elected' || body?.selection === 'mixed'
      ? 'elected'
      : 'appointed';
// A candidate is current until the election has a result (or has passed, with an end date).
export const isCurrent = (term: Term, day = today()) =>
  term.kind === 'candidate' ? !term.result && activeOn(term, day) : activeOn(term, day);

export const DEFAULT_OFFICES = ['Chair', 'Vice Chair'];
export const officesOf = (body: Body | undefined) => body?.offices || DEFAULT_OFFICES;
// A whole calendar year (Jan 1 to Dec 31) shows as the year alone.
export const yearOrSpan = (term: Term) =>
  term.end &&
  term.start.slice(5) === '01-01' &&
  term.end.slice(5) === '12-31' &&
  term.start.slice(0, 4) === term.end.slice(0, 4)
    ? term.start.slice(0, 4)
    : span(term);

export const personKeyOf = (term: Term) => `${term.sourceKey}/${term.personId}`;

// The bodies a recording belongs to: chosen on its attendance mark, else matched by source and title.
export function bodiesOfRecording(
  bodies: { id: string; data: Body }[],
  recording: { sourceKey: string; title: string },
  chosen?: string
) {
  if (chosen) return bodies.filter((body) => body.id === chosen);
  const title = (recording.title || '').toLowerCase();
  return bodies.filter((body) =>
    (body.data.meetings || []).some(
      (item) =>
        item.sourceKey === recording.sourceKey &&
        (!item.match.trim() || title.includes(item.match.trim().toLowerCase()))
    )
  );
}

// "Jan 2024", "Mar 4, 2025": a term's dates, shown as precisely as they were given.
export function shortDate(day: string | undefined) {
  if (!day) return '';
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const value = new Date(Date.UTC(year, (month || 1) - 1, dayOfMonth || 1));
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
    ...(dayOfMonth ? { day: 'numeric' } : {})
  }).format(value);
}
export const span = (term: Term) =>
  term.start
    ? `${shortDate(term.start)} – ${term.end ? shortDate(term.end) : term.kind === 'candidate' ? '' : 'now'}`.trim()
    : term.end
      ? `until ${shortDate(term.end)}`
      : 'dates not known yet';

export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
