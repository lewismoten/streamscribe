import { Link } from 'react-router';
import type { HubRecord } from '../data/useRecords.ts';
import { useNow } from '../useNow.ts';
import { ago, type Agent, type AgentSettingsData, type Job } from './types.ts';
import { Progress } from './WorkQueue.tsx';
import { useAgentBuild, type AgentBuild } from './useAgentBuild.ts';

// The big picture of keeping the agents up to date: for each, its build against the hub's agent package and where its
// update stands (queued, under way, restarting, failed, or up to date), its whisper.cpp (installing, or which model),
// and whether it updates itself. From the agents' live reports, their update and install jobs, and their settings.
export const MAINTENANCE = ['update', 'install'];
const RECENT_MS = 24 * 3600000;

type Build = AgentBuild;

// Its newest job of a type: under way, waiting, or finished in the last day.
function latestJob(jobs: HubRecord<Job>[], agentId: string, type: string, now: number) {
  return jobs
    .filter((record) => record.data.type === type && record.data.forAgent === agentId)
    .filter(
      (record) =>
        ['queued', 'working'].includes(record.data.status) ||
        now - Date.parse(record.data.finishedAt || record.data.createdAt) < RECENT_MS
    )
    .sort((a, b) => String(b.data.createdAt).localeCompare(String(a.data.createdAt)))[0]?.data;
}

function JobState({ job, now }: { job: Job; now: number }) {
  if (job.status === 'working') return <Progress value={job.progress} label={job.message} />;
  if (job.status === 'queued') return <span>Queued {ago(job.createdAt, now)} (when it&apos;s idle)</span>;
  if (job.status === 'failed') return <span className="error">Failed: {job.error}</span>;
  if (job.status === 'cancelled') return <span className="muted">Cancelled</span>;
  return null;
}

function UpdateCell({
  agent,
  job,
  build,
  saved,
  now
}: {
  agent: Agent;
  job?: Job;
  build: Build | null;
  saved?: AgentSettingsData;
  now: number;
}) {
  const update = agent.status?.update;
  if (job && job.status !== 'done') return <JobState job={job} now={now} />;
  // Asked through its settings (an agent too old for update jobs), and it hasn't checked since.
  const behind = Boolean(update?.behind || (build?.commit && update?.current !== build.commit));
  if (behind && saved?.updateAt && (!update?.checkedAt || saved.updateAt > update.checkedAt))
    return <span>Requested {ago(saved.updateAt, now)} (it picks it up within a minute)</span>;
  if (update?.state === 'waiting' || update?.state === 'updating' || update?.state === 'restarting')
    return <span>{update.step}</span>;
  if (update?.state === 'failed') return <span className="error">Failed: {update.error}</span>;
  if (!update) return <span className="muted">Not reported (an older agent: reinstall it once)</span>;
  if (!update.canUpdate) return <span className="muted">Runs from git</span>;
  if (behind) return <span className="error">Behind (the hub has {build?.commit || update.latest})</span>;
  return <span>Up to date{job?.status === 'done' ? `, updated ${ago(job.finishedAt, now)}` : ''}</span>;
}

function WhisperCell({ agent, job, saved, now }: { agent: Agent; job?: Job; saved?: AgentSettingsData; now: number }) {
  const tools = agent.status?.settings?.tools?.whisper;
  const capabilities = agent.status?.capabilities;
  if (job && ['queued', 'working'].includes(job.status)) return <JobState job={job} now={now} />;
  // Asked through its settings, and not taken up yet.
  const asked = saved?.tools?.whisper?.at;
  if (asked && tools?.state !== 'installing' && tools?.requestedAt !== asked && tools?.at !== asked)
    return <span>Requested {ago(asked, now)} (it picks it up within a minute)</span>;
  if (tools?.state === 'installing') return <Progress value={tools.share || 0} label={tools.step || ''} />;
  if (job?.status === 'failed') return <JobState job={job} now={now} />;
  if (capabilities?.whisper === 'ready') return <span>{capabilities.whisperModel || 'Ready'}</span>;
  if (capabilities?.whisper === 'no model') return <span className="error">No model</span>;
  return <span className="muted">Not installed</span>;
}

export default function MaintenancePanel({
  agents,
  jobs,
  settings
}: {
  agents: Agent[] | null;
  jobs: HubRecord<Job>[] | null | undefined;
  settings: HubRecord<AgentSettingsData>[] | null | undefined;
}) {
  const now = useNow(10000);
  const build = useAgentBuild();
  if (!agents?.length) return null;
  const all = jobs || [];
  return (
    <section className="panel">
      <h2>Maintenance</h2>
      <p className="muted small">
        {build?.commit
          ? `The hub's agent package is build ${build.commit}${build.builtAt ? `, made ${ago(build.builtAt, now)}` : ''}.`
          : 'The hub has no agent package yet (a deploy makes it).'}{' '}
        Agents take their update and install jobs before other work, once idle.
      </p>
      <div className="table-scroll">
        <table className="people jobs">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Version</th>
              <th>Update</th>
              <th>whisper.cpp</th>
              <th>Updates itself</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => {
              const online = now - Date.parse(agent.updatedAt) < 90000;
              const saved = settings?.find((record) => record.id === agent.recorderId)?.data;
              return (
                <tr key={agent.recorderId} className={online ? '' : 'muted'}>
                  <td>
                    <Link to={`/agents/${encodeURIComponent(agent.recorderId)}`}>
                      {agent.status?.name || agent.name}
                    </Link>
                    {!online && ` (offline ${ago(agent.updatedAt, now)})`}
                  </td>
                  <td>
                    <code>{agent.status?.version || '?'}</code>
                  </td>
                  <td>
                    <UpdateCell
                      agent={agent}
                      job={latestJob(all, agent.recorderId, 'update', now)}
                      build={build}
                      saved={saved}
                      now={now}
                    />
                  </td>
                  <td>
                    <WhisperCell
                      agent={agent}
                      job={latestJob(all, agent.recorderId, 'install', now)}
                      saved={saved}
                      now={now}
                    />
                  </td>
                  <td>{saved?.autoUpdate ? 'Yes' : 'No'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
