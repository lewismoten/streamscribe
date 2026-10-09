import { putRecord } from '../data/useRecords.ts';
import { syncNow } from '../data/sync.ts';
import type { Agent, AgentSettingsData } from './types.ts';

// Asking an agent to update itself or install a tool: as a job for it in the work queue (so it shows under In
// progress, Waiting, and Finished, with its progress), or, for an agent too old to take those jobs, through its
// settings as before (it picks those up when it next syncs).
const now = () => new Date().toISOString();
const takes = (agent: Agent, type: string) => (agent.status?.jobTypes || []).includes(type);
const nameOf = (agent: Agent) => agent.status?.name || agent.name || agent.recorderId;

export async function requestUpdate(agent: Agent, saved: AgentSettingsData, by: string) {
  const to = agent.status?.update?.latest || 'the newest build';
  if (takes(agent, 'update'))
    await putRecord('jobs', `update-${agent.recorderId}-${Date.now()}`, {
      type: 'update',
      forAgent: agent.recorderId,
      status: 'queued',
      title: `Update ${nameOf(agent)} to ${to}`,
      progress: 0,
      message: '',
      agent: null,
      createdAt: now(),
      createdBy: by
    });
  else await putRecord('agent_settings', agent.recorderId, { ...saved, updateAt: now() });
  syncNow();
}

export async function requestInstall(agent: Agent, saved: AgentSettingsData, model: string, label: string, by: string) {
  if (takes(agent, 'install'))
    await putRecord('jobs', `install-${agent.recorderId}-${Date.now()}`, {
      type: 'install',
      forAgent: agent.recorderId,
      tool: 'whisper',
      model,
      status: 'queued',
      title: `Install whisper.cpp (${label}) on ${nameOf(agent)}`,
      progress: 0,
      message: '',
      agent: null,
      createdAt: now(),
      createdBy: by
    });
  else
    await putRecord('agent_settings', agent.recorderId, {
      ...saved,
      tools: { ...saved.tools, whisper: { model, at: now() } }
    });
  syncNow();
}
