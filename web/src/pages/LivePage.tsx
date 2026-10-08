import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { hubCall, hubSettings, mediaUrl } from '../data/hub.ts';
import { startSyncing } from '../data/sync.ts';
import { useRecords } from '../data/useRecords.ts';
import { can, useAccount } from '../data/account.ts';
import { clock, duration } from '../format.ts';
import { useNow } from '../useNow.ts';

// What the recorders are doing right now: each one's state, live picture, and the latest quick transcript, from the
// hub's live reports (checked every 10 seconds; transcripts sync every 10 seconds while this page is open).
interface LiveRecording {
  recordingId: string;
  title: string;
  sourceKey: string;
  startedAt: string;
  scheduledEnd: string;
  lastSegmentAt: string | null;
  keptSeconds: number;
  quickChunks: number;
}
interface LiveRecorder {
  recorderId: string;
  name: string;
  updatedAt: string;
  status: {
    state: string;
    name: string;
    version: string;
    freeGb: number | null;
    clockSkewSeconds: number | null;
    next: { title: string; start: string; end: string } | null;
    recordings: LiveRecording[];
  } | null;
}
interface Chunk {
  recordingId: string;
  kind: string;
  partIndex: number;
  from: number;
  lines: { start: number; text: string }[];
}

const ago = (iso: string) => {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)} min ago`;
};

export default function LivePage() {
  const [recorders, setRecorders] = useState<LiveRecorder[] | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const { records: chunks } = useRecords<Chunk>('transcript_chunks');
  const { url } = hubSettings();
  const now = useNow(10000);
  // What's being recorded is private: for groups that may see meetings.
  const account = useAccount();
  const allowed = can('view.meetings', account);
  useEffect(() => {
    if (!url || !allowed) return;
    startSyncing(10);
    const load = () =>
      hubCall<{ recorders: LiveRecorder[] }>('live')
        .then((value) => {
          setRecorders(value.recorders || []);
          setError('');
          setTick((count) => count + 1);
        })
        .catch((reason: Error) => setError(reason.message));
    load();
    const timer = setInterval(load, 10000);
    return () => {
      clearInterval(timer);
      startSyncing(30);
    };
  }, [url, allowed]);

  if (!url)
    return (
      <p className="empty">
        Set the hub under <Link to="/settings">Settings</Link> to see recorders live.
      </p>
    );
  if (account.checked && !allowed)
    return (
      <p className="empty">
        Meetings are private, live ones too.{' '}
        {account.user ? (
          "Your group can't see them."
        ) : (
          <>
            <Link to="/account">Sign in</Link> if you may see them.
          </>
        )}
      </p>
    );
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Live</h1>
        {error && <span className="error">Can't reach the hub: {error}</span>}
      </div>
      {recorders && recorders.length === 0 && <p className="empty">No recorder has reported to this hub yet.</p>}
      {(recorders || []).map((recorder) => {
        const status = recorder.status;
        const stale = now - Date.parse(recorder.updatedAt) > 90000;
        const recording = status?.recordings?.[0];
        const recent = recording
          ? (chunks || [])
              .filter((chunk) => chunk.data.recordingId === recording.recordingId)
              .sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.from - b.data.from)
              .flatMap((chunk) => chunk.data.lines)
              .slice(-14)
          : [];
        return (
          <section key={recorder.recorderId} className="panel live-recorder">
            <div className="panel-head">
              <h2>{status?.name || recorder.name}</h2>
              <span className={`state ${status?.state === 'recording' && !stale ? 'on' : 'off'}`}>
                {stale ? 'Not heard from' : status?.state === 'recording' ? '● Recording' : 'Idle'}
              </span>
              <span className="muted">
                updated {ago(recorder.updatedAt)}
                {status?.freeGb !== null && status?.freeGb !== undefined ? ` · ${status.freeGb} GB free` : ''}
                {Math.abs(status?.clockSkewSeconds || 0) > 30 ? ` · clock off by ${status?.clockSkewSeconds}s` : ''}
              </span>
            </div>
            {recording ? (
              <div className="live-body">
                <img
                  className="live-picture"
                  src={`${mediaUrl(`private/live/${recorder.recorderId}.jpg`)}&t=${tick}`}
                  alt=""
                />
                <div>
                  <h3>
                    <Link to={`/meetings/${recording.recordingId}`}>{recording.title}</Link>
                  </h3>
                  <p className="muted">
                    Since{' '}
                    {new Date(recording.startedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}{' '}
                    · {duration(recording.keptSeconds)} recorded · scheduled until{' '}
                    {new Date(recording.scheduledEnd).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit'
                    })}
                    {recording.lastSegmentAt ? ` · newest video ${ago(recording.lastSegmentAt)}` : ''}
                  </p>
                  {recent.length ? (
                    <ol className="lines">
                      {recent.map((line, index) => (
                        <li key={index}>
                          <span className="time">{clock(line.start)}</span>
                          <span>{line.text}</span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="muted">The quick transcript appears here about a minute after recording starts.</p>
                  )}
                </div>
              </div>
            ) : (
              <p className="muted">
                {status?.next
                  ? `Next: ${status.next.title}, ${new Date(status.next.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
                  : 'Nothing scheduled.'}
              </p>
            )}
          </section>
        );
      })}
    </section>
  );
}
