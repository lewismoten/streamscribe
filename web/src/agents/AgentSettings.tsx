import { useState, type FormEvent } from 'react';
import { putRecord, useRecords } from '../data/useRecords.ts';
import {
  WHISPER_MODELS,
  type LlmServerStatus,
  type AgentSettingsData,
  type CopiesReport,
  type Peer,
  type PlaceStatus,
  type SettingsReport,
  type ToolStatus,
  type UpdateStatus
} from './types.ts';

// An agent's settings (where its working files go, more storage to watch, an Ollama server, the port it answers pings
// on) and what it found: each place there and writable, with its free space; the Ollama server's models; its
// Tailscale address and which other agents it reaches (on the same network or elsewhere, and how fast a transfer goes),
// checked again when asked (through the hub, which needn't reach the agents itself). People who may edit sources change
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

const PATHS = {
  local: 'same network',
  direct: 'elsewhere, connected directly',
  relay: "elsewhere, through Tailscale's relay"
} as const;

function PeerLine({ peer }: { peer: Peer }) {
  if (!peer.ok)
    return (
      <li className="error">
        Doesn&apos;t reach {peer.name || peer.agentId}
        {peer.host ? ` on ${peer.host}` : ''} ({peer.error})
      </li>
    );
  const parts = [
    peer.path ? `${PATHS[peer.path]}${peer.via ? ` (via ${peer.via})` : ''}` : 'path unknown',
    `${peer.ms} ms`,
    peer.speed?.ok ? `${peer.speed.mbps} Mbit/s` : peer.speed ? `transfer failed (${peer.speed.error})` : null
  ];
  return (
    <li className={peer.path === 'relay' ? 'muted' : ''}>
      Reaches {peer.name || peer.agentId}
      {peer.host ? ` (${peer.host})` : ''}: {parts.filter(Boolean).join(' · ')}
    </li>
  );
}

// A language-model server: answering now (with its models) or not, as checked within the minute.
function LlmLine({ server }: { server: LlmServerStatus }) {
  return (
    <li className={server.ok ? '' : 'muted'}>
      {server.label || (server.kind === 'openai' ? 'OpenAI-style server' : 'Ollama')} at <code>{server.url}</code>:{' '}
      {server.ok
        ? `${server.models?.length || 0} models (${(server.models || []).map((model) => model.name).join(', ') || 'none'})`
        : `off now (${server.error})`}
    </li>
  );
}

// whisper.cpp on the agent: installing (and how far), installed (which version and model), or failed (why).
function WhisperStatus({ status }: { status?: ToolStatus }) {
  if (!status) return null;
  const model = status.model ? status.model.split('/').at(-1) : '';
  if (status.state === 'installing')
    return (
      <li>
        Installing whisper.cpp: {status.step} ({Math.round((status.share || 0) * 100)}%)
      </li>
    );
  if (status.state === 'failed') return <li className="error">Installing whisper.cpp failed: {status.error}</li>;
  return (
    <li>
      whisper.cpp {status.version} installed, with {model}
    </li>
  );
}

// A storage agent's copies: how many, where, room left, and the one being copied.
function Copies({ copies }: { copies: CopiesReport }) {
  return (
    <li className={copies.error ? 'error' : ''}>
      Keeps a copy of every recording: {copies.recordings} recordings ({copies.parts} parts) in{' '}
      <code>{copies.dir}</code>
      {copies.freeGb !== null ? ` · ${copies.freeGb} GB free` : ''}
      {copies.copying
        ? ` · copying ${copies.copying.title} (${copies.copying.part}), ${Math.round(copies.copying.share * 100)}%`
        : ''}
      {copies.missing ? ` · ${copies.missing} not on any agent it reaches now` : ''}
      {copies.error ? ` · ${copies.error}` : ''}
    </li>
  );
}

