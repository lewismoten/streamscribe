import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api, type CaptureStatus } from '../api.ts';
import { duration, recordingTitle, time } from '../format.ts';

// Start and stop live captures, and watch them: each source's state, its newest capture, and the capture's log.
export default function CapturePage() {
  const [statuses, setStatuses] = useState<CaptureStatus[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(
    () =>
      api
        .capture()
        .then((value) => {
          setStatuses(value);
          setError('');
        })
        .catch((reason: Error) => setError(reason.message)),
    []
  );
  useEffect(() => {
    load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (source: string, action: 'start' | 'stop') => {
    if (action === 'stop' && !confirm('Stop recording this source?')) return;
    setBusy(source);
    try {
      await (action === 'start' ? api.startCapture(source) : api.stopCapture(source));
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section>
      {error && <p className="error">{error}</p>}
      {statuses?.map((status) => {
        const appJobs = status.jobs.filter((job) => job.status === 'running' || job.status === 'stopping');
        const stopping = appJobs.some((job) => job.status === 'stopping');
        return (
          <section key={status.source} className="panel capture">
            <div className="panel-head">
              <h2>{status.name}</h2>
              <span className={`state ${status.running ? 'on' : 'off'}`}>
                {stopping ? 'Stopping…' : status.running ? '● Recording' : 'Not recording'}
              </span>
              <span className="muted">{status.provider}</span>
              <span className="end">
                {appJobs.length > 0 ? (
                  <button
                    type="button"
                    className="button danger"
                    disabled={busy === status.source || stopping}
                    onClick={() => act(status.source, 'stop')}
                  >
                    ■ Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button primary"
                    disabled={busy === status.source || status.external.length > 0}
                    onClick={() => act(status.source, 'start')}
                  >
                    ● Start capture
                  </button>
                )}
              </span>
            </div>
            {status.external.length > 0 && (
              <p className="note">
                A capture started outside the app is running (process{' '}
                {status.external.map((item) => item.pid).join(', ')}). Stop it where it was started (Ctrl+C in its
                terminal) before starting one here.
              </p>
            )}
            <p className="muted">
              Starting a capture records the stream until you stop it. Moments before you start (as far back as the
              server keeps them) and network gaps are recovered, the standby slide between meetings is skipped, and the
              review page keeps up as it records.
            </p>
            {status.latest && (
              <div className="latest">
                <span>
                  Newest capture: <Link to={`/recordings/${status.latest.id}`}>{recordingTitle(status.latest)}</Link>
                </span>
                <span className="muted">
                  {' '}
                  · {duration(status.latest.durationSeconds)}
                  {status.latest.endedAt ? `, last at ${time(status.latest.endedAt)}` : ''}
                </span>
                {status.latest.live && <span className="live-text"> · ● Live</span>}
                {status.latest.pageUrl && (
                  <a href={status.latest.pageUrl} className="button">
                    ▶ {status.latest.live ? 'Watch live' : 'Review'}
                  </a>
                )}
              </div>
            )}
            {status.log.length > 0 && (
              <details open={status.running}>
                <summary>Capture log</summary>
                <pre className="log">{status.log.join('\n')}</pre>
              </details>
            )}
          </section>
        );
      })}
    </section>
  );
}
