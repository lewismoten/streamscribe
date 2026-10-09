import { useState, type FormEvent } from 'react';
import Dialog from '../Dialog.tsx';
import { hubCall } from '../data/hub.ts';
import { syncNow } from '../data/sync.ts';
import { useRecords } from '../data/useRecords.ts';

// Rendering the video: an agent with the meetings' recordings cuts each clip from them (not from the hub's small
// copies), joins them, and draws the overlays on. Standard is 720p for the web; production is 1080p from the
// recordings at their best. It goes to the hub (a public page for it), or into a folder on the agent (or a network
// folder it can reach). A notification says when it's ready, and where.
export interface RenderChoice {
  quality: 'standard' | 'production';
  destination: 'hub' | 'folder';
  folder: string;
  agentId: string;
}
const CHOICE_KEY = 'streamscribe.render';

export default function RenderDialog({
  videoId,
  overlays,
  layers = () => [],
  beforeRender,
  onDone,
  onClose
}: {
  videoId: string;
  // Each clip's overlays, by its key (worked out from the meetings).
  overlays: () => Record<string, unknown[]>;
  // The video's layers as the agent draws them (official video QR codes with their address each second).
  layers?: () => unknown[];
  beforeRender: () => Promise<unknown>;
  onDone: (message: string) => void;
  onClose: () => void;
}) {
  const { records: agents } = useRecords<{ name?: string; lastSeenAt?: string }>('recorders');
  const [choice, setChoice] = useState<RenderChoice>(() => {
    try {
      return {
        quality: 'production',
        destination: 'folder',
        folder: '',
        agentId: '',
        ...JSON.parse(localStorage.getItem(CHOICE_KEY) || '{}')
      };
    } catch {
      return { quality: 'production', destination: 'folder', folder: '', agentId: '' };
    }
  });
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const render = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem('');
    try {
      localStorage.setItem(CHOICE_KEY, JSON.stringify(choice));
    } catch {
      /* remembered next time, when the browser allows */
    }
    try {
      await beforeRender();
      await syncNow();
      const reply = await hubCall<{ id: string | null; job: string }>('publish-video', {
        id: videoId,
        ...choice,
        overlays: overlays(),
        layers: layers()
      });
      await syncNow();
      onDone(
        choice.destination === 'hub'
          ? `Rendering for the hub (job ${reply.job}); it will be at /published/${reply.id}. A notification says when it's ready.`
          : `Rendering into a folder on ${choice.agentId ? agents?.find((agent) => agent.id === choice.agentId)?.data.name || choice.agentId : 'an agent'} (job ${reply.job}). A notification says when it's ready, and where.`
      );
    } catch (error) {
      setProblem((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog title="Render the video" onClose={onClose}>
      <form className="schedule-form" onSubmit={render}>
        <fieldset>
          <legend>Quality</legend>
          <label className="inline">
            <input
              type="radio"
              name="quality"
              checked={choice.quality === 'production'}
              onChange={() => setChoice({ ...choice, quality: 'production' })}
            />{' '}
            Production: 1080p, from the recordings at their best
          </label>
          <label className="inline">
            <input
              type="radio"
              name="quality"
              checked={choice.quality === 'standard'}
              onChange={() => setChoice({ ...choice, quality: 'standard' })}
            />{' '}
            Standard: 720p, smaller, for the web
          </label>
        </fieldset>
        <fieldset>
          <legend>Where it goes</legend>
          <label className="inline">
            <input
              type="radio"
              name="destination"
              checked={choice.destination === 'folder'}
              onChange={() => setChoice({ ...choice, destination: 'folder' })}
            />{' '}
            A folder on the agent (or a network folder it can reach)
          </label>
          <label className="inline">
            <input
              type="radio"
              name="destination"
              checked={choice.destination === 'hub'}
              onChange={() => setChoice({ ...choice, destination: 'hub' })}
            />{' '}
            The hub: published, on a page of its own
          </label>
        </fieldset>
        <div className="form-grid">
          <label>
            Agent
            <select value={choice.agentId} onChange={(event) => setChoice({ ...choice, agentId: event.target.value })}>
              <option value="">Any with the recordings</option>
              {(agents || []).map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.data.name || agent.id}
                </option>
              ))}
            </select>
          </label>
          {choice.destination === 'folder' && (
            <label>
              Folder on the agent
              <input
                value={choice.folder}
                onChange={(event) => setChoice({ ...choice, folder: event.target.value })}
                placeholder="~/streamscribe-videos"
                autoComplete="off"
              />
            </label>
          )}
        </div>
        {problem && (
          <p className="error" role="alert">
            {problem}
          </p>
        )}
        <div className="toolbar">
          <button type="submit" className="button primary" disabled={busy}>
            {busy ? 'Starting…' : 'Render'}
          </button>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
