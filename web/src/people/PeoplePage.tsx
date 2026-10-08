import { useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import { duration } from '../format.ts';
import type { Publication } from '../published/types.ts';
import Avatar from './Avatar.tsx';
import { useDirectory, type Directory } from './directory.ts';
import PublicToggles from './PublicToggles.tsx';
import { personKey, shownName, usePeople, type MeetingPerson } from './usePeople.ts';

// The people in meetings, by group. People who may see meetings see everyone on the rosters, with how much each has
// spoken; those who may publish choose who is listed publicly and whose photo is public. Everyone else sees that
// public directory, with what each person speaks in among the published items.
export default function PeoplePage() {
  const account = useAccount();
  const viewer = can('view.meetings', account);
  const publisher = can('publish', account);
  const directories = useDirectory();
  const { people: everyone, groups: rosterGroups } = usePeople();
  const { records: publications } = useRecords<Publication>('publications');
  const [filter, setFilter] = useState('');

  const listed = publicPeople(directories);
  const people = viewer ? everyone : listed;
  if (!people) return <p className="empty">Loading…</p>;
  const groups = viewer ? rosterGroups : [...new Set((directories || []).flatMap((directory) => directory.groups))];
  const appearsIn = (person: MeetingPerson) =>
    (publications || []).filter(
      (record) => record.data.sourceKey === person.sourceKey && record.data.speakers?.includes(person.id)
    ).length;
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
  const summary = (person: MeetingPerson) => {
    if (!viewer) {
      const count = appearsIn(person);
      return count ? `Speaks in ${count} published item${count === 1 ? '' : 's'}` : '';
    }
    const meetings = new Set(person.meetings.map((item) => item.recordingId)).size;
    return meetings
      ? `${meetings} meeting${meetings === 1 ? '' : 's'} · ${duration(person.seconds)} speaking`
      : 'Not marked speaking yet';
  };

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
      {viewer && publisher && (
        <p className="muted small">
          Choose who is listed on the public People page, and whose photo may be shown publicly (there, and in published
          transcripts).
        </p>
      )}
      {people.length === 0 && (
        <p className="empty">
          {viewer
            ? "Nobody yet. People named on a recorder's review page reach the hub with npm run publish-library."
            : 'Nobody is listed publicly yet.'}
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
                      <span className="muted small">{summary(person)}</span>
                    </span>
                  </Link>
                  {viewer && publisher && (
                    <PublicToggles person={person} directories={directories} groups={rosterGroups} />
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
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
