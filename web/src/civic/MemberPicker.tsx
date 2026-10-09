import { useState } from 'react';
import { putRecord } from '../data/useRecords.ts';
import Avatar from '../people/Avatar.tsx';
import { namesOf, profileId, useProfiles } from '../people/profiles.ts';
import { shownName } from '../people/usePeople.ts';
import { listPublicly } from './listing.ts';
import { MEMBER_KINDS, memberKindFor, personKeyOf, TERM_KINDS, type Body } from './types.ts';
import type { Civic } from './useCivic.ts';

// Adding many members at once: the people heard in the body's meetings (most heard first), as pictures and names to
// pick. Each becomes a member (an elected Supervisor, say) with dates not known yet; seats, districts, and dates can
// come later, one person at a time.
export default function MemberPicker({
  body,
  civic,
  onDone
}: {
  body: { id: string; data: Body };
  civic: Civic;
  onDone: (message: string) => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const { profiles } = useProfiles();
  const sources = new Set((body.data.meetings || []).map((item) => item.sourceKey));
  const members = new Set(
    (civic.terms || [])
      .filter((term) => term.data.bodyId === body.id && MEMBER_KINDS.includes(term.data.kind))
      .map((term) => personKeyOf(term.data))
  );
  const needle = filter.trim().toLowerCase();
  const people = [...civic.people.values()]
    .filter((person) => !sources.size || sources.has(person.sourceKey))
    .filter((person) => !person.nameUnknown && person.id !== 'everyone')
    .filter(
      (person) =>
        !needle ||
        [person.name, person.role, ...namesOf(profiles.get(profileId(person.sourceKey, person.id)))].some((text) =>
          text?.toLowerCase().includes(needle)
        )
    )
    .sort((a, b) => b.seconds - a.seconds || shownName(a).localeCompare(shownName(b)));
  const kind = memberKindFor(body.data);
  const title = body.data.memberTitle || TERM_KINDS[kind];

  const toggle = (key: string) => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };
  const add = async () => {
    setBusy(true);
    const chosen = [...picked].map((key) => civic.people.get(key)).filter((person) => person !== undefined);
    for (const person of chosen) {
      await putRecord('terms', null, {
        sourceKey: person.sourceKey,
        personId: person.id,
        bodyId: body.id,
        kind,
        title,
        start: ''
      });
    }
    await listPublicly(civic, chosen);
    setBusy(false);
    onDone(`Added ${chosen.length} ${chosen.length === 1 ? 'member' : 'members'}; their dates and seats can follow`);
  };

  return (
    <section className="panel member-picker" aria-labelledby="member-picker-title">
      <div className="toolbar">
        <h2 id="member-picker-title" className="grow">
          Who has served on the {body.data.name}?
        </h2>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Find someone"
          aria-label="Find someone"
        />
      </div>
      <p className="muted small">
        Pick everyone who has ever been a member. Each is added as {TERM_KINDS[kind].toLowerCase()} {title}, with dates
        to fill in later.
      </p>
      <ul className="picker-grid">
        {people.map((person) => {
          const member = members.has(person.key);
          const on = picked.has(person.key);
          return (
            <li key={person.key}>
              <button
                type="button"
                className={`picker-person${on ? ' on' : ''}`}
                aria-pressed={member || on}
                disabled={member}
                onClick={() => toggle(person.key)}
              >
                <Avatar person={person} size={56} />
                <span>{shownName(person)}</span>
                <span className="muted small">{member ? 'Already a member' : person.role}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {people.length === 0 && <p className="empty">Nobody heard in its meetings yet.</p>}
      <div className="toolbar">
        <button type="button" className="button primary" disabled={!picked.size || busy} onClick={add}>
          Add {picked.size || ''} as {title}
        </button>
        <button type="button" className="button" onClick={() => onDone('')}>
          Cancel
        </button>
      </div>
    </section>
  );
}
