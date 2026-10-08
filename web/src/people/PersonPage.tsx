import { Link, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { clock, duration } from '../format.ts';
import { useRecords } from '../data/useRecords.ts';
import type { Publication } from '../published/types.ts';
import Avatar from './Avatar.tsx';
import { useDirectory } from './directory.ts';
import { publicPeople } from './PeoplePage.tsx';
import PublicToggles from './PublicToggles.tsx';
import { personKey, shownName, usePeople } from './usePeople.ts';

// One person: who they are (photo, name, role, group), the published items they speak in, and (for people who may see
// meetings) the meetings they spoke in, each linked to the moment they first spoke. Everyone else sees listed people
// only, with their public photo.
export default function PersonPage() {
  const { source = '', id = '' } = useParams();
  const account = useAccount();
  const viewer = can('view.meetings', account);
  const directories = useDirectory();
  const { people: everyone, groups } = usePeople();
  const { records: publications } = useRecords<Publication>('publications');
  const people = viewer ? everyone : publicPeople(directories);
  if (!people) return <p className="empty">Loading…</p>;
  const person = people.find((item) => item.key === personKey(source, id));
  if (!person)
    return (
      <p>
        No such person. <Link to="/people">Everyone</Link>
      </p>
    );
  const meetingCount = new Set(person.meetings.map((item) => item.recordingId)).size;
  const published = (publications || [])
    .filter((record) => record.data.sourceKey === person.sourceKey && record.data.speakers?.includes(person.id))
    .sort((a, b) => String(b.data.publishedAt).localeCompare(String(a.data.publishedAt)));
  return (
    <article className="person">
      <header className="person-head">
        <Avatar person={person} size={120} />
        <div>
          <div className="card-kind">{[person.group, person.sourceName].filter(Boolean).join(' · ')}</div>
          <h1>{shownName(person)}</h1>
          {person.role && !person.nameUnknown && <p className="meta">{person.role}</p>}
          {viewer && can('publish', account) && (
            <PublicToggles person={person} directories={directories} groups={groups} />
          )}
          {viewer && (
            <p className="muted">
              {meetingCount
                ? `Spoke in ${meetingCount} meeting${meetingCount === 1 ? '' : 's'}, ${duration(person.seconds)} in all.`
                : 'Not marked speaking in any meeting yet.'}
            </p>
          )}
        </div>
      </header>
      {published.length > 0 && (
        <section className="panel">
          <h2>Published</h2>
          <ul>
            {published.map((record) => (
              <li key={record.id}>
                <Link to={`/published/${record.id}`}>{record.data.title}</Link>{' '}
                <span className="muted small">· {record.data.meeting}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {viewer && person.meetings.length > 0 && (
        <section className="panel">
          <h2>Meetings</h2>
          <table className="people">
            <thead>
              <tr>
                <th>Meeting</th>
                <th>First spoke</th>
                <th>Speaking</th>
                <th>Turns</th>
              </tr>
            </thead>
            <tbody>
              {person.meetings.map((item) => (
                <tr key={`${item.recordingId}-${item.part}`}>
                  <td>
                    <Link to={`/meetings/${item.recordingId}`}>{item.title}</Link>
                    <div className="muted small">
                      {item.startedAt
                        ? new Date(item.startedAt).toLocaleDateString('en-US', {
                            weekday: 'short',
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric'
                          })
                        : ''}
                    </div>
                  </td>
                  <td>
                    <Link
                      to={`/meetings/${item.recordingId}?part=${encodeURIComponent(item.part)}&t=${Math.floor(item.firstAt)}`}
                    >
                      {clock(item.firstAt)}
                    </Link>
                  </td>
                  <td>{duration(item.seconds)}</td>
                  <td>{item.turns}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </article>
  );
}
