import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { hubCall } from '../data/hub.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { startSyncing } from '../data/sync.ts';
import { duration } from '../format.ts';

// Agents (the recorders, on machines with the video) and the work the hub has queued for them: clips to cut,
// recordings to encode. Each agent reports every few seconds; one not heard from for 90 seconds is offline.
interface Capabilities { machine: string; system: string; arch: string; cpus: number; cpuModel: string; memoryGb: number; node: string; ffmpeg: string | null; whisper: 'ready' | 'no model' | null; sources: string[] }
interface AgentStatus { state: string; agentId?: string; name: string; version: string; freeGb: number | null; job: { id: string; title: string; progress: number; message: string } | null; recordings: { title: string }[]; capabilities?: Capabilities | null }
// Agents added here (with an install command), as the hub keeps them.
interface Enrolled { id: string; name: string; createdAt: string; enrolledAt: string | null; revoked: boolean; joined: boolean }
interface Install { agent: { id: string; name: string }; command: string; expiresAt: string }
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
  const admin = can('manage.users', account);
  const [enrolled, setEnrolled] = useState<Enrolled[]>([]);
  const [packageReady, setPackageReady] = useState(true);
  const [install, setInstall] = useState<Install | null>(null);
  const [form, setForm] = useState({ id: '', name: '' });
  const [problem, setProblem] = useState('');
  const loadEnrolled = () => hubCall<{ agents: Enrolled[]; packageReady: boolean }>('agents').then((value) => { setEnrolled(value.agents); setPackageReady(value.packageReady); }).catch(() => {});
  useEffect(() => { if (admin) loadEnrolled(); }, [admin]);
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
  const agentAction = async (route: string, body: Record<string, string>) => {
    setProblem('');
    try {
      const reply = await hubCall<Install & { ok?: boolean }>(route, body);
      setInstall(reply.command ? reply : null);
      if (route === 'agents/create') setForm({ id: '', name: '' });
      loadEnrolled();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };
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
      <p className="muted">Agents are the recorders: machines that record meetings and do the heavy work (cutting clips, encoding), uploading the results to the hub. Add one below to get its install command; one already set up by hand runs with <code>npm run recorder</code>.</p>
      {admin && (
        <section className="panel add-agent">
          <h2>Add an agent</h2>
          <p className="muted small">For a Raspberry Pi (64-bit Raspberry Pi OS) or another Debian or Ubuntu machine. The command installs what the agent needs, joins this hub, and sets it up as a service that restarts if it stops and starts with the machine. Run it there as the user the agent should run as.</p>
          <form className="toolbar" onSubmit={(event) => { event.preventDefault(); agentAction('agents/create', form); }}>
            <label>Short id <input value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="pi1" size={10} required /></label>
            <label>Name <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Kitchen Raspberry Pi" /></label>
            <button type="submit" className="button primary">Make install command</button>
          </form>
          {!packageReady && <p className="error small">The agent package isn't on the hub yet: deploy again (bin/deploy-hub.sh makes it).</p>}
          {problem && <p className="error">{problem}</p>}
          {install && (
            <div className="install">
              <p>On <strong>{install.agent.name}</strong> (ssh into it), run:</p>
              <pre className="command">{install.command}</pre>
              <p className="toolbar small">
                <button type="button" className="button" onClick={() => navigator.clipboard?.writeText(install.command)}>Copy</button>
                <span className="muted">Works once, until {new Date(install.expiresAt).toLocaleString()}. Then it shows here as online.</span>
              </p>
            </div>
          )}
          {enrolled.length > 0 && (
            <table className="people">
              <thead><tr><th>Agent</th><th>Joined</th><th /></tr></thead>
              <tbody>{enrolled.map((agent) => (
                <tr key={agent.id} className={agent.revoked ? 'muted' : ''}>
                  <td><strong>{agent.name}</strong> <code>{agent.id}</code></td>
                  <td>{agent.revoked ? 'Revoked' : agent.joined ? `Yes, ${new Date(agent.enrolledAt || '').toLocaleDateString()}` : 'Not yet'}</td>
                  <td className="card-actions">
                    <button type="button" className="link-button" onClick={() => agentAction('agents/token', { id: agent.id })}>{agent.joined ? 'Reinstall command' : 'New install command'}</button>
                    {!agent.revoked && <button type="button" className="link-button" onClick={() => { if (confirm(`Revoke ${agent.name}? Its key stops working at once.`)) agentAction('agents/revoke', { id: agent.id }); }}>Revoke</button>}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </section>
      )}
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
              {status?.capabilities && <Capability value={status.capabilities} />}
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

// What an agent's machine has, and so what it can do.
function Capability({ value }: { value: Capabilities }) {
  return (
    <ul className="capabilities small">
      <li>{[value.machine, value.system].filter(Boolean).join(' · ')}</li>
      <li>{value.cpus} × {value.cpuModel || value.arch} · {value.memoryGb} GB memory · Node {value.node}</li>
      <li className={value.ffmpeg ? '' : 'error'}>{value.ffmpeg ? `ffmpeg ${value.ffmpeg}: can record and encode` : 'No ffmpeg: can\'t record or encode'}</li>
      <li className="muted">{value.whisper === 'ready' ? 'whisper.cpp: can transcribe' : value.whisper === 'no model' ? 'whisper.cpp without its model' : 'No whisper.cpp: doesn\'t transcribe'}</li>
      <li className="muted">{value.sources.length ? `Records: ${value.sources.join(', ')}` : 'No sources set up to record yet'}</li>
    </ul>
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
