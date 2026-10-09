import { useState, type FormEvent } from 'react';
import { can, useAccount } from '../data/account.ts';
import { syncNow } from '../data/sync.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { date } from '../format.ts';

// Sources (the hub's sources records): who streams meetings, and where their past and coming meetings are found:
// feeds of a few kinds (a Swagit site's archive, a YouTube channel's videos whose titles match, a calendar's events
// whose names match, dates listed on a page). Find meetings now queues an agent to read a source's feeds; each meeting
// found goes on the schedule, and meetings with a video elsewhere get their transcript and a picture queued.
interface Feed {
  kind: 'swagit' | 'youtube' | 'ical' | 'page-dates';
  base?: string;
  views?: string[];
  channel?: string;
  url?: string;
  match?: string;
  title?: string;
  after?: string;
  time?: string;
  category?: string;
  notStreamed?: boolean;
}
interface Source {
  name: string;
  timeZone?: string;
  discovery?: Feed[];
}
const KINDS: Record<Feed['kind'], string> = {
  swagit: 'Swagit archive',
  youtube: 'YouTube channel',
  ical: 'Calendar (iCal)',
  'page-dates': 'Dates on a page'
};
const now = () => new Date().toISOString();
const stamp = () => Date.now().toString(36);

function FeedFields({ feed, onChange }: { feed: Feed; onChange: (feed: Feed) => void }) {
  const field = (key: keyof Feed, label: string, placeholder = '') => (
    <label>
      {label}
      <input
        value={key === 'views' ? (feed.views || []).join(', ') : String(feed[key] ?? '')}
        placeholder={placeholder}
        onChange={(event) =>
          onChange({
            ...feed,
            [key]:
              key === 'views'
                ? event.target.value
                    .split(/[,\s]+/)
                    .map((item) => item.trim())
                    .filter(Boolean)
                : event.target.value
          })
        }
      />
    </label>
  );
  return (
    <div className="form-grid">
      {feed.kind === 'swagit' && (
        <>
          {field('base', 'Site', 'https://example.new.swagit.com')}
          {field('views', 'Archive views (numbers)', '179')}
        </>
      )}
      {feed.kind === 'youtube' && (
        <>
          {field('channel', 'Channel', 'https://www.youtube.com/@channel')}
          {field('match', 'Titles matching', 'Trustee|Meeting')}
        </>
      )}
      {feed.kind === 'ical' && (
        <>
          {field('url', 'Calendar address', 'https://…/events/feed/ical')}
          {field('match', 'Events matching', 'Committee|Board')}
        </>
      )}
      {feed.kind === 'page-dates' && (
        <>
          {field('url', 'Page', 'https://…/board')}
          {field('title', 'Meeting name', 'Board of Trustees')}
          {field('after', 'After the words', 'Board Meetings')}
        </>
      )}
      {field('time', 'Usual time', '17:30')}
      {field('category', 'Category (to match a public body)')}
      <label className="inline">
        <input
          type="checkbox"
          checked={Boolean(feed.notStreamed)}
          onChange={(event) => onChange({ ...feed, notStreamed: event.target.checked })}
        />{' '}
        Not streamed live
      </label>
    </div>
  );
}

