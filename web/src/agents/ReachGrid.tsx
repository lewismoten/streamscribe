import { putRecord, useRecords } from '../data/useRecords.ts';
import { useNow } from '../useNow.ts';
import { ago, type Agent, type AgentSettingsData, type Peer } from './types.ts';

// Who reaches whom, from the agents' own reports: each agent pings the others over Tailscale each minute and reports
// what it found, so this works though the hub's server can't reach them. A row is the agent asking; a column, the
// one it reached. Check now asks every online agent (through the hub; each picks it up when it next syncs, within a
// minute) to check again and time its transfers.
const SHOWN = {
  local: { mark: '●', label: 'same network' },
  direct: { mark: '◐', label: 'elsewhere, connected directly' },
  relay: { mark: '○', label: "elsewhere, through Tailscale's relay" }
} as const;
const ONLINE_MS = 90000;

function Cell({ peer, now }: { peer?: Peer; now: number }) {
  if (!peer) return <td className="muted">—</td>;
  if (!peer.ok)
    return (
      <td className="error" title={`No answer (${peer.error})${peer.checkedAt ? `, ${ago(peer.checkedAt, now)}` : ''}`}>
        ✕
      </td>
    );
  const shown = peer.path ? SHOWN[peer.path] : null;
  const title = [
    shown?.label || 'path unknown',
    peer.via ? `via ${peer.via}` : '',
    `${peer.ms} ms`,
    peer.speed?.ok ? `${peer.speed.mbps} Mbit/s` : '',
    peer.checkedAt ? `checked ${ago(peer.checkedAt, now)}` : ''
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <td title={title}>
      {shown?.mark || '✓'} {peer.ms} ms{peer.speed?.ok ? ` · ${peer.speed.mbps} Mbit/s` : ''}
    </td>
  );
}

export default function ReachGrid({ agents, canEdit }: { agents: Agent[] | null; canEdit: boolean }) {
  const now = useNow(10000);
  const { records } = useRecords<AgentSettingsData>('agent_settings');
  const online = (agents || []).filter(
    (agent) => now - Date.parse(agent.updatedAt) < ONLINE_MS && agent.status?.settings?.tailscale
  );
  if (online.length < 2) return null;
  const nameOf = (agent: Agent) => agent.status?.name || agent.name || agent.recorderId;
  const checkNow = () =>
    Promise.all(
      online.map((agent) =>
        putRecord('agent_settings', agent.recorderId, {
          ...records?.find((record) => record.id === agent.recorderId)?.data,
          peerTestAt: new Date().toISOString()
        })
      )
    );
  return (
    <section className="panel">
      <div className="toolbar">
        <h2 className="grow">Who reaches whom</h2>
        {canEdit && (
          <button type="button" className="button" onClick={checkNow}>
            Check now
          </button>
        )}
      </div>
      <p className="muted small">
        From each agent&apos;s own checks over Tailscale (the hub doesn&apos;t need to reach them).{' '}
        {Object.values(SHOWN)
          .map((item) => `${item.mark} ${item.label}`)
          .join(' · ')}{' '}
        · ✕ no answer.
      </p>
      <div className="table-scroll">
        <table className="people jobs reach-grid">
          <thead>
            <tr>
              <th>From ↓ to →</th>
              {online.map((agent) => (
                <th key={agent.recorderId}>{nameOf(agent)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {online.map((from) => (
              <tr key={from.recorderId}>
                <th>{nameOf(from)}</th>
                {online.map((to) =>
                  to.recorderId === from.recorderId ? (
                    <td key={to.recorderId} className="muted">
                      ·
                    </td>
                  ) : (
                    <Cell
                      key={to.recorderId}
                      peer={from.status?.settings?.peers?.find((peer) => peer.agentId === to.recorderId)}
                      now={now}
                    />
                  )
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
