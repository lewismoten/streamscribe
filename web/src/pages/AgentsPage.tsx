import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { hubCall } from '../data/hub.ts';
import { useRecords } from '../data/useRecords.ts';
import { startSyncing } from '../data/sync.ts';
import AddAgent from '../agents/AddAgent.tsx';
import AgentCards from '../agents/AgentCards.tsx';
import ReachGrid from '../agents/ReachGrid.tsx';
import SiteTurns from '../agents/SiteTurns.tsx';
import WorkQueue from '../agents/WorkQueue.tsx';
import type { Agent, Job } from '../agents/types.ts';

export type { Job } from '../agents/types.ts';

// Agents (the recorders, on machines with the video) and the work the hub has queued for them: clips to cut,
// recordings to encode. Each agent reports every few seconds; the live report is checked every 5 seconds here.
export default function AgentsPage() {
  const account = useAccount();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState('');
  const { records: jobs } = useRecords<Job>('jobs');
  const allowed = can('view.meetings', account);
  const admin = can('manage.users', account);
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
  if (!account.user)
    return (
      <p className="empty">
        <Link to="/account">Sign in</Link> to see the agents and their work.
      </p>
    );
  if (!allowed) return <p className="empty">Your group can't see meetings, or the work done on them.</p>;

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Agents</h1>
        {error && <span className="error">{error}</span>}
      </div>
      <p className="muted">
        Agents are the recorders: machines that record meetings and do the heavy work (cutting clips, encoding),
        uploading the results to the hub. Add one below to get its install command; one already set up by hand runs with{' '}
        <code>npm run recorder</code>.
      </p>
      {admin && <AddAgent />}
      <AgentCards agents={agents} canEdit={can('edit.sources', account)} />
      <ReachGrid agents={agents} canEdit={can('edit.sources', account)} />
      <WorkQueue jobs={jobs} manage={can('publish', account)} />
      <SiteTurns
        names={Object.fromEntries((agents || []).map((agent) => [agent.recorderId, agent.status?.name || agent.name]))}
      />
    </section>
  );
}
