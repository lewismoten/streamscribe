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
import MaintenancePanel, { MAINTENANCE } from '../agents/MaintenancePanel.tsx';
import UpdateAll from '../agents/UpdateAll.tsx';
import WorkQueue from '../agents/WorkQueue.tsx';
import type { Agent, AgentSettingsData, Job } from '../agents/types.ts';

export type { Job } from '../agents/types.ts';

// Agents (the recorders, on machines with the video) and the work the hub has queued for them: clips to cut,
// recordings to encode. Each agent reports every few seconds; the live report is checked every 5 seconds here.
export default function AgentsPage() {
  const account = useAccount();
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState('');
  const { records: jobs } = useRecords<Job>('jobs');
  const { records: agentSettings } = useRecords<AgentSettingsData>('agent_settings');
  // Updates and installs in their own lists (the default), or mixed in with the other work; remembered here.
  const [mixed, setMixed] = useState(() => {
    try {
      return localStorage.getItem('agents.maintenanceMixed') === '1';
    } catch {
      return false;
    }
  });
  const chooseMixed = (value: boolean) => {
    setMixed(value);
    try {
      localStorage.setItem('agents.maintenanceMixed', value ? '1' : '0');
    } catch {
      /* not kept */
    }
  };
  const maintenance = (jobs || []).filter((record) => MAINTENANCE.includes(record.data.type));
  const work = mixed ? jobs : (jobs || []).filter((record) => !MAINTENANCE.includes(record.data.type));
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
        {can('edit.sources', account) && <UpdateAll agents={agents} />}
      </div>
      <p className="muted">
        Agents are the recorders: machines that record meetings and do the heavy work (cutting clips, encoding),
        uploading the results to the hub. Add one below to get its install command; one already set up by hand runs with{' '}
        <code>npm run recorder</code>.
      </p>
      {admin && <AddAgent />}
      <AgentCards
        agents={agents}
        admin={admin}
        onForget={(id) => setAgents((list) => (list || []).filter((agent) => agent.recorderId !== id))}
      />
      <ReachGrid agents={agents} canEdit={can('edit.sources', account)} />
      <MaintenancePanel agents={agents} jobs={jobs} settings={agentSettings} />
      <label className="small">
        <input type="checkbox" checked={mixed} onChange={(event) => chooseMixed(event.target.checked)} /> Show updates
        and installs with the other work
      </label>
      {!mixed && maintenance.length > 0 && (
        <WorkQueue jobs={maintenance} manage={can('publish', account)} label="Maintenance: " />
      )}
      <WorkQueue jobs={work} manage={can('publish', account)} />
      <SiteTurns
        names={Object.fromEntries((agents || []).map((agent) => [agent.recorderId, agent.status?.name || agent.name]))}
      />
    </section>
  );
}
