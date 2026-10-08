import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { hubSettings, saveHubSettings } from '../data/hub.ts';
import { idbStore } from '../data/idb-store.ts';
import { onSyncState, syncClient, syncNow, type SyncState } from '../data/sync.ts';
import { refreshAccount } from '../data/account.ts';
import { canWrite } from '../../../src/sync/collections.js';

// Where the hub is (and, for scripts, a key; people sign in under Account instead), syncing, and moving data in and out as
// JSON (the same records the hub keeps; an export can also start a new hub).
export default function SettingsPage() {
  const [settings, setSettings] = useState(hubSettings());
  const [state, setState] = useState<SyncState | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => onSyncState(setState), []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const previous = hubSettings().url;
    const next = settings.url.trim().replace(/\/+$/, '');
    if (previous && next !== previous) {
      // A different hub: this browser's copy of the old one goes. Changes made without a hub are kept and sent to the
      // new one; changes waiting for the old hub would be sent against the wrong versions, so they go too.
      const pending = (await idbStore.listPending()).length;
      if (pending && !confirm(`${pending} change${pending === 1 ? '' : 's'} not yet sent to ${previous} will be lost. Switch hubs?`)) return;
      await idbStore.clear();
    } else if (!previous && next) {
      await idbStore.clearHubCopy();
    }
    // A session belongs to the hub it was made on.
    saveHubSettings({ ...settings, token: next !== previous ? '' : hubSettings().token });
    setSettings(hubSettings());
    refreshAccount();
    if (!settings.url) { setMessage('Saved: no hub, so this browser keeps its own copy only.'); return; }
    try {
      const info = await fetch(`${hubSettings().url}/info`).then((response) => response.json());
      setMessage(`Connected to ${info.name} (${info.rev} changes so far). Syncing…`);
      await syncNow();
    } catch (error) {
      setMessage(`Saved, but the hub didn't answer: ${(error as Error).message}`);
    }
  };
  const exportAll = async () => {
    const records = await idbStore.allRecords();
    const pending = await idbStore.listPending();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), records, pending }, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `streamscribe-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  };
  const importAll = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const value = JSON.parse(await file.text());
    // Only what an editor may change (schedules, sources, marks, settings); what recorders made (recordings,
    // transcripts, stills) goes into a hub with its tools/import.php instead.
    const all = [...(value.records || []), ...(value.pending || [])].filter((item) => item.collection && item.id && !item.deleted);
    const items = all.filter((item) => canWrite(item.collection, 'editor'));
    const client = syncClient();
    for (const item of items) await client.put(item.collection, item.id, item.data);
    const skipped = all.length - items.length;
    setMessage(`Imported ${items.length} records${hubSettings().url ? '; they go to the hub on the next sync' : ''}.`
      + (skipped ? ` Skipped ${skipped} made by recorders (load those into a hub with its tools/import.php).` : ''));
    event.target.value = '';
    syncNow();
  };

  return (
    <section>
      <h1>Settings</h1>
      <form className="panel schedule-form" onSubmit={save}>
        <h2>Hub</h2>
        <p className="muted">The hub (docs/hub/hub.md) is where recorders report and schedules live. Without one, this browser keeps its own copy only.</p>
        <div className="form-grid">
          <label>Hub address <input value={settings.url} onChange={(event) => setSettings({ ...settings, url: event.target.value })} placeholder="https://example.com/streamscribe/api.php" /></label>
          <details>
            <summary>Key (for scripts; people sign in under Account)</summary>
            <label>Editor key <input type="password" value={settings.key} onChange={(event) => setSettings({ ...settings, key: event.target.value })} placeholder="from the hub's config.php" autoComplete="off" /></label>
          </details>
        </div>
        <div className="card-actions">
          <button type="submit" className="button primary">Save and connect</button>
          <button type="button" className="button" onClick={() => syncNow()}>↻ Sync now</button>
        </div>
        {message && <p className="note">{message}</p>}
        {state && (
          <p className="muted">
            {state.syncing ? 'Syncing…' : state.lastSyncAt ? `Last synced ${new Date(state.lastSyncAt).toLocaleTimeString()}` : 'Not synced yet'}
            {state.pending ? ` · ${state.pending} change${state.pending === 1 ? '' : 's'} waiting to be sent${settings.key || settings.token ? '' : ' (sign in to send them)'}` : ''}
            {state.conflicts ? ` · ${state.conflicts} merged with someone else's changes` : ''}
            {state.refused.length ? ` · the hub refused ${state.refused.length} (dropped): ${state.refused.join('; ')}` : ''}
            {state.error && <span className="error"> · {state.error}</span>}
          </p>
        )}
      </form>
      <section className="panel">
        <h2>Data</h2>
        <p className="muted">Everything this browser holds, as JSON: a backup, or a way to start a new hub.</p>
        <div className="card-actions">
          <button type="button" className="button" onClick={exportAll}>⬇ Export</button>
          <label className="button">⬆ Import <input type="file" accept="application/json" onChange={importAll} hidden /></label>
          <button type="button" className="button" onClick={async () => { if (confirm('Clear this browser\'s copy? (The hub keeps its data; unsent changes are lost.)')) { await idbStore.clear(); setMessage('Cleared. Syncing again…'); syncNow(); } }}>Clear this browser's copy</button>
        </div>
      </section>
    </section>
  );
}
