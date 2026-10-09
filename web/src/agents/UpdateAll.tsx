import { putRecord, useRecords } from '../data/useRecords.ts';
import type { Agent, AgentSettingsData } from './types.ts';

// Asking every agent that's behind the hub's agent package to update itself (each does when idle, then restarts on the
// new code: src/recorder/updater.js). The request goes through the hub; each picks it up when it next syncs.
export default function UpdateAll({ agents }: { agents: Agent[] | null }) {
  const { records } = useRecords<AgentSettingsData>('agent_settings');
  const behind = (agents || []).filter((agent) => agent.status?.update?.behind && agent.status.update.canUpdate);
  if (!behind.length) return null;
  const updateAll = () =>
    Promise.all(
      behind.map((agent) =>
        putRecord('agent_settings', agent.recorderId, {
          ...records?.find((record) => record.id === agent.recorderId)?.data,
          updateAt: new Date().toISOString()
        })
      )
    );
  return (
    <button type="button" className="button" onClick={updateAll}>
      Update {behind.length === 1 ? 'the agent' : `all ${behind.length} agents`} that{' '}
      {behind.length === 1 ? 'is' : 'are'} behind
    </button>
  );
}
