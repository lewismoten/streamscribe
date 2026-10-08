import { Link, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { clock, duration } from '../format.ts';
import Avatar from './Avatar.tsx';
import { personKey, shownName, usePeople } from './usePeople.ts';

// One person: who they are (photo, name, role, group) and the meetings they spoke in, each linked to the moment they
// first spoke.
export default function PersonPage() {
  const { source = '', id = '' } = useParams();
  const account = useAccount();
  const { people } = usePeople();
  if (account.checked && !can('view.meetings', account)) {
    return <p className="empty">The people in meetings are private, like the meetings.</p>;
  }
  if (!people) return <p className="empty">Loading…</p>;
  const person = people.find((item) => item.key === personKey(source, id));
  if (!person)
    return (
      <p>
        No such person. <Link to="/people">Everyone</Link>
      </p>
    );
  const meetingCount = new Set(person.meetings.map((item) => item.recordingId)).size;
  return (
    <article className="person">
      <header className="person-head">
        <Avatar person={person} size={120} />
        <div>
          <div className="card-kind">{[person.group, person.sourceName].filter(Boolean).join(' · ')}</div>
          <h1>{shownName(person)}</h1>
          {person.role && !person.nameUnknown && <p className="meta">{person.role}</p>}
          <p className="muted">
            {meetingCount
              ? `Spoke in ${meetingCount} meeting${meetingCount === 1 ? '' : 's'}, ${duration(person.seconds)} in all.`
              : 'Not marked speaking in any meeting yet.'}
          </p>
        </div>
      </header>
      {person.meetings.length > 0 && (
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
