import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api, type Config, type Kind, type Recording } from '../api.ts';
import { date, dayKey, recordingTitle } from '../format.ts';
import RecordingCard from '../RecordingCard.tsx';

type Filter = 'all' | Kind;
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'meeting', label: 'Full meetings' },
  { value: 'session', label: 'Live captures' },
  { value: 'archive', label: 'Official recordings' }
];

const remembered = (key: string, fallback: string) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const remember = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
};

// Every recording, newest first, grouped by day.
export default function Library({ config }: { config: Config }) {
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>(() => remembered('library.filter', 'all') as Filter);
  const [source, setSource] = useState(() => remembered('library.source', ''));
  const [hideParts, setHideParts] = useState(() => remembered('library.hideParts', '1') === '1');
  const [text, setText] = useState('');
  const [scanning, setScanning] = useState(false);

  const load = useCallback(() => api.recordings().then(setRecordings).catch((reason: Error) => setError(reason.message)), []);
  useEffect(() => {
    load();
    // Live captures grow while the page is open.
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  const partCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of recordings || []) if (item.partOf) counts.set(item.partOf, (counts.get(item.partOf) || 0) + 1);
    return counts;
  }, [recordings]);

  const shown = useMemo(() => (recordings || []).filter((item) =>
    (filter === 'all' || item.kind === filter)
    && (!source || item.source === source)
    && !(hideParts && item.partOf && filter !== 'session')
    && (!text.trim() || recordingTitle(item).toLowerCase().includes(text.trim().toLowerCase()))
  ), [recordings, filter, source, hideParts, text]);

  const days = useMemo(() => {
    const groups: { key: string; label: string; items: Recording[] }[] = [];
    for (const item of shown) {
      const key = dayKey(item.startedAt) || 'undated';
      let group = groups.find((entry) => entry.key === key);
      if (!group) groups.push(group = { key, label: item.startedAt ? date(item.startedAt) : 'Date unknown', items: [] });
      group.items.push(item);
    }
    return groups;
  }, [shown]);

  const rescan = async () => {
    setScanning(true);
    try { await api.scan(); await load(); } finally { setScanning(false); }
  };

  return (
    <section>
      <div className="toolbar">
        <div className="segmented" role="tablist">
          {FILTERS.map((item) => (
            <button key={item.value} type="button" role="tab" aria-selected={filter === item.value} className={filter === item.value ? 'selected' : ''}
              onClick={() => { setFilter(item.value); remember('library.filter', item.value); }}>{item.label}</button>
          ))}
        </div>
        {config.sources.length > 1 && (
          <select value={source} onChange={(event) => { setSource(event.target.value); remember('library.source', event.target.value); }} aria-label="Source">
            <option value="">All sources</option>
            {config.sources.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
          </select>
        )}
        <input type="search" placeholder="Filter by name" value={text} onChange={(event) => setText(event.target.value)} aria-label="Filter by name" />
        {filter !== 'session' && (
          <label className="check" title="Live captures that build-meeting joined into a full meeting">
            <input type="checkbox" checked={hideParts} onChange={(event) => { setHideParts(event.target.checked); remember('library.hideParts', event.target.checked ? '1' : '0'); }} />
            Hide captures already in a full meeting
          </label>
        )}
        <button type="button" className="button end" onClick={rescan} disabled={scanning} title="Look for new recordings and transcripts now (also happens every half minute)">
          {scanning ? 'Scanning…' : '↻ Rescan'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {recordings && shown.length === 0 && <p className="empty">No recordings match. Start one on the <Link to="/capture">Capture</Link> page.</p>}
      {days.map((day) => (
        <div key={day.key} className="day">
          <h2>{day.label}</h2>
          <div className="grid">
            {day.items.map((item) => <RecordingCard key={item.id} recording={item} partCount={partCounts.get(item.id) || 0} />)}
          </div>
        </div>
      ))}
    </section>
  );
}
