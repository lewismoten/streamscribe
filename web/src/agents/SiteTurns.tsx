import { useEffect, useState } from 'react';
import { hubCall } from '../data/hub.ts';
import { useNow } from '../useNow.ts';
import { ago } from './types.ts';

// The websites the agents fetched from in the last day (hub-php/lib/turn-routes.php): each site's pace, shared by all
// of them (the longer of its robots.txt Crawl-delay and the agents' rate setting), who asked last, and how far ahead
// turns are booked (agents waiting their turn).
interface Turn {
  host: string;
  intervalMs: number;
  lastBy: string;
  lastAt: string;
  count: number;
  queuedMs: number;
}

const seconds = (ms: number) => (ms >= 10000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 100) / 10} s`);

export default function SiteTurns({ names }: { names: Record<string, string> }) {
  const now = useNow(10000);
  const [turns, setTurns] = useState<Turn[] | null>(null);
  useEffect(() => {
    const load = () =>
      hubCall<{ turns: Turn[] }>('turns')
        .then((value) => setTurns(value.turns))
        .catch(() => setTurns([]));
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, []);
  if (!turns?.length) return null;
  return (
    <section className="panel">
      <h2>Websites</h2>
      <p className="muted small">
        The agents take turns at each site, so together they ask it no more often than its robots.txt (or their rate
        setting) allows.
      </p>
      <table className="people jobs">
        <thead>
          <tr>
            <th>Site</th>
            <th>One request every</th>
            <th>Last</th>
            <th>Requests today</th>
            <th>Waiting</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((turn) => (
            <tr key={turn.host}>
              <td>
                <code>{turn.host}</code>
              </td>
              <td>{seconds(turn.intervalMs)}</td>
              <td>
                {names[turn.lastBy] || turn.lastBy}, {ago(turn.lastAt, now)}
              </td>
              <td>{turn.count}</td>
              <td>{turn.queuedMs > turn.intervalMs ? `turns booked ${seconds(turn.queuedMs)} ahead` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
