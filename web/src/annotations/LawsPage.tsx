import { useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import { LAW_KINDS, LAW_LEVELS, lawTitle, type Law, type LawKind, type LawLevel } from './types.ts';
import { useAnnotations } from './useAnnotations.ts';

// Laws and documents cited in meetings, grouped by level (federal, state, county, town) or by kind (code, acts,
// bills, ordinances, …), each with how often it was cited and a link to read it.
export default function LawsPage() {
  const account = useAccount();
  const { records: laws } = useRecords<Law>('laws');
  const annotations = useAnnotations();
  const [by, setBy] = useState<'level' | 'kind'>('level');
  const [find, setFind] = useState('');
  if (!laws) return <p className="empty">Loading…</p>;
  const viewer = can('view.meetings', account);
  const counts = new Map<string, number>();
  for (const item of annotations || [])
    if (item.link.law) counts.set(item.link.law.id, (counts.get(item.link.law.id) || 0) + 1);
  const needle = find.trim().toLowerCase();
  const shown = laws.filter(
    (law) => !needle || [lawTitle(law.data), law.data.jurisdiction].join(' ').toLowerCase().includes(needle)
  );
  const groups = (by === 'level' ? Object.keys(LAW_LEVELS) : Object.keys(LAW_KINDS)) as (LawLevel | LawKind)[];
  const labelOf = (key: string) => (by === 'level' ? LAW_LEVELS[key as LawLevel] : LAW_KINDS[key as LawKind]);
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Laws and documents</h1>
        <fieldset className="segmented" aria-label="Group by">
          <button type="button" className={by === 'level' ? 'on' : ''} onClick={() => setBy('level')}>
            By level
          </button>
          <button type="button" className={by === 'kind' ? 'on' : ''} onClick={() => setBy('kind')}>
            By kind
          </button>
        </fieldset>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="Find a law"
          aria-label="Find a law"
        />
      </div>
      <p className="muted small">
        Select words in a meeting&apos;s transcript and choose <strong>Cite a law or document…</strong> to add one.
      </p>
      {shown.length === 0 && <p className="empty">None cited yet.</p>}
      {groups.map((group) => {
        const inGroup = shown
          .filter((law) => (by === 'level' ? law.data.level : law.data.kind) === group)
          .sort((a, b) => lawTitle(a.data).localeCompare(lawTitle(b.data)));
        if (!inGroup.length) return null;
        return (
          <section key={group} className="panel">
            <h2>{labelOf(group)}</h2>
            <ul>
              {inGroup.map((law) => (
                <li key={law.id}>
                  <Link to={`/laws/${encodeURIComponent(law.id)}`}>{lawTitle(law.data)}</Link>
                  {law.data.jurisdiction && <span className="muted small"> · {law.data.jurisdiction}</span>}
                  {viewer && (
                    <span className="muted small">
                      {' '}
                      · cited {counts.get(law.id) || 0} time{counts.get(law.id) === 1 ? '' : 's'}
                    </span>
                  )}
                  {law.data.url && (
                    <>
                      {' '}
                      <a href={law.data.url} target="_blank" rel="noreferrer">
                        Read it ↗
                      </a>
                    </>
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
