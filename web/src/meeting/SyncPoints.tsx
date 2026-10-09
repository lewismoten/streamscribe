import { useState } from 'react';
import { officialTime } from '../../../src/sync/official.js';
import { parseClock } from '../annotations/types.ts';
import { clock } from '../format.ts';
import type { Official } from './OfficialPanel.tsx';

// Keeping the official video lined up with this recording: matching moments (this recording's time and the official
// video's), between which times are worked out in step. Where the official video leaves something out (a recess),
// a point on either side of the gap keeps links right after it. A point is added at the player's moment, its
// official time typed from watching the official video there.
export default function SyncPoints({
  official,
  playerTime,
  onSave
}: {
  official: Official;
  playerTime: () => number;
  onSave: (official: Official) => Promise<void>;
}) {
  const key = official.swagit ? 'swagit' : 'video';
  const current = official[key];
  const [rows, setRows] = useState<{ here: string; there: string }[] | null>(null);
  const [problem, setProblem] = useState('');
  if (!current) return null;
  const points = current.timeline || [];
  const start = () => {
    setRows(points.map(([here, there]) => ({ here: clock(here), there: clock(there) })));
    setProblem('');
  };
  const addHere = () => {
    const here = playerTime();
    const there = officialTime(official, here) ?? here;
    setRows([...(rows || []), { here: clock(here), there: clock(there) }]);
  };
  const save = async () => {
    const parsed = (rows || []).map((row) => [parseClock(row.here), parseClock(row.there)] as [number, number]);
    if (parsed.some(([here, there]) => !Number.isFinite(here) || !Number.isFinite(there)))
      return setProblem('Each time is like 1:02:03');
    const timeline = parsed.sort((a, b) => a[0] - b[0]);
    await onSave({ ...official, [key]: { ...current, timeline: timeline.length ? timeline : undefined } });
    setRows(null);
  };
  if (!rows)
    return (
      <p className="small">
        {points.length
          ? `Lined up at ${points.length} point${points.length === 1 ? '' : 's'}.`
          : 'Not lined up by points yet.'}{' '}
        <button type="button" className="link-button" onClick={start}>
          Sync points…
        </button>
      </p>
    );
  return (
    <div className="schedule-form small sync-points">
      <p className="muted">
        Each row: this recording&apos;s time, and the official video&apos;s at the same moment. Add one on each side of
        anything the official video leaves out.
      </p>
      <table>
        <thead>
          <tr>
            <th>Here</th>
            <th>Official video</th>
            <th>
              <span className="visually-hidden">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td>
                <input
                  value={row.here}
                  onChange={(event) =>
                    setRows(rows.map((item, at) => (at === index ? { ...item, here: event.target.value } : item)))
                  }
                  aria-label={`Sync point ${index + 1}: this recording's time`}
                />
              </td>
              <td>
                <input
                  value={row.there}
                  onChange={(event) =>
                    setRows(rows.map((item, at) => (at === index ? { ...item, there: event.target.value } : item)))
                  }
                  aria-label={`Sync point ${index + 1}: the official video's time`}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="link-button danger"
                  onClick={() => setRows(rows.filter((_, at) => at !== index))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="toolbar">
        <button type="button" className="button" onClick={addHere}>
          ＋ At the player&apos;s moment
        </button>
        <span className="grow" />
        <button type="button" className="button primary" onClick={save}>
          Save the points
        </button>
        <button type="button" className="button" onClick={() => setRows(null)}>
          Cancel
        </button>
      </div>
      {problem && <p className="error">{problem}</p>}
    </div>
  );
}
