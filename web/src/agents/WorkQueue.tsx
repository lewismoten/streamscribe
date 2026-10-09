import { Link } from 'react-router';
import { putRecord, type HubRecord } from '../data/useRecords.ts';
import { duration } from '../format.ts';
import { useNow } from '../useNow.ts';
import { ago, type Job } from './types.ts';

// The work the hub has queued for the agents (clips to cut, recordings to encode): what's in progress, waiting, and
// recently finished. Those who may publish can cancel waiting or running work and retry what failed.
const STATUS = { queued: 'Waiting', working: 'Working', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

// Changes a job (cancelled, or queued again), marking when.
const change = (id: string, job: Job, patch: Partial<Job>) =>
  putRecord('jobs', id, { ...job, ...patch, updatedAt: new Date().toISOString() });

export default function WorkQueue({
  jobs,
  manage,
  label = ''
}: {
  jobs: HubRecord<Job>[] | null | undefined;
  manage: boolean;
  // Before each list's heading (such as "Maintenance: ").
  label?: string;
}) {
  const now = useNow(10000);
  const sorted = [...(jobs || [])].sort((a, b) => String(b.data.createdAt).localeCompare(String(a.data.createdAt)));
  const groups: [string, typeof sorted][] = [
    ['In progress', sorted.filter((job) => job.data.status === 'working')],
    ['Waiting', sorted.filter((job) => job.data.status === 'queued').reverse()],
    ['Finished', sorted.filter((job) => !['working', 'queued'].includes(job.data.status)).slice(0, 30)]
  ];
  return (
    <>
      {groups.map(([title, list]) => (
        <section key={title} className="panel">
          <h2>
            {label}
            {title} {list.length > 0 && <span className="muted">({list.length})</span>}
          </h2>
          {list.length === 0 ? (
            <p className="muted">None.</p>
          ) : (
            <table className="people jobs">
              <thead>
                <tr>
                  <th>Work</th>
                  <th>Agent</th>
                  <th>Status</th>
                  <th>When</th>
                  {manage && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {list.map(({ id, data: job }) => (
                  <tr key={id}>
                    <td>
                      {job.title}
                      {job.publicationId && (
                        <>
                          {' '}
                          · <Link to={`/published/${job.publicationId}`}>publication</Link>
                        </>
                      )}
                      {job.recordingId && (
                        <>
                          {' '}
                          · <Link to={`/meetings/${job.recordingId}`}>meeting</Link>
                        </>
                      )}
                    </td>
                    <td>{job.agentName || job.agent || (job.forAgent ? `for ${job.forAgent}` : 'any')}</td>
                    <td>
                      {job.status === 'working' ? (
                        <Progress value={job.progress} label={job.message} />
                      ) : (
                        <>
                          {STATUS[job.status]}
                          {job.error ? <span className="error">: {job.error}</span> : ''}
                        </>
                      )}
                    </td>
                    <td>
                      {job.status === 'working'
                        ? `started ${ago(job.startedAt, now)}`
                        : job.finishedAt
                          ? `${ago(job.finishedAt, now)}${job.startedAt ? ` (${duration((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000)})` : ''}`
                          : `queued ${ago(job.createdAt, now)}`}
                    </td>
                    {manage && (
                      <td className="card-actions">
                        {['queued', 'working'].includes(job.status) && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() =>
                              change(id, job, {
                                status: 'cancelled',
                                message: 'Cancelled',
                                finishedAt: new Date().toISOString()
                              })
                            }
                          >
                            Cancel
                          </button>
                        )}
                        {['failed', 'cancelled'].includes(job.status) && (
                          <button
                            type="button"
                            className="link-button"
                            onClick={() =>
                              change(id, job, {
                                status: 'queued',
                                agent: null,
                                progress: 0,
                                message: '',
                                error: null,
                                finishedAt: undefined,
                                createdAt: new Date().toISOString()
                              })
                            }
                          >
                            Retry
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </>
  );
}

// How far along a piece of work is, as a bar with its percentage and message.
export function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress" title={label}>
      <div className="progress-bar">
        <span style={{ width: `${Math.round((value || 0) * 100)}%` }} />
      </div>
      <span className="muted small">
        {Math.round((value || 0) * 100)}% {label}
      </span>
    </div>
  );
}
