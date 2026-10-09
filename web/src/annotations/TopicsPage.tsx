import { useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import { useAnnotations } from './useAnnotations.ts';
import type { Topic } from './types.ts';

// Topics the meetings discuss (tagged on transcript words), with how often each came up and in how many meetings.
export default function TopicsPage() {
  const account = useAccount();
  const { records: topics } = useRecords<Topic>('topics');
  const annotations = useAnnotations();
  const [find, setFind] = useState('');
  if (!can('view.meetings', account)) return <p className="empty">Topics come from meetings, which are private.</p>;
  if (!topics || !annotations) return <p className="empty">Loading…</p>;
  const tags = annotations.filter((item) => item.kind === 'topic');
  const needle = find.trim().toLowerCase();
  const shown = topics
    .filter((topic) => !needle || topic.data.name.toLowerCase().includes(needle))
    .map((topic) => {
      const mine = tags.filter((item) => item.link.topic?.id === topic.id);
      return { topic, count: mine.length, meetings: new Set(mine.map((item) => item.recordingId)).size };
    })
    .sort((a, b) => b.count - a.count || a.topic.data.name.localeCompare(b.topic.data.name));
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Topics</h1>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="Find a topic"
          aria-label="Find a topic"
        />
      </div>
      <p className="muted small">
        Select words in a meeting&apos;s transcript and choose <strong>Tag a topic…</strong> to add one.
      </p>
      {shown.length === 0 ? (
        <p className="empty">No topics yet.</p>
      ) : (
        <ul className="topic-list">
          {shown.map(({ topic, count, meetings }) => (
            <li key={topic.id}>
              <Link to={`/topics/${encodeURIComponent(topic.id)}`}>{topic.data.name}</Link>{' '}
              <span className="muted small">
                {count} time{count === 1 ? '' : 's'} in {meetings} meeting{meetings === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
