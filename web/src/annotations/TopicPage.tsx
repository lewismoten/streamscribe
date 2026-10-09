import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { clock, date } from '../format.ts';
import { useSpeakerInfo } from './speakers.ts';
import { STANCES, type Stance, type Topic } from './types.ts';
import { atHref, byMeeting, useAnnotations } from './useAnnotations.ts';

// A topic: what it is, and every meeting where it came up: up to five of its chapters, five of the people who spoke
// to it (vendors first, then voting members, staff, and residents), and five moments; with the stances taken.
const MOST = 5;

export default function TopicPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const navigate = useNavigate();
  const { records: topics } = useRecords<Topic>('topics');
  const annotations = useAnnotations();
  const speakerInfo = useSpeakerInfo();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Topic>({ name: '' });
  if (!can('view.meetings', account)) return <p className="empty">Topics come from meetings, which are private.</p>;
  const topic = topics?.find((item) => item.id === id);
  if (!topics || !annotations) return <p className="empty">Loading…</p>;
  if (!topic)
    return (
      <p>
        No such topic. <Link to="/topics">All topics</Link>
      </p>
    );
  const tags = annotations.filter((item) => item.kind === 'topic' && item.link.topic?.id === id);
  const stances = tags.reduce<Record<string, number>>((counts, item) => {
    const stance = item.link.topic?.stance || 'neutral';
    return { ...counts, [stance]: (counts[stance] || 0) + 1 };
  }, {});
  const editor = can('contribute.chapters', account);

  return (
    <article>
      <div className="card-kind">
        <Link to="/topics">Topics</Link>
      </div>
      <div className="toolbar">
        <h1 className="grow">{topic.data.name}</h1>
        {editor && !editing && (
          <button
            type="button"
            className="button"
            onClick={() => {
              setDraft(topic.data);
              setEditing(true);
            }}
          >
            Change
          </button>
        )}
      </div>
      {editing ? (
        <form
          className="schedule-form panel"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!draft.name.trim()) return;
            await putRecord('topics', id, { ...draft, name: draft.name.trim() });
            setEditing(false);
          }}
        >
          <label className="block">
            Name
            <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="block">
            What it is
            <textarea
              rows={3}
              value={draft.description || ''}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
          </label>
          <div className="toolbar">
            <button type="submit" className="button primary">
              Save
            </button>
            <button type="button" className="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {tags.length === 0 && (
              <button
                type="button"
                className="link-button danger"
                onClick={async () => {
                  await removeRecord('topics', id);
                  navigate('/topics');
                }}
              >
                Delete the topic
              </button>
            )}
          </div>
        </form>
      ) : (
        topic.data.description && <p>{topic.data.description}</p>
      )}
      {tags.length > 0 && (
        <p className="small">
          {(Object.keys(STANCES) as Stance[])
            .filter((stance) => stances[stance])
            .map((stance) => `${STANCES[stance]}: ${stances[stance]}`)
            .join(' · ')}
        </p>
      )}
      {tags.length === 0 && <p className="muted">Not tagged in any meeting yet.</p>}
      {byMeeting(tags).map((items) => {
        const first = items[0];
        const chapters = [...new Set(items.map((item) => item.chapter).filter(Boolean))];
        const speakers = [
          ...new Map(
            items.flatMap((item) =>
              item.speakers.map((speaker) => [speaker, { ...speakerInfo(item.sourceKey, speaker), speaker }] as const)
            )
          ).values()
        ].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
        return (
          <section key={first.recordingId} className="panel topic-meeting">
            <h2>
              <Link to={`/meetings/${encodeURIComponent(first.recordingId)}`}>{first.meeting}</Link>{' '}
              <span className="muted small">{date(first.startedAt)}</span>
            </h2>
            {chapters.length > 0 && (
              <p className="small">
                <strong>Chapters:</strong> {chapters.slice(0, MOST).join(' · ')}
                {chapters.length > MOST && ` and ${chapters.length - MOST} more`}
              </p>
            )}
            {speakers.length > 0 && (
              <p className="small">
                <strong>Speakers:</strong>{' '}
                {speakers.slice(0, MOST).map((speaker, index) => (
                  <span key={speaker.speaker}>
                    {index > 0 && ', '}
                    {speaker.href ? <Link to={speaker.href}>{speaker.name}</Link> : speaker.name}
                  </span>
                ))}
                {speakers.length > MOST && ` and ${speakers.length - MOST} more`}
              </p>
            )}
            <ul className="small">
              {items.slice(0, MOST).map((item) => (
                <li key={item.link.id}>
                  <Link to={atHref(item)}>{clock(item.at)}</Link> “{item.link.text}”
                  {item.link.topic?.stance && item.link.topic.stance !== 'neutral' && (
                    <span className={`tag stance-${item.link.topic.stance}`}>{STANCES[item.link.topic.stance]}</span>
                  )}
                </li>
              ))}
              {items.length > MOST && <li className="muted">and {items.length - MOST} more</li>}
            </ul>
          </section>
        );
      })}
    </article>
  );
}
