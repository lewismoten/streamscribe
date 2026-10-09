import { Link } from 'react-router';
import { hubCall } from '../data/hub.ts';
import { useNow } from '../useNow.ts';
import { ago, type Agent, type Capabilities, type UpdateStatus } from './types.ts';
import { Progress } from './WorkQueue.tsx';
import { isBehind, useAgentBuild } from './useAgentBuild.ts';

// A card for each agent that has reported to the hub, kept short: online or not (one not heard from for 90 seconds is
// offline), what it's doing, its machine in a line or two, and a link to its own page (AgentPage) with everything else
// and its settings. An admin can remove an offline one from the list.
export const ONLINE_MS = 90000;

// Online and what it's doing (or when it was last heard from), its free space, version, and whether it's behind.
export function StatusLine({
  agent,
  now,
  behind,
  latest
}: {
  agent: Agent;
  now: number;
  behind: boolean;
  latest?: string | null;
}) {
  const status = agent.status;
  const online = now - Date.parse(agent.updatedAt) < ONLINE_MS;
  return (
    <p className="muted">
      {online
        ? status?.state === 'recording'
          ? `● Recording ${status.recordings[0]?.title || ''}`
          : status?.state === 'working'
            ? 'Working'
            : 'Online, idle'
        : `Offline · last heard from ${ago(agent.updatedAt, now)}`}
      {status?.freeGb !== null && status?.freeGb !== undefined ? ` · ${status.freeGb} GB free` : ''}
      {status?.version ? ` · v${status.version}` : ''}
      {updateNote(status?.update, behind, latest)}
    </p>
  );
}

// Its machine in brief: processors and memory, accelerators, and what it can do.
function Brief({ value }: { value: Capabilities }) {
  const can = [
    value.ffmpeg ? 'records and encodes' : "can't record",
    value.whisper === 'ready' ? 'transcribes' : null,
    (value.accelerators || []).map((item) => item.name).join(', ') || null
  ].filter(Boolean);
  return (
    <p className="small">
      {value.cpus} × {value.cpuModel || value.arch} · {value.memoryGb} GB · {can.join(' · ')}
    </p>
  );
}

export default function AgentCards({
  agents,
  admin = false,
  onForget = () => {}
}: {
  agents: Agent[] | null;
  admin?: boolean;
  onForget?: (agentId: string) => void;
}) {
  const now = useNow(10000);
  const build = useAgentBuild();
  return (
    <div className="agents">
      {agents === null ? (
        <p className="muted">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="empty">No agent has reported to this hub yet.</p>
      ) : (
        agents.map((agent) => {
          const online = now - Date.parse(agent.updatedAt) < ONLINE_MS;
          const status = agent.status;
          return (
            <div key={agent.recorderId} className={`panel agent ${online ? 'online' : 'offline'}`}>
              <div className="panel-head">
                <h2>
                  <span className="dot" aria-hidden="true" />
                  <Link to={`/agents/${encodeURIComponent(agent.recorderId)}`}>{status?.name || agent.name}</Link>
                </h2>
                <code>{agent.recorderId}</code>
              </div>
              <Machine status={status} />
              <StatusLine agent={agent} now={now} behind={isBehind(agent, build)} latest={build?.commit} />
              {online && status?.job && (
                <Progress value={status.job.progress} label={`${status.job.title}: ${status.job.message}`} />
              )}
              {status?.capabilities && <Brief value={status.capabilities} />}
              <p className="small card-actions">
                <Link to={`/agents/${encodeURIComponent(agent.recorderId)}`}>Details and settings →</Link>
                {admin && !online && (
                  <button
                    type="button"
                    className="link-button danger"
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Remove ${status?.name || agent.name} from this list? If it reports again, it comes back. (Its key still works: revoke it on the Agents page or in Hub settings → Keys.)`
                        )
                      )
                        return;
                      await hubCall('live/forget', { recorderId: agent.recorderId });
                      onForget(agent.recorderId);
                    }}
                  >
                    Remove from this list
                  </button>
                )}
              </p>
            </div>
          );
        })
      )}
    </div>
  );
}

// Its build against the hub's: behind (and updating, or waiting to), or why an update failed.
function updateNote(update: UpdateStatus | null | undefined, behind: boolean, latest?: string | null) {
  if (!update) return '';
  if (update.state === 'waiting' || update.state === 'updating' || update.state === 'restarting')
    return ` · ${update.step || 'updating'}`;
  if (update.state === 'failed') return ` · update failed: ${update.error}`;
  if (behind) return ` · update available (${latest || update.latest})`;
  if (update.behind && !update.canUpdate) return ` · behind the hub (${update.latest})`;
  return '';
}

// The machine it runs on: its host name (as of its last report), and its Tailscale name when that differs.
export function Machine({ status }: { status: Agent['status'] }) {
  const host = status?.hostname || status?.capabilities?.hostname;
  const tailnet = String(status?.settings?.tailscale?.name || '').split('.')[0];
  if (!host && !tailnet) return null;
  return (
    <p className="muted small">
      On <code>{host || tailnet}</code>
      {host && tailnet && tailnet.toLowerCase() !== host.toLowerCase().replace(/\.local$/, '') && (
        <>
          {' '}
          (Tailscale <code>{tailnet}</code>)
        </>
      )}
    </p>
  );
}

// The other agents with the same files: on the same machine, with the same data folder.
export function sharedWith(agents: Agent[], agent: Agent) {
  const mine = agent.status?.capabilities;
  if (!mine?.dataDir) return [];
  return agents
    .filter((other) => other.recorderId !== agent.recorderId)
    .filter(
      (other) =>
        other.status?.capabilities?.dataDir === mine.dataDir && other.status?.capabilities?.hostname === mine.hostname
    )
    .map((other) => other.status?.name || other.name || other.recorderId);
}

// What an agent's machine has, and so what it can do.
export function Capability({ value, sharing }: { value: Capabilities; sharing: string[] }) {
  return (
    <ul className="capabilities small">
      <li>{[value.machine, value.system].filter(Boolean).join(' · ')}</li>
      <li>
        {value.cpus} × {value.cpuModel || value.arch} · {value.memoryGb} GB memory · Node {value.node}
      </li>
      {(value.accelerators || []).length > 0 && (
        <li>
          {value
            .accelerators!.map((item) => `${item.name}${item.memoryGb ? ` (${item.memoryGb} GB)` : ''}`)
            .join(' · ')}
        </li>
      )}
      <li className={value.ffmpeg ? '' : 'error'}>
        {value.ffmpeg ? `ffmpeg ${value.ffmpeg}: can record and encode` : "No ffmpeg: can't record or encode"}
      </li>
      <li className="muted">
        {value.whisper === 'ready'
          ? `whisper.cpp: can transcribe${value.whisperModel ? ` (${value.whisperModel})` : ''}`
          : value.whisper === 'no model'
            ? 'whisper.cpp without its model'
            : "No whisper.cpp: doesn't transcribe"}
      </li>
      <li className="muted">
        {value.sources.length ? `Records: ${value.sources.join(', ')}` : 'No sources set up to record yet'}
      </li>
      {value.dataDir && (
        <li className="muted">
          Files: <code>{value.dataDir}</code>
          {value.recordings !== undefined ? ` · ${value.recordings} recordings` : ''}
          {sharing.length ? ` · the same files as ${sharing.join(', ')}` : ''}
        </li>
      )}
    </ul>
  );
}
