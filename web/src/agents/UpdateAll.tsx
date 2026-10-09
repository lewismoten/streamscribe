import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import { requestUpdate } from './agentRequests.ts';
import { isBehind, useAgentBuild } from './useAgentBuild.ts';
import type { Agent, AgentSettingsData } from './types.ts';

// Asking every agent that's behind the hub's agent package to update itself: an update job for each in the work queue
// (each does it when idle, then restarts on the new code: src/recorder/updater.js), or through the settings of one too
// old for those jobs.
export default function UpdateAll({ agents }: { agents: Agent[] | null }) {
  const account = useAccount();
  const { records } = useRecords<AgentSettingsData>('agent_settings');
  const build = useAgentBuild();
  const behind = (agents || []).filter((agent) => isBehind(agent, build));
  if (!behind.length) return null;
  const by = account.user?.displayName || account.user?.username || '';
  const updateAll = () =>
    Promise.all(
      behind.map((agent) =>
        requestUpdate(agent, records?.find((record) => record.id === agent.recorderId)?.data || {}, by, build?.commit)
      )
    );
  return (
    <button type="button" className="button" onClick={updateAll}>
      Update {behind.length === 1 ? 'the agent' : `all ${behind.length} agents`} that{' '}
      {behind.length === 1 ? 'is' : 'are'} behind
    </button>
  );
}
