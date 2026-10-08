import { Link, useParams } from 'react-router';
import { can } from '../data/account.ts';
import { clock, date, dayKey, duration } from '../format.ts';
import { useRecords } from '../data/useRecords.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import type { Publication } from '../published/types.ts';
import PersonService from '../civic/PersonService.tsx';
import { activeOn, bodiesOfRecording, MEMBER_KINDS, personKeyOf, STAFF_KINDS } from '../civic/types.ts';
import { useCivic } from '../civic/useCivic.ts';
import Avatar from './Avatar.tsx';
import { publicPeople } from './PeoplePage.tsx';
import PublicToggles from './PublicToggles.tsx';
import { personKey, shownName, type MeetingPerson } from './usePeople.ts';

// One person: who they are (photo, name, role, group), their public service (bodies, seats, offices, staff
// positions, runs for office; see ../civic), the published items they speak in, and (for people who may see meetings)
// the meetings they presided at, attended, missed, or spoke in, each linked to the moment they first spoke. Everyone
// else sees listed people only, with their public photo.
export default function PersonPage() {
  const { source = '', id = '' } = useParams();
  const civic = useCivic();
  const { account, viewer, directories } = civic;
  const { people: everyone, groups } = civic.roster;
  const { records: publications } = useRecords<Publication>('publications');
  const { records: recordings } = useRecords<RecordingData>('recordings');
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
  const rows = viewer ? meetingRows(person, recordings || [], civic) : [];
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
      <PersonService person={person} civic={civic} />
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
      {viewer && rows.length > 0 && (
        <section className="panel">
          <h2>Meetings</h2>
          <table className="people">
            <thead>
              <tr>
                <th>Meeting</th>
                <th>There as</th>
                <th>First spoke</th>
                <th>Speaking</th>
                <th>Turns</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.recordingId}>
                  <td>
                    <Link to={`/meetings/${row.recordingId}`}>{row.title}</Link>
                    <div className="muted small">{date(row.startedAt)}</div>
                  </td>
                  <td>{row.role}</td>
                  <td>
                    {row.spoke && (
                      <Link
                        to={`/meetings/${row.recordingId}?part=${encodeURIComponent(row.spoke.part)}&t=${Math.floor(row.spoke.firstAt)}`}
                      >
                        {clock(row.spoke.firstAt)}
                      </Link>
                    )}
                  </td>
                  <td>{row.spoke ? duration(row.spoke.seconds) : ''}</td>
                  <td>{row.spoke?.turns || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </article>
  );
}

// The meetings of a person's source where they presided, were marked present or absent, were expected (on the
// body that day, by their terms), or spoke; newest first.
function meetingRows(
  person: MeetingPerson,
  recordings: { id: string; data: RecordingData }[],
  civic: ReturnType<typeof useCivic>
) {
  const terms = (civic.terms || [])
    .map((term) => term.data)
    .filter(
      (term) => personKeyOf(term) === person.key && [...MEMBER_KINDS, ...STAFF_KINDS, 'officer'].includes(term.kind)
    );
  return recordings
    .filter((record) => record.data.sourceKey === person.sourceKey)
    .sort((a, b) => String(b.data.startedAt).localeCompare(String(a.data.startedAt)))
    .map((record) => {
      const attendance = civic.roster.attendance.get(record.id) || {};
      const appearances = person.meetings.filter((item) => item.recordingId === record.id);
      const spoke = appearances.length
        ? {
            part: appearances[0].part,
            firstAt: appearances[0].firstAt,
            seconds: appearances.reduce((sum, item) => sum + item.seconds, 0),
            turns: appearances.reduce((sum, item) => sum + item.turns, 0)
          }
        : null;
      const day = dayKey(record.data.startedAt);
      const bodies = bodiesOfRecording(civic.bodies || [], record.data, attendance.bodyId);
      const expected = terms
        .filter((term) => activeOn(term, day) && bodies.some((body) => body.id === term.bodyId))
        .map((term) => term.title);
      const role =
        attendance.presiding === person.id
          ? 'Presided'
          : attendance.present?.includes(person.id)
            ? 'Attended'
            : attendance.absent?.includes(person.id)
              ? 'Absent'
              : expected.length
                ? `${[...new Set(expected)].join(', ')} (not marked)`
                : spoke
                  ? 'Spoke'
                  : '';
      return { recordingId: record.id, title: record.data.title, startedAt: record.data.startedAt, role, spoke };
    })
    .filter((row) => row.role);
}
