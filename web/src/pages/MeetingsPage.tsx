import { Link } from 'react-router';
import { useRecords } from '../data/useRecords.ts';
import { can, useAccount } from '../data/account.ts';
import { duration } from '../format.ts';

// Meetings on the hub: what the recorders have recorded (or are recording), newest first.
export interface RecordingData {
  occurrenceKey: string;
  title: string;
  sourceKey: string;
  sourceName?: string;
  recorderId: string;
  status: 'recording' | 'publishing' | 'done' | 'failed' | 'skipped' | 'official';
  scheduledStart: string;
  scheduledEnd: string;
  startedAt: string;
  stoppedAt: string | null;
  stopReason: string | null;
  durationSeconds: number;
  parts: { index: number; name: string; dir: string; seconds: number }[];
  error?: string | null;
  officialUrl?: string | null;
  official?: import('../meeting/OfficialPanel.tsx').Official | null;
}

export const STATUS_LABEL: Record<string, string> = {
  recording: '● Recording',
  publishing: 'Finishing up',
  done: 'Recorded',
  failed: 'Failed',
  official: 'Official video (found)',
  skipped: 'Skipped'
};
export const dateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })
    : '';

export default function MeetingsPage() {
  const { records } = useRecords<RecordingData>('recordings');
  const { records: stills } = useRecords<{ recordingId: string; path: string; position: number }>('stills');
  const checkedShare = useReviewShares();
  // Meetings are private: for groups that may see them (the file signature arriving re-renders the pictures).
  const account = useAccount();
  if (account.checked && !can('view.meetings', account)) {
    return (
      <p className="empty">
        Meetings are private.{' '}
        {account.user ? (
          "Your group can't see them."
        ) : (
          <>
            <Link to="/account">Sign in</Link> if you may see them.
          </>
        )}{' '}
        <Link to="/">See what's published</Link>
      </p>
    );
  }
  if (!records) return <p className="empty">Loading…</p>;
  const sorted = [...records].sort((a, b) =>
    String(b.data.scheduledStart || b.data.startedAt).localeCompare(String(a.data.scheduledStart || a.data.startedAt))
  );
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Meetings</h1>
      </div>
      {sorted.length === 0 && (
        <p className="empty">
          No meetings on the hub yet. Recorders add them as they record (see Schedules), or set a hub under Settings.
        </p>
      )}
      <div className="grid">
        {sorted.map((record) => {
          const picture = (stills || [])
            .filter((still) => still.data.recordingId === record.id)
            .sort((a, b) => a.data.position - b.data.position)[0];
          return (
            <article key={record.id} className="card">
              <Link to={`/meetings/${record.id}`} className="card-picture">
                {picture ? (
                  <img src={mediaUrlOf(picture.data.path)} alt="" loading="lazy" />
                ) : (
                  <div className="no-picture">🎙</div>
                )}
                {record.data.durationSeconds > 0 && (
                  <span className="badge duration">{duration(record.data.durationSeconds)}</span>
                )}
                {record.data.status === 'recording' && <span className="badge live">● Live</span>}
              </Link>
              <div className="card-body">
                <div className="card-kind">
                  {STATUS_LABEL[record.data.status] || record.data.status} · {record.data.sourceKey}
                </div>
                <h3>
                  <Link to={`/meetings/${record.id}`}>{record.data.title}</Link>
                </h3>
                <div className="muted">{dateTime(record.data.startedAt || record.data.scheduledStart)}</div>
                {checkedShare(record.id, record.data.durationSeconds) !== null && (
                  <div className="small" title="Minutes whose speakers and words have both been checked">
                    ✓ {Math.round(checkedShare(record.id, record.data.durationSeconds)! * 100)}% of the transcript
                    checked
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

import { mediaUrl } from '../data/hub.ts';
import { useReviewShares } from '../meeting/useReviewShares.ts';
export const mediaUrlOf = (path: string) => mediaUrl(path);