export default function AgentSettings({
  agentId,
  report,
  copies,
  update,
  canEdit
}: {
  agentId: string;
  report: SettingsReport | null | undefined;
  copies?: CopiesReport | null;
  update?: UpdateStatus | null;
  canEdit: boolean;
}) {
  const { records } = useRecords<AgentSettingsData>('agent_settings');
  const saved = records?.find((record) => record.id === agentId)?.data || {};
  const [draft, setDraft] = useState<AgentSettingsData | null>(null);
  const settings = draft || saved;
  const set = (patch: Partial<AgentSettingsData>) => setDraft({ ...settings, ...patch });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    await putRecord('agent_settings', agentId, {
      ...settings,
      storage: (settings.storage || []).filter((place) => place.path.trim()),
      copiesDir: settings.copiesDir?.trim() || undefined,
      ollama: settings.ollama?.url?.trim() ? { ...settings.ollama, url: settings.ollama.url.trim() } : undefined,
      llmServers: (settings.llmServers || [])
        .map((server) => ({ ...server, url: server.url.trim(), label: server.label.trim() }))
        .filter((server) => server.url)
    });
    setDraft(null);
  };
  const testOllama = () =>
    putRecord('agent_settings', agentId, {
      ...saved,
      ollama: { ...saved.ollama, url: saved.ollama?.url || '', testAt: new Date().toISOString() }
    });
  const [whisperModel, setWhisperModel] = useState('');
  const chosenModel = whisperModel || saved.tools?.whisper?.model || 'base.en';
  const installWhisper = () =>
    putRecord('agent_settings', agentId, {
      ...saved,
      tools: { ...saved.tools, whisper: { model: chosenModel, at: new Date().toISOString() } }
    });
  const installing = report?.tools?.whisper?.state === 'installing';
  // (The website can't reach agents: the request goes through the hub, and the agent picks it up when it next syncs.)
  const updateNow = () => putRecord('agent_settings', agentId, { ...saved, updateAt: new Date().toISOString() });
  const checkNow = () => putRecord('agent_settings', agentId, { ...saved, peerTestAt: new Date().toISOString() });
  const asked = saved.peerTestAt && (!report?.checkedAt || report.checkedAt < saved.peerTestAt);

  return (
    <details className="agent-settings small">
      <summary>Storage, copies, tools, language models, and network</summary>
      {report?.checkedAt ? (
        <ul>
          <Place place={report.workDir} label="Working files" />
          <Place place={report.data} label="Recordings" />
          {copies && <Copies copies={copies} />}
          <WhisperStatus status={report.tools?.whisper} />
          {(report.storage || []).map((place) => (
            <Place
              key={place.path}
              place={place}
              label={`${place.label || 'Storage'} (${KINDS[place.kind as keyof typeof KINDS] || place.kind})`}
            />
          ))}
          {(report.llm || (report.ollama ? [{ ...report.ollama, label: 'Ollama', kind: 'ollama' as const }] : [])).map(
            (server) => (
              <LlmLine key={server.url} server={server} />
            )
          )}
          {saved.taskModel && <li>Tasks that name no model: {saved.taskModel}</li>}
          <li>
            {report.tailscale
              ? `Tailscale ${report.tailscale.name || ''} ${report.tailscale.ip}, answering the other agents on port ${report.tailscale.port}${report.tailscale.lan?.length ? ` · on its network as ${report.tailscale.lan.join(', ')}` : ''}`
              : 'Not on Tailscale (or tailscale is not installed)'}
          </li>
          {(report.peers || []).map((peer) => (
            <PeerLine key={peer.agentId} peer={peer} />
          ))}
        </ul>
      ) : (
        <p className="muted">Not reported yet (agents check their settings each minute).</p>
      )}
      <div className="toolbar">
        {canEdit && update?.canUpdate && update.behind && update.state !== 'waiting' && (
          <button type="button" className="button" onClick={updateNow}>
            Update now (to {update.latest})
          </button>
        )}
        {update?.note && <span className="muted">{update.note}</span>}
        {canEdit && report?.tailscale && (
          <button type="button" className="button" onClick={checkNow} disabled={Boolean(asked)}>
            {asked ? 'Asked: checking within a minute' : 'Check the other agents now'}
          </button>
        )}
        {canEdit && saved.ollama?.url && (
          <button type="button" className="button" onClick={testOllama}>
            Test Ollama
          </button>
        )}
      </div>
      {canEdit && (
        <div className="toolbar">
          <label>
            whisper.cpp model{' '}
            <select value={chosenModel} onChange={(event) => setWhisperModel(event.target.value)}>
              {Object.entries(WHISPER_MODELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="button" onClick={installWhisper} disabled={installing}>
            {report?.tools?.whisper?.state === 'installed' ? 'Install again, or this model' : 'Install whisper.cpp'}
          </button>
        </div>
      )}
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
          <label>
            <input
              type="checkbox"
              checked={Boolean(settings.autoUpdate)}
              onChange={(event) => set({ autoUpdate: event.target.checked })}
            />{' '}
            Updates itself when the hub has a newer build (when idle, then restarts)
          </label>
          <label>
            <input
              type="checkbox"
              checked={Boolean(settings.keepsCopies)}
              onChange={(event) => set({ keepsCopies: event.target.checked })}
            />{' '}
            Keeps a copy of every recording (a storage agent: the others fetch from it)
          </label>
          {settings.keepsCopies && (
            <label className="block">
              Copies go in
              <input
                value={settings.copiesDir || ''}
                onChange={(event) => set({ copiesDir: event.target.value })}
                placeholder="/Volumes/Big/streamscribe-copies (its data folder's copies/ unless set)"
              />
            </label>
          )}
          <label className="block">
            Ollama server
            <input
              value={settings.ollama?.url || ''}
              onChange={(event) => set({ ollama: { ...settings.ollama, url: event.target.value } })}
              placeholder="http://100.64.0.5:11434"
            />
          </label>
          <fieldset>
            <legend>More language-model servers (other ports, other builds; some may be off while others run)</legend>
            {(settings.llmServers || []).map((server, index) => (
              <div key={index} className="toolbar">
                <input
                  value={server.label}
                  onChange={(event) =>
                    set({
                      llmServers: settings.llmServers!.map((item, at) =>
                        at === index ? { ...item, label: event.target.value } : item
                      )
                    })
                  }
                  placeholder="Label"
                  aria-label="Its label"
                />
                <input
                  value={server.url}
                  onChange={(event) =>
                    set({
                      llmServers: settings.llmServers!.map((item, at) =>
                        at === index ? { ...item, url: event.target.value } : item
                      )
                    })
                  }
                  placeholder="http://localhost:8080"
                  aria-label="Its address"
                />
                <select
                  value={server.kind}
                  onChange={(event) =>
                    set({
                      llmServers: settings.llmServers!.map((item, at) =>
                        at === index ? { ...item, kind: event.target.value as 'ollama' | 'openai' } : item
                      )
                    })
                  }
                  aria-label="What it is"
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai">OpenAI-style (llama.cpp, vLLM, …)</option>
                </select>
                <button
                  type="button"
                  className="link-button danger"
                  onClick={() => set({ llmServers: settings.llmServers!.filter((_, at) => at !== index) })}
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="link-button"
              onClick={() =>
                set({ llmServers: [...(settings.llmServers || []), { label: '', url: '', kind: 'openai' }] })
              }
            >
              ＋ A server
            </button>
          </fieldset>
          <label className="block">
            Model for tasks that don&apos;t name one (an agent without one leaves those to another)
            <select
              value={settings.taskModel || ''}
              onChange={(event) => set({ taskModel: event.target.value || undefined })}
            >
              <option value="">None</option>
              {[...new Set((report?.llm || []).flatMap((server) => (server.models || []).map((model) => model.name)))]
                .concat(settings.taskModel && !(report?.llm || []).length ? [settings.taskModel] : [])
                .map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block">
            Answers the other agents on port
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
