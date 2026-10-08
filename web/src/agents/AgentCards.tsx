import { useNow } from '../useNow.ts';
import { ago, type Agent, type Capabilities } from './types.ts';
import { Progress } from './WorkQueue.tsx';

// A card for each agent that has reported to the hub: online or not (one not heard from for 90 seconds is offline),
// what it's doing, and what its machine can do.
export default function AgentCards({ agents }: { agents: Agent[] | null }) {
  const now = useNow(10000);
  return (
    <div className="agents">
      {agents === null ? (
        <p className="muted">Loading…</p>
      ) : agents.length === 0 ? (
        <p className="empty">No agent has reported to this hub yet.</p>
      ) : (
        agents.map((agent) => {
          const online = now - Date.parse(agent.updatedAt) < 90000;
          const status = agent.status;
          return (
            <div key={agent.recorderId} className={`panel agent ${online ? 'online' : 'offline'}`}>
              <div className="panel-head">
                <h2>
                  <span className="dot" aria-hidden="true" />
                  {status?.name || agent.name}
                </h2>
                <code>{agent.recorderId}</code>
              </div>
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
              </p>
              {online && status?.job && (
                <Progress value={status.job.progress} label={`${status.job.title}: ${status.job.message}`} />
              )}
              {status?.capabilities && <Capability value={status.capabilities} />}
            </div>
          );
        })
      )}
    </div>
  );
}

// What an agent's machine has, and so what it can do.
function Capability({ value }: { value: Capabilities }) {
  return (
    <ul className="capabilities small">
      <li>{[value.machine, value.system].filter(Boolean).join(' · ')}</li>
      <li>
        {value.cpus} × {value.cpuModel || value.arch} · {value.memoryGb} GB memory · Node {value.node}
      </li>
      <li className={value.ffmpeg ? '' : 'error'}>
        {value.ffmpeg ? `ffmpeg ${value.ffmpeg}: can record and encode` : "No ffmpeg: can't record or encode"}
      </li>
      <li className="muted">
        {value.whisper === 'ready'
          ? 'whisper.cpp: can transcribe'
          : value.whisper === 'no model'
            ? 'whisper.cpp without its model'
            : "No whisper.cpp: doesn't transcribe"}
      </li>
      <li className="muted">
        {value.sources.length ? `Records: ${value.sources.join(', ')}` : 'No sources set up to record yet'}
      </li>
    </ul>
  );
}