export default function SourcesPage() {
  const account = useAccount();
  const { records: sources } = useRecords<Source>('sources');
  const { records: jobs } = useRecords<{
    type: string;
    sourceKey?: string;
    status: string;
    result?: { found?: number; added?: number; queued?: number };
    finishedAt?: string;
    message?: string;
  }>('jobs');
  const [editing, setEditing] = useState<{ id: string; data: Source } | null>(null);
  const [newKey, setNewKey] = useState('');
  const editor = can('edit.sources', account);
  if (!sources) return <p className="empty">Loading…</p>;
  const lastDiscovery = (key: string) =>
    (jobs || [])
      .filter((job) => job.data.type === 'discover' && job.data.sourceKey === key)
      .sort((a, b) => String(b.data.finishedAt || '').localeCompare(String(a.data.finishedAt || '')))[0]?.data;
  const findNow = async (key: string) => {
    await putRecord('jobs', `discover-${key}-${stamp()}`, {
      type: 'discover',
      status: 'queued',
      title: `Find meetings: ${sources.find((item) => item.id === key)?.data.name || key}`,
      sourceKey: key,
      progress: 0,
      message: '',
      agent: null,
      createdAt: now(),
      createdBy: account.user?.displayName || account.user?.username || ''
    });
    syncNow();
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    await putRecord('sources', editing.id, {
      ...editing.data,
      discovery: (editing.data.discovery || []).filter((feed) => feed.base || feed.channel || feed.url)
    });
    setEditing(null);
  };
  return (
    <section>
      <h1>Sources</h1>
      <p className="muted">
        Who streams meetings, and where their past and coming meetings are found. <strong>Find meetings now</strong> has
        an agent read a source&apos;s feeds: each meeting goes on the schedule (in the past too), and those with a video
        elsewhere get its transcript and a picture.
      </p>
      {sources.map((source) => {
        const last = lastDiscovery(source.id);
        return (
          <article key={source.id} className="panel">
            <div className="toolbar">
              <strong className="grow">
                {source.data.name || source.id} <code className="small">{source.id}</code>
              </strong>
              {editor && (
                <>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setEditing({ id: source.id, data: source.data })}
                  >
                    Feeds…
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => findNow(source.id)}
                    disabled={
                      !(source.data.discovery || []).length || last?.status === 'queued' || last?.status === 'working'
                    }
                  >
                    Find meetings now
                  </button>
                </>
              )}
            </div>
            <p className="small muted">
              {(source.data.discovery || [])
                .map((feed) => `${KINDS[feed.kind]}: ${feed.base || feed.channel || feed.url}`)
                .join(' · ') || 'No feeds yet.'}
            </p>
            {last && (
              <p className="small">
                {last.status === 'done'
                  ? `Last found ${last.result?.found ?? 0} meetings (${last.result?.added ?? 0} new, ${last.result?.queued ?? 0} jobs queued)${last.finishedAt ? `, ${date(last.finishedAt)}` : ''}.`
                  : last.status === 'failed'
                    ? `Finding failed: ${last.message}`
                    : 'Finding meetings…'}
              </p>
            )}
          </article>
        );
      })}
      {editor && (
        <form
          className="toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            const key = newKey
              .trim()
              .toLowerCase()
              .replace(/[^a-z0-9-]+/g, '-');
            if (!key) return;
            setEditing({
              id: key,
              data: { name: newKey.trim(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, discovery: [] }
            });
            setNewKey('');
          }}
        >
          <input
            value={newKey}
            onChange={(event) => setNewKey(event.target.value)}
            placeholder="A new source's name"
            aria-label="A new source's name"
          />
          <button type="submit" className="button">
            ＋ Source
          </button>
        </form>
      )}
      {editing && (
        <form className="panel schedule-form" onSubmit={save}>
          <h2>{editing.data.name || editing.id}</h2>
          <div className="form-grid">
            <label>
              Name
              <input
                value={editing.data.name}
                onChange={(event) => setEditing({ ...editing, data: { ...editing.data, name: event.target.value } })}
              />
            </label>
            <label>
              Time zone
              <input
                value={editing.data.timeZone || ''}
                onChange={(event) =>
                  setEditing({ ...editing, data: { ...editing.data, timeZone: event.target.value } })
                }
                placeholder="America/New_York"
              />
            </label>
          </div>
          {(editing.data.discovery || []).map((feed, index) => (
            <fieldset key={index}>
              <legend>
                {KINDS[feed.kind]}{' '}
                <button
                  type="button"
                  className="link-button danger"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      data: { ...editing.data, discovery: editing.data.discovery!.filter((_, at) => at !== index) }
                    })
                  }
                >
                  Remove
                </button>
              </legend>
              <FeedFields
                feed={feed}
                onChange={(next) =>
                  setEditing({
                    ...editing,
                    data: {
                      ...editing.data,
                      discovery: editing.data.discovery!.map((item, at) => (at === index ? next : item))
                    }
                  })
                }
              />
            </fieldset>
          ))}
          <div className="toolbar">
            {(Object.keys(KINDS) as Feed['kind'][]).map((kind) => (
              <button
                key={kind}
                type="button"
                className="link-button"
                onClick={() =>
                  setEditing({
                    ...editing,
                    data: { ...editing.data, discovery: [...(editing.data.discovery || []), { kind }] }
                  })
                }
              >
                ＋ {KINDS[kind]}
              </button>
            ))}
          </div>
          <div className="toolbar">
            <button type="submit" className="button primary">
              Save
            </button>
            <button type="button" className="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
