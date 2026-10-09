import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { stackMarks } from '../../../src/sync/layers.js';
import { bodiesOfRecording, type Body } from '../civic/types.ts';
import { can, useAccount } from '../data/account.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { clock, date, dayKey } from '../format.ts';
import type { TranscriptLink } from '../meeting/links.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import { usePeople, shownName } from '../people/usePeople.ts';
import {
  DEFAULT_SCRIPTURE_URL,
  firstChapter,
  passageName,
  passageUrl,
  SCRIPTURE_ID,
  useScriptureSite
} from './bible.ts';
import { PRAYER_KINDS, type Faith, type Prayer } from './prayers.ts';

// An internal reference, not shown to the public (only to people who may see meetings and edit public bodies):
// who led prayer at meetings, with their church, denomination, and tradition, counted so a rotation (or its lack)
// shows; every Bible passage named in a transcript; and which website passages link to.
export default function ReligionPage() {
  const account = useAccount();
  const allowed = can('view.meetings', account) && can('edit.bodies', account);
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: bodies } = useRecords<Body>('bodies');
  const { people } = usePeople();
  const scriptureSite = useScriptureSite();
  const [bodyId, setBodyId] = useState('');
  const [year, setYear] = useState('');

  const found = useMemo(() => {
    const stacks = stackMarks(marks || [], account.user?.id || 0) as Map<
      string,
      { data: Record<string, unknown> | null }
    >;
    const byRecording = new Map((recordings || []).map((record) => [record.id, record]));
    const prayers: { recording: (typeof recordings & {})[number]; prayer: Prayer; faith: Faith }[] = [];
    const passages: { recording: (typeof recordings & {})[number]; part: string; link: TranscriptLink }[] = [];
    for (const [markId, stack] of stacks) {
      if (!stack.data) continue;
      const prayerMark = markId.match(/^([^:]+):prayers$/);
      const recording = byRecording.get(markId.split(':')[0]);
      if (prayerMark && recording) {
        const faiths = (stacks.get(`${recording.data.sourceKey}:faith`)?.data?.people || {}) as Record<string, Faith>;
        for (const prayer of (stack.data.items as Prayer[]) || [])
          prayers.push({ recording, prayer, faith: faiths[prayer.personId] || {} });
      }
      const linkMark = markId.match(/^([^:]+):(.+):links$/);
      if (linkMark && recording)
        for (const link of (stack.data.items as TranscriptLink[]) || [])
          if (link.passage) passages.push({ recording, part: linkMark[2], link });
    }
    return { prayers, passages };
  }, [marks, recordings, account.user?.id]);

  if (!allowed) return <p className="empty">Only for people who may see meetings and edit public bodies.</p>;
  if (!marks || !recordings) return <p className="empty">Loading…</p>;
  const matches = (recording: { data: RecordingData }) =>
    (!year || dayKey(recording.data.startedAt).startsWith(year)) &&
    (!bodyId ||
      bodiesOfRecording(
        (bodies || []).filter((body) => body.id === bodyId),
        recording.data
      ).length > 0);
  const prayers = found.prayers
    .filter((item) => matches(item.recording))
    .sort((a, b) => String(b.recording.data.startedAt).localeCompare(String(a.recording.data.startedAt)));
  const passages = found.passages
    .filter((item) => matches(item.recording))
    .sort(
      (a, b) =>
        a.link.passage!.book.localeCompare(b.link.passage!.book) ||
        firstChapter(a.link.passage!) - firstChapter(b.link.passage!)
    );
  const nameOf = (sourceKey: string, personId: string) => {
    const person = people?.find((item) => item.sourceKey === sourceKey && item.id === personId);
    return person ? shownName(person) : personId;
  };
  const years = [
    ...new Set([...found.prayers, ...found.passages].map((item) => dayKey(item.recording.data.startedAt).slice(0, 4)))
  ].sort((a, b) => b.localeCompare(a));
  // How often each tradition, denomination, church, and person led prayer.
  const tally = (key: (item: (typeof prayers)[number]) => string) => {
    const counts = new Map<string, number>();
    for (const item of prayers) counts.set(key(item) || 'Not known', (counts.get(key(item) || 'Not known') || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1]);
  };

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Religion</h1>
        <label className="inline">
          Body{' '}
          <select value={bodyId} onChange={(event) => setBodyId(event.target.value)}>
            <option value="">All</option>
            {(bodies || []).map((body) => (
              <option key={body.id} value={body.id}>
                {body.data.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Year{' '}
          <select value={year} onChange={(event) => setYear(event.target.value)}>
            <option value="">All</option>
            {years.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted small">
        Only for people who may see meetings and edit public bodies; not shown to the public. Prayers are added on a
        meeting&apos;s page; passages by clicking a word of its transcript.
      </p>

      <section className="panel">
        <h2>Prayer</h2>
        {prayers.length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          <>
            <div className="tallies">
              {(
                [
                  ['Tradition', (item) => item.faith.tradition || ''],
                  ['Denomination', (item) => item.faith.denomination || ''],
                  ['Church', (item) => item.faith.church || ''],
                  ['Who', (item) => nameOf(item.recording.data.sourceKey, item.prayer.personId)]
                ] as [string, (item: (typeof prayers)[number]) => string][]
              ).map(([label, key]) => (
                <div key={label}>
                  <h3>{label}</h3>
                  <ul>
                    {tally(key).map(([value, count]) => (
                      <li key={value}>
                        <span className="tally-bar" style={{ width: `${(count / prayers.length) * 100}%` }} />
                        <span>
                          {value} <span className="muted small">{count}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <table className="people">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Church</th>
                  <th>Denomination</th>
                  <th>Tradition</th>
                </tr>
              </thead>
              <tbody>
                {prayers.map(({ recording, prayer, faith }) => (
                  <tr key={`${recording.id}-${prayer.id}`}>
                    <td>
                      <Link
                        to={`/meetings/${recording.id}?part=${encodeURIComponent(prayer.part)}&t=${Math.floor(prayer.at)}`}
                      >
                        {recording.data.title}
                      </Link>
                      <div className="muted small">
                        {date(recording.data.startedAt)} · {clock(prayer.at)}
                      </div>
                    </td>
                    <td>
                      <Link
                        to={`/people/${encodeURIComponent(recording.data.sourceKey)}/${encodeURIComponent(prayer.personId)}`}
                      >
                        {nameOf(recording.data.sourceKey, prayer.personId)}
                      </Link>
                    </td>
                    <td>{PRAYER_KINDS[prayer.kind]}</td>
                    <td>{faith.church}</td>
                    <td>{faith.denomination}</td>
                    <td>{faith.tradition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="panel">
        <h2>Passages</h2>
        {passages.length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          <table className="people">
            <thead>
              <tr>
                <th>Passage</th>
                <th>Said</th>
                <th>Meeting</th>
              </tr>
            </thead>
            <tbody>
              {passages.map(({ recording, part, link }) => (
                <tr key={`${recording.id}-${link.id}`}>
                  <td>
                    <a href={passageUrl(link.passage!, scriptureSite)} target="_blank" rel="noreferrer">
                      {passageName(link.passage!)}
                    </a>
                  </td>
                  <td>“{link.text}”</td>
                  <td>
                    <Link to={`/meetings/${recording.id}?part=${encodeURIComponent(part)}&t=${Math.floor(link.at)}`}>
                      {recording.data.title}
                    </Link>
                    <div className="muted small">
                      {date(recording.data.startedAt)} · {clock(link.at)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <ScriptureSite current={scriptureSite} />
    </section>
  );
}

// Which website a passage links to: an address with {passage} where the passage goes.
function ScriptureSite({ current }: { current: string }) {
  const [url, setUrl] = useState(current);
  const [message, setMessage] = useState('');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!/^https?:\/\/\S+$/.test(url.trim()) || !url.includes('{passage}'))
      return setMessage('A web address with {passage} where the passage goes');
    await putRecord('settings', SCRIPTURE_ID, { url: url.trim() });
    setMessage(
      'Saved. Passages link there from now on (published transcripts keep the links they were published with).'
    );
  };
  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>Where passages link</h2>
      <label className="block">
        Web address, with {'{passage}'} where the passage goes
        <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={DEFAULT_SCRIPTURE_URL} />
      </label>
      <p className="muted small">
        Such as {DEFAULT_SCRIPTURE_URL} (add &amp;version=NIV for a translation). Psalms 121-122 there:{' '}
        <a
          href={passageUrl({ book: 'Psalms', reference: '121-122' }, url || DEFAULT_SCRIPTURE_URL)}
          target="_blank"
          rel="noreferrer"
        >
          try it
        </a>
        .
      </p>
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save
        </button>
        {message && <output>{message}</output>}
      </div>
    </form>
  );
}
