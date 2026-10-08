import { useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { duration } from '../format.ts';
import Avatar from './Avatar.tsx';
import { shownName, usePeople } from './usePeople.ts';

// The people in meetings: everyone on the sources' rosters, by group, with their role and how much they've spoken.
// Private like the meetings their photos and speaking come from.
export default function PeoplePage() {
  const account = useAccount();
  const { people, groups } = usePeople();
  const [filter, setFilter] = useState('');
  if (account.checked && !can('view.meetings', account)) {
    return (
      <p className="empty">
        The people in meetings are private, like the meetings.{' '}
        {account.user ? "Your group can't see them." : <Link to="/account">Sign in</Link>}
      </p>
    );
  }
  if (!people) return <p className="empty">Loading…</p>;
  const needle = filter.trim().toLowerCase();
  const shown = people
    .filter(
      (person) =>
        !needle || [person.name, person.role, person.group].some((text) => text?.toLowerCase().includes(needle))
    )
    .sort((a, b) => b.seconds - a.seconds || shownName(a).localeCompare(shownName(b)));
  const order = [
    ...groups,
    ...new Set(shown.map((person) => person.group || 'Other').filter((group) => !groups.includes(group)))
  ];
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">People</h1>
        <input
          type="search"
          placeholder="Find a person, role, or group"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Find a person, role, or group"
        />
      </div>
      {people.length === 0 && (
        <p className="empty">
          Nobody yet. People named on a recorder's review page reach the hub with npm run publish-library.
        </p>
      )}
      {order.map((group) => {
        const members = shown.filter((person) => (person.group || 'Other') === group);
        if (!members.length) return null;
        return (
          <section key={group} className="people-group">
            <h2>{group}</h2>
            <ul className="people-grid">
              {members.map((person) => (
                <li key={person.key}>
                  <Link
                    to={`/people/${encodeURIComponent(person.sourceKey)}/${encodeURIComponent(person.id)}`}
                    className="person-card"
                  >
                    <Avatar person={person} />
                    <span>
                      <strong>{shownName(person)}</strong>
                      {person.role && !person.nameUnknown && <span className="muted small">{person.role}</span>}
                      <span className="muted small">
                        {person.meetings.length
                          ? `${new Set(person.meetings.map((item) => item.recordingId)).size} meeting${new Set(person.meetings.map((item) => item.recordingId)).size === 1 ? '' : 's'} · ${duration(person.seconds)} speaking`
                          : 'Not marked speaking yet'}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
