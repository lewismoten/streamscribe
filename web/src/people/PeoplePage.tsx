import { useState } from 'react';
import { Link } from 'react-router';
import { can } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import { duration } from '../format.ts';
import type { Publication } from '../published/types.ts';
import { groupOrder, placements } from '../civic/categories.ts';
import { useCivic } from '../civic/useCivic.ts';
import Avatar from './Avatar.tsx';
import { publicPeople } from './directory.ts';
import { namesOf, profileId, useProfiles } from './profiles.ts';
import PublicToggles from './PublicToggles.tsx';
import { shownName, type MeetingPerson } from './usePeople.ts';

// The people in meetings, by group: those serving now (elected, appointed or chosen by their board, staff of each
// organization, candidates) and those who have served, from their terms on public bodies (see ../civic/categories.ts);
// then everyone else by the group their source's roster gives them (Residents, Vendors…). Someone is in every group
// that fits, each saying what puts them there. People who may see meetings see everyone on the rosters, with how much
// each has spoken; those who may publish choose who is listed publicly and whose photo is public. Everyone else sees
// that public directory, with what each person speaks in among the published items.
export default function PeoplePage() {
  const civic = useCivic();
  const { account, viewer, directories } = civic;
  const publisher = can('publish', account);
  const { people: everyone, groups: rosterGroups } = civic.roster;
  const { records: publications } = useRecords<Publication>('publications');
  const [filter, setFilter] = useState('');
  const { profiles } = useProfiles();

  const listed = publicPeople(directories);
  const people = viewer ? everyone : listed;
  if (!people || civic.loading) return <p className="empty">Loading…</p>;
  const groups = viewer ? rosterGroups : [...new Set((directories || []).flatMap((directory) => directory.groups))];
  const appearsIn = (person: MeetingPerson) =>
    (publications || []).filter(
      (record) => record.data.sourceKey === person.sourceKey && record.data.speakers?.includes(person.id)
    ).length;
  // Each person once per group they belong in, with what puts them there.
  const entries = people.flatMap((person) => {
    const found = placements(person, civic);
    return found.length
      ? found.map((item) => ({ person, group: item.group, detail: item.detail }))
      : [{ person, group: person.group || 'Other', detail: '' }];
  });
  const needle = filter.trim().toLowerCase();
  const shown = entries
    .filter(
      (entry) =>
        !needle ||
        [
          entry.person.name,
          entry.person.role,
          entry.group,
          entry.detail,
          ...namesOf(profiles.get(profileId(entry.person.sourceKey, entry.person.id)))
        ].some((text) => text?.toLowerCase().includes(needle))
    )
    .sort((a, b) => b.person.seconds - a.person.seconds || shownName(a.person).localeCompare(shownName(b.person)));
  const civicGroups = groupOrder([...new Set(entries.map((entry) => entry.group))]);
  const order = [
    ...civicGroups,
    ...groups.filter((group) => !civicGroups.includes(group)),
    ...new Set(
      shown.map((entry) => entry.group).filter((group) => !civicGroups.includes(group) && !groups.includes(group))
    )
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
  // The public toggles go with a person's first card only.
  const toggled = new Set<string>();

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
        const members = shown.filter((entry) => entry.group === group);
        if (!members.length) return null;
        return (
          <section key={group} className="people-group">
            <h2>{group}</h2>
            <ul className="people-grid">
              {members.map(({ person, detail }) => {
                const firstCard = !toggled.has(person.key);
                toggled.add(person.key);
                return (
                  <li key={person.key}>
                    <Link
                      to={`/people/${encodeURIComponent(person.sourceKey)}/${encodeURIComponent(person.id)}`}
                      className="person-card"
                    >
                      <Avatar person={person} />
                      <span>
                        <strong>{shownName(person)}</strong>
                        {detail ? (
                          <span className="small">{detail}</span>
                        ) : (
                          person.role && !person.nameUnknown && <span className="muted small">{person.role}</span>
                        )}
                        <span className="muted small">{summary(person)}</span>
                      </span>
                    </Link>
                    {viewer && publisher && firstCard && (
                      <PublicToggles person={person} directories={directories} groups={rosterGroups} />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
