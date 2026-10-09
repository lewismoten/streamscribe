import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { hubCall } from '../data/hub.ts';
import { useRecords } from '../data/useRecords.ts';
import { startSyncing } from '../data/sync.ts';
import { useNow } from '../useNow.ts';
import { Capability, Machine, ONLINE_MS, sharedWith, StatusLine } from '../agents/AgentCards.tsx';
import AgentSettings from '../agents/AgentSettings.tsx';
import WorkQueue, { Progress } from '../agents/WorkQueue.tsx';
import { isBehind, useAgentBuild } from '../agents/useAgentBuild.ts';
import type { Agent, Job } from '../agents/types.ts';

// One agent, all of it (/agents/<id>): its machine and what it can do, what it found of its storage, copies, language
// models, and network (and the agents it reaches), its tools, its settings, and its own work (waiting, under way, and
// finished). Its live report is checked every 5 seconds.
export default function AgentPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const now = useNow(5000);
  const build = useAgentBuild();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState('');
  const { records: jobs } = useRecords<Job>('jobs');
  const allowed = can('view.meetings', account);
  useEffect(() => {
    if (!allowed) return;
    startSyncing(5);
    const load = () =>
      hubCall<{ recorders: Agent[] }>('live')
        .then((value) => {
          setAgents(value.recorders);
          setError('');
        })
        .catch((reason: Error) => setError(reason.message));
    load();
    const timer = setInterval(load, 5000);
    return () => {
      clearInterval(timer);
      startSyncing(30);
    };
  }, [allowed]);
  if (!allowed) return <p className="empty">Your group can&apos;t see the agents.</p>;
  if (!agents) return <p className="muted">{error || 'Loading…'}</p>;
  const agent = agents.find((item) => item.recorderId === id);
  if (!agent)
    return (
      <p className="empty">
        No agent {id} has reported to this hub. <Link to="/agents">All agents</Link>
      </p>
    );
  const status = agent.status;
  const online = now - Date.parse(agent.updatedAt) < ONLINE_MS;
  const behind = isBehind(agent, build);
  const own = (jobs || []).filter((record) => record.data.forAgent === id || record.data.agent === id);

  return (
    <section className={`agent-page ${online ? 'online' : 'offline'}`}>
      <p className="small">
        <Link to="/agents">← All agents</Link>
      </p>
      <div className="toolbar agent">
        <h1 className="grow">
          <span className="dot" aria-hidden="true" />
          {status?.name || agent.name} <code>{agent.recorderId}</code>
        </h1>
        {error && <span className="error">{error}</span>}
      </div>
      <section className="panel">
        <Machine status={status} />
        <StatusLine agent={agent} now={now} behind={behind} latest={build?.commit} />
        {online && status?.job && (
          <Progress value={status.job.progress} label={`${status.job.title}: ${status.job.message}`} />
        )}
        {status?.capabilities && <Capability value={status.capabilities} sharing={sharedWith(agents, agent)} />}
      </section>
      <AgentSettings
        agentId={agent.recorderId}
        report={status?.settings}
        copies={status?.copies}
        update={status?.update}
        behind={behind}
        latest={build?.commit || status?.update?.latest || null}
        agent={agent}
        canEdit={can('edit.sources', account)}
      />
      <WorkQueue jobs={own} manage={can('publish', account)} label="Its work: " />
    </section>
  );
}
