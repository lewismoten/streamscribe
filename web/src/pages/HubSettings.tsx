import { useEffect, useState, type FormEvent } from 'react';
import { hubCall } from '../data/hub.ts';
import { useRecords } from '../data/useRecords.ts';

// For admins: the hub's settings, kept in its database (hub-php/lib/config.php), and keys for scripts and recorders
// set up by hand. Settings an older config.php still holds are shown, and saving here takes them over.
interface Podcast {
  title?: string;
  description?: string;
  author?: string;
  email?: string;
  image?: string;
  category?: string;
  language?: string;
}
interface Settings {
  name: string;
  allowed_origins: string[];
  public_url: string;
  site_url: string;
  max_media_bytes: number;
  upload_chunk_bytes: number;
  max_clip_minutes: number;
  podcasts: Record<string, Podcast>;
}
interface HubConfig {
  settings: Settings;
  defaults: Settings;
  fromFile: string[];
}
interface Key {
  id: number;
  name: string;
  scope: 'editor' | 'recorder';
  createdAt: string;
  revoked: boolean;
}

const MB = 1048576;
const fetchConfig = () => hubCall<HubConfig>('hub-config');
const fetchKeys = () => hubCall<{ keys: Key[] }>('keys').then((reply) => reply.keys);
const PODCAST_FIELDS: [keyof Podcast, string][] = [
  ['title', 'Title'],
  ['description', 'Description'],
  ['author', 'Author'],
  ['email', 'Email'],
  ['image', 'Cover image address (square, 1400 to 3000 px)'],
  ['category', 'Category'],
  ['language', 'Language (such as en-us)']
];

export default function HubSettings() {
  return (
    <>
      <SettingsForm />
      <Keys />
    </>
  );
}

function SettingsForm() {
  const [config, setConfig] = useState<HubConfig | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [origins, setOrigins] = useState('');
  const [message, setMessage] = useState('');
  const { records: sources } = useRecords<{ name?: string }>('sources');
  const loaded = (reply: HubConfig) => {
    setConfig(reply);
    setDraft(reply.settings);
    setOrigins(reply.settings.allowed_origins.join('\n'));
  };
  useEffect(() => {
    fetchConfig()
      .then((reply) => {
        setConfig(reply);
        setDraft(reply.settings);
        setOrigins(reply.settings.allowed_origins.join('\n'));
      })
      .catch((error: Error) => setMessage(error.message));
  }, []);
  if (!draft || !config) return message ? <p className="error">{message}</p> : null;

  const change = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });
  const podcast = (source: string, field: keyof Podcast, value: string) =>
    change({ podcasts: { ...draft.podcasts, [source]: { ...draft.podcasts[source], [field]: value } } });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      const settings = { ...draft, allowed_origins: origins.split(/\s+/).filter(Boolean) };
      loaded(await hubCall<HubConfig>('hub-config', { settings }));
      setMessage('Saved.');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const sourceKeys = [...new Set([...(sources || []).map((record) => record.id), ...Object.keys(draft.podcasts)])];

  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>Hub settings</h2>
      {config.fromFile.length > 0 && (
        <p className="muted small">
          Read from the hub&apos;s config.php for now: {config.fromFile.join(', ')}. Saving here keeps them in the
          database instead, and config.php&apos;s copy is no longer used.
        </p>
      )}
      <label>
        Hub name <input value={draft.name} onChange={(event) => change({ name: event.target.value })} required />
      </label>
      <label>
        Other sites that may use this hub from a browser, one per line (such as a GitHub Pages copy; the site beside the
        hub needs nothing)
        <textarea
          rows={3}
          value={origins}
          onChange={(event) => setOrigins(event.target.value)}
          placeholder="https://your-name.github.io"
        />
      </label>
      <label>
        The hub&apos;s public address (when it can&apos;t tell, such as behind a proxy){' '}
        <input
          type="url"
          value={draft.public_url}
          onChange={(event) => change({ public_url: event.target.value })}
          placeholder="https://example.com/hub/"
        />
      </label>
      <label>
        The web app&apos;s public address{' '}
        <input
          type="url"
          value={draft.site_url}
          onChange={(event) => change({ site_url: event.target.value })}
          placeholder="https://example.com/"
        />
      </label>
      <label>
        Largest picture upload (MB){' '}
        <input
          type="number"
          min={0.0625}
          step="any"
          value={draft.max_media_bytes / MB}
          onChange={(event) => change({ max_media_bytes: Math.round(Number(event.target.value) * MB) })}
        />
      </label>
      <label>
        Pieces agents upload large files in (MB; under the host&apos;s post_max_size){' '}
        <input
          type="number"
          min={0.0625}
          step="any"
          value={draft.upload_chunk_bytes / MB}
          onChange={(event) => change({ upload_chunk_bytes: Math.round(Number(event.target.value) * MB) })}
        />
      </label>
      <label>
        Longest clip (minutes){' '}
        <input
          type="number"
          min={1}
          max={1440}
          value={draft.max_clip_minutes}
          onChange={(event) => change({ max_clip_minutes: Number(event.target.value) })}
        />
      </label>
      {sourceKeys.length > 0 && <h3>Podcasts of published clips</h3>}
      {sourceKeys.map((source) => (
        <fieldset key={source}>
          <legend>{sources?.find((record) => record.id === source)?.data.name || source}</legend>
          {PODCAST_FIELDS.map(([field, label]) => (
            <label key={field}>
              {label}{' '}
              <input
                value={draft.podcasts[source]?.[field] || ''}
                onChange={(event) => podcast(source, field, event.target.value)}
              />
            </label>
          ))}
        </fieldset>
      ))}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save settings
        </button>
        {message && <output>{message}</output>}
      </div>
    </form>
  );
}

