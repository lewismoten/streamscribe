import { SyncClient } from '../../../src/sync/client.js';
import { idbStore } from './idb-store.ts';
import { hubSettings } from './hub.ts';
import { sessionEnded } from './account.ts';

// One sync client for the page, over IndexedDB. Only one tab syncs at a time (Web Locks); every tab hears about
// changes (BroadcastChannel) so it can show them.
export interface SyncState {
  syncing: boolean;
  lastSyncAt: string;
  error: string;
  pending: number;
  conflicts: number;
  refused: string[];
}

type Listener = (changes: { collection: string; id: string }[]) => void;
const listeners = new Set<Listener>();
const stateListeners = new Set<(state: SyncState) => void>();
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('streamscribe');
export let syncState: SyncState = { syncing: false, lastSyncAt: '', error: '', pending: 0, conflicts: 0, refused: [] };

function announce(changes: { collection: string; id: string }[], fromOtherTab = false) {
  for (const listener of listeners) listener(changes);
  // A BroadcastChannel only reaches this site's own tabs, and its postMessage takes no target origin.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  if (!fromOtherTab) channel?.postMessage({ changes });
}
channel?.addEventListener('message', (event) => announce(event.data.changes || [], true));

let client: SyncClient | null = null;
export function syncClient(): SyncClient {
  const { url, key, token } = hubSettings();
  client ??= new SyncClient({
    store: idbStore,
    hubUrl: url,
    key,
    onChange: (changes: { collection: string; id: string }[]) => {
      announce(changes);
      idbStore.listPending().then((pending) => setState({ pending: pending.length }));
    }
  });
  client.hubUrl = url;
  // Signed in, the browser speaks as that person; otherwise with a key if one is set (for scripts), or only reads.
  client.token = token;
  client.key = token ? '' : key;
  return client;
}

function setState(patch: Partial<SyncState>) {
  syncState = { ...syncState, ...patch };
  for (const listener of stateListeners) listener(syncState);
}

export async function syncNow() {
  const sync = syncClient();
  if (!sync.hubUrl) {
    setState({ pending: (await idbStore.listPending()).length });
    return;
  }
  const work = async () => {
    setState({ syncing: true });
    try {
      // Signed out (and without a key) the browser only reads: local changes wait.
      const writer = Boolean(sync.token || sync.key);
      const result = writer ? await sync.sync() : { sent: 0, conflicts: [], refused: [] };
      if (!writer) await sync.pull();
      setState({
        lastSyncAt: new Date().toISOString(),
        error: '',
        conflicts: result.conflicts.length,
        refused: result.refused.map(
          (item: { collection: string; id: string; error: string }) => `${item.collection}/${item.id}: ${item.error}`
        )
      });
    } catch (error) {
      if ((error as { status?: number }).status === 401 && sync.token) {
        sessionEnded();
      }
      setState({ error: (error as Error).message });
    } finally {
      setState({ syncing: false, pending: (await idbStore.listPending()).length });
    }
  };
  if (navigator.locks) await navigator.locks.request('streamscribe-sync', work);
  else await work();
}

export function onRecordsChanged(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function onSyncState(listener: (state: SyncState) => void) {
  stateListeners.add(listener);
  listener(syncState);
  return () => {
    stateListeners.delete(listener);
  };
}

// Syncs now and then while a page is open (more often when asked, such as on the live page).
let timer: number | null = null;
export function startSyncing(seconds = 30) {
  if (timer) clearInterval(timer);
  syncNow();
  timer = window.setInterval(syncNow, seconds * 1000);
}
