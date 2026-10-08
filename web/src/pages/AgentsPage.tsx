import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { hubCall } from '../data/hub.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { startSyncing } from '../data/sync.ts';
import { duration } from '../format.ts';

// Agents (the recorders, on machines with the video) and the work the hub has queued for them: clips to cut,
// recordings to encode. Each agent reports every few seconds; one not heard from for 90 seconds is offline.
interface AgentStatus { state: string; agentId?: string; name: string; version: string; freeGb: number | null; job: { id: string; title: string; progress: number; message: string } | null; recordings: { title: string }[] }
interface Agent { recorderId: string; name: string; updatedAt: string; status: AgentStatus | null }
export interface Job {
  type: 'clip' | 'encode'; status: 'queued' | 'working' | 'done' | 'failed' | 'cancelled'; title: string; recordingId: string; publicationId?: string;
  agent: string | null; agentName?: string; forAgent?: string; progress: number; message: string; error?: string | null;
  createdAt: string; createdBy: string; startedAt?: string; finishedAt?: string; updatedAt?: string;
}

const ago = (iso: string | undefined) => {
  if (!iso) return '';
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return seconds < 90 ? `${seconds}s ago` : seconds < 5400 ? `${Math.round(seconds / 60)} min ago` : seconds < 172800 ? `${Math.round(seconds / 3600)} h ago` : new Date(iso).toLocaleDateString();
};
const STATUS = { queued: 'Waiting', working: 'Working', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

export default function AgentsPage() {
  const account = useAccount();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState('');
  const { records: jobs } = useRecords<Job>('jobs');
  const allowed = can('view.meetings', account);
  useEffect(() => {
    if (!allowed) return;
    startSyncing(5);
    const load = () => hubCall<{ recorders: Agent[] }>('live').then((value) => { setAgents(value.recorders); setError(''); }).catch((reason: Error) => setError(reason.message));
    load();
    const timer = setInterval(load, 5000);
    return () => { clearInterval(timer); startSyncing(30); };
  }, [allowed]);
  if (!account.user) return <p className="empty"><Link to="/account">Sign in</Link> to see the agents and their work.</p>;
  if (!allowed) return <p className="empty">Your group can't see meetings, or the work done on them.</p>;

  const manage = can('publish', account);
  const change = (id: string, job: Job, patch: Partial<Job>) => putRecord('jobs', id, { ...job, ...patch, updatedAt: new Date().toISOString() });
  const sorted = [...(jobs || [])].sort((a, b) => String(b.data.createdAt).localeCompare(String(a.data.createdAt)));
  const groups: [string, typeof sorted][] = [
    ['In progress', sorted.filter((job) => job.data.status === 'working')],
    ['Waiting', sorted.filter((job) => job.data.status === 'queued').reverse()],
    ['Finished', sorted.filter((job) => !['working', 'queued'].includes(job.data.status)).slice(0, 30)]
  ];
  return (
    <section>
      <div className="toolbar"><h1 className="grow">Agents</h1>{error && <span className="error">{error}</span>}</div>
      <p className="muted">Agents are the recorders: they record meetings and do the heavy work (cutting clips, encoding), uploading the results to the hub. Start one with <code>npm run recorder</code>; give each a short <code>recorder.id</code> and a <code>recorder.name</code> in its config.local.js.</p>
      <div className="agents">
        {agents === null ? <p className="muted">Loading…</p> : agents.length === 0 ? <p className="empty">No agent has reported to this hub yet.</p> : agents.map((agent) => {
          const online = Date.now() - Date.parse(agent.updatedAt) < 90000;
          const status = agent.status;
          return (
            <div key={agent.recorderId} className={`panel agent ${online ? 'online' : 'offline'}`}>
              <div className="panel-head">
                <h2><span className="dot" aria-hidden="true" />{status?.name || agent.name}</h2>
                <code>{agent.recorderId}</code>
              </div>
              <p className="muted">{online ? (status?.state === 'recording' ? `● Recording ${status.recordings[0]?.title || ''}` : status?.state === 'working' ? 'Working' : 'Online, idle') : `Offline · last heard from ${ago(agent.updatedAt)}`}
                {status?.freeGb !== null && status?.freeGb !== undefined ? ` · ${status.freeGb} GB free` : ''}{status?.version ? ` · v${status.version}` : ''}</p>
              {online && status?.job && <Progress value={status.job.progress} label={`${status.job.title}: ${status.job.message}`} />}
            </div>
          );
        })}
      </div>
      {groups.map(([title, list]) => (
        <section key={title} className="panel">
          <h2>{title} {list.length > 0 && <span className="muted">({list.length})</span>}</h2>
          {list.length === 0 ? <p className="muted">None.</p> : (
            <table className="people jobs">
              <thead><tr><th>Work</th><th>Agent</th><th>Status</th><th>When</th>{manage && <th />}</tr></thead>
              <tbody>{list.map(({ id, data: job }) => (
                <tr key={id}>
                  <td>{job.title}{job.publicationId && <> · <Link to={`/published/${job.publicationId}`}>publication</Link></>}{job.recordingId && <> · <Link to={`/meetings/${job.recordingId}`}>meeting</Link></>}</td>
                  <td>{job.agentName || job.agent || (job.forAgent ? `for ${job.forAgent}` : 'any')}</td>
                  <td>{job.status === 'working' ? <Progress value={job.progress} label={job.message} /> : <>{STATUS[job.status]}{job.error ? <span className="error">: {job.error}</span> : ''}</>}</td>
                  <td>{job.status === 'working' ? `started ${ago(job.startedAt)}` : job.finishedAt ? `${ago(job.finishedAt)}${job.startedAt ? ` (${duration((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000)})` : ''}` : `queued ${ago(job.createdAt)}`}</td>
                  {manage && <td className="card-actions">
                    {['queued', 'working'].includes(job.status) && <button type="button" className="link-button" onClick={() => change(id, job, { status: 'cancelled', message: 'Cancelled', finishedAt: new Date().toISOString() })}>Cancel</button>}
                    {['failed', 'cancelled'].includes(job.status) && <button type="button" className="link-button" onClick={() => change(id, job, { status: 'queued', agent: null, progress: 0, message: '', error: null, finishedAt: undefined, createdAt: new Date().toISOString() })}>Retry</button>}
                  </td>}
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      ))}
    </section>
  );
}

function Progress({ value, label }: { value: number; label: string }) {
  return (
    <div className="progress" title={label}>
      <div className="progress-bar"><span style={{ width: `${Math.round((value || 0) * 100)}%` }} /></div>
      <span className="muted small">{Math.round((value || 0) * 100)}% {label}</span>
    </div>
  );
}