function Keys() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [form, setForm] = useState({ scope: 'editor', name: '' });
  const [made, setMade] = useState('');
  const [message, setMessage] = useState('');
  const load = () =>
    fetchKeys()
      .then(setKeys)
      .catch((error: Error) => setMessage(error.message));
  useEffect(() => {
    fetchKeys()
      .then(setKeys)
      .catch((error: Error) => setMessage(error.message));
  }, []);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    setMessage('');
    try {
      setMade((await hubCall<{ key: string }>('keys/create', form)).key);
      setForm({ ...form, name: '' });
      load();
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const revoke = async (key: Key) => {
    if (!confirm(`Stop the key "${key.name}"? Whatever uses it can no longer write.`)) return;
    await hubCall('keys/revoke', { id: key.id });
    load();
  };

  return (
    <div className="panel schedule-form">
      <h2>Keys</h2>
      <p className="muted small">
        For scripts (such as npm run publish-library) and recorders set up by hand. Agents added on the Agents page get
        their own.
      </p>
      {keys.length > 0 && (
        <table className="people">
          <thead>
            <tr>
              <th>Name</th>
              <th>For</th>
              <th>Made</th>
              <th>
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className={key.revoked ? 'muted' : ''}>
                <td>{key.name}</td>
                <td>{key.scope === 'editor' ? 'Editing' : 'Recording'}</td>
                <td>{new Date(key.createdAt).toLocaleDateString()}</td>
                <td>
                  {key.revoked ? (
                    'Stopped'
                  ) : (
                    <button type="button" className="link-button" onClick={() => revoke(key)}>
                      Stop
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form onSubmit={create} className="toolbar">
        <label>
          Key name{' '}
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Who or what uses it"
            required
          />
        </label>
        <label>
          For{' '}
          <select value={form.scope} onChange={(event) => setForm({ ...form, scope: event.target.value })}>
            <option value="editor">Editing (scripts)</option>
            <option value="recorder">Recording</option>
          </select>
        </label>
        <button type="submit" className="button">
          Make a key
        </button>
      </form>
      {made && (
        <output className="block">
          The new key, shown only now: <code>{made}</code>
        </output>
      )}
      {message && <p className="error">{message}</p>}
    </div>
  );
}
