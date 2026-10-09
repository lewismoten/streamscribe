import { useState, type FormEvent } from 'react';
import { hubCall } from '../data/hub.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import type { AgentSettingsData, PlaceStatus, SettingsReport } from './types.ts';

// An agent's settings (where its working files go, more storage to watch, an Ollama server, the port it answers pings
// on) and what it found: each place there and writable, with its free space; the Ollama server's models; its
// Tailscale address and which other agents it reaches; and a ping from the hub. People who may edit sources change
// the settings; the agent picks them up within a minute.
const KINDS = { local: 'Local drive', usb: 'USB drive', network: 'Network folder' } as const;

function Place({ place, label }: { place?: PlaceStatus; label: string }) {
  if (!place) return null;
  return (
    <li className={place.ok ? '' : 'error'}>
      {label}: <code>{place.path}</code>{' '}
      {place.ok ? `· ${place.freeGb} GB free` : `· can't be written (${place.error})`}
    </li>
  );
}

export default function AgentSettings({
  agentId,
  report,
  canEdit
}: {
  agentId: string;
  report: SettingsReport | null | undefined;
  canEdit: boolean;
}) {
  const { records } = useRecords<AgentSettingsData>('agent_settings');
  const saved = records?.find((record) => record.id === agentId)?.data || {};
  const [draft, setDraft] = useState<AgentSettingsData | null>(null);
  const [ping, setPing] = useState('');
  const settings = draft || saved;
  const set = (patch: Partial<AgentSettingsData>) => setDraft({ ...settings, ...patch });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    await putRecord('agent_settings', agentId, {
      ...settings,
      storage: (settings.storage || []).filter((place) => place.path.trim()),
      ollama: settings.ollama?.url?.trim() ? { ...settings.ollama, url: settings.ollama.url.trim() } : undefined
    });
    setDraft(null);
  };
  const testOllama = () =>
    putRecord('agent_settings', agentId, {
      ...saved,
      ollama: { ...saved.ollama, url: saved.ollama?.url || '', testAt: new Date().toISOString() }
    });
  const pingFromHub = async () => {
    setPing('Pinging…');
    try {
      const answer = await hubCall<{ ok: boolean; ms?: number; error?: string }>('agent-ping', { agentId });
      setPing(answer.ok ? `Answered in ${answer.ms} ms` : answer.error || 'No answer');
    } catch (error) {
      setPing((error as Error).message);
    }
  };

  return (
    <details className="agent-settings small">
      <summary>Storage, Ollama, and network</summary>
      {report?.checkedAt ? (
        <ul>
          <Place place={report.workDir} label="Working files" />
          <Place place={report.data} label="Recordings" />
          {(report.storage || []).map((place) => (
            <Place
              key={place.path}
              place={place}
              label={`${place.label || 'Storage'} (${KINDS[place.kind as keyof typeof KINDS] || place.kind})`}
            />
          ))}
          {report.ollama && (
            <li className={report.ollama.ok ? '' : 'error'}>
              Ollama at <code>{report.ollama.url}</code>:{' '}
              {report.ollama.ok
                ? `${report.ollama.models?.length || 0} models (${(report.ollama.models || []).map((model) => model.name).join(', ') || 'none'})`
                : `no answer (${report.ollama.error})`}
            </li>
          )}
          <li>
            {report.tailscale
              ? `Tailscale ${report.tailscale.name || ''} ${report.tailscale.ip}, answering pings on port ${report.tailscale.port}`
              : 'Not on Tailscale (or tailscale is not installed)'}
          </li>
          {(report.peers || []).map((peer) => (
            <li key={peer.agentId} className={peer.ok ? '' : 'error'}>
              Reaches {peer.name || peer.agentId}: {peer.ok ? `${peer.ms} ms` : `no (${peer.error})`}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Not reported yet (agents check their settings each minute).</p>
      )}
      <div className="toolbar">
        <button type="button" className="button" onClick={pingFromHub} disabled={!report?.tailscale}>
          Ping from the hub
        </button>
        {ping && <output>{ping}</output>}
        {canEdit && saved.ollama?.url && (
          <button type="button" className="button" onClick={testOllama}>
            Test Ollama
          </button>
        )}
      </div>
      {canEdit && (
        <form className="schedule-form" onSubmit={save}>
          <label className="block">
            Working files (a local drive, a USB drive, or a network folder)
            <input
              value={settings.workDir || ''}
              onChange={(event) => set({ workDir: event.target.value })}
              placeholder="/Volumes/Work/streamscribe (the system's temporary folder unless set)"
            />
          </label>
          <fieldset>
            <legend>Storage to watch</legend>
            {(settings.storage || []).map((place, index) => (
              <div key={index} className="toolbar">
                <input
                  value={place.label}
                  onChange={(event) =>
                    set({
                      storage: settings.storage!.map((item, at) =>
                        at === index ? { ...item, label: event.target.value } : item
                      )
                    })
                  }
                  placeholder="Label"
                  aria-label="Its label"
                />
                <input
                  value={place.path}
                  onChange={(event) =>
                    set({
                      storage: settings.storage!.map((item, at) =>
                        at === index ? { ...item, path: event.target.value } : item
                      )
                    })
                  }
                  placeholder="/Volumes/Archive"
                  aria-label="Its folder"
                />
                <select
                  value={place.kind}
                  onChange={(event) =>
                    set({
                      storage: settings.storage!.map((item, at) =>
                        at === index ? { ...item, kind: event.target.value as 'local' | 'usb' | 'network' } : item
                      )
                    })
                  }
                  aria-label="What it is"
                >
                  {Object.entries(KINDS).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="link-button danger"
                  onClick={() => set({ storage: settings.storage!.filter((_, at) => at !== index) })}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="link-button"
              onClick={() => set({ storage: [...(settings.storage || []), { label: '', path: '', kind: 'usb' }] })}
            >
              ＋ A place to watch
            </button>
          </fieldset>
          <label className="block">
            Ollama server
            <input
              value={settings.ollama?.url || ''}
              onChange={(event) => set({ ollama: { ...settings.ollama, url: event.target.value } })}
              placeholder="http://100.64.0.5:11434"
            />
          </label>
          <label className="block">
            Answers pings on port
            <input
              type="number"
              min={1024}
              max={65535}
              value={settings.peerPort || ''}
              onChange={(event) => set({ peerPort: Number(event.target.value) || undefined })}
              placeholder="4874"
            />
          </label>
          <p className="muted">
            Recordings stay where the agent&apos;s config.local.js says (each source&apos;s storageDir), so a
            meeting&apos;s files are never split between drives.
          </p>
          <div className="toolbar">
            <button type="submit" className="button primary" disabled={!draft}>
              Save the settings
            </button>
            {draft && (
              <button type="button" className="button" onClick={() => setDraft(null)}>
                Cancel
              </button>
            )}
          </div>
        </form>
      )}
    </details>
  );
}
