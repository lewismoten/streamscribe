import { useSyncExternalStore } from 'react';
import { hubCall, hubSettings, saveHubSettings, setFileKey } from './hub.ts';
import { idbStore } from './idb-store.ts';
import { syncNow } from './sync.ts';

// Who is signed in on the hub, with what their group may do. Signed out, everything is read-only. Signing in or out
// changes what the hub shows this browser (people's own private changes, untrusted changes for reviewers), so this
// browser's copy is fetched again from the start.
export interface User {
  id: number;
  username: string;
  displayName: string;
  groupId: number;
  group: string;
  trusted: boolean;
  disabled: boolean;
  createdAt: string;
  lastSeenAt: string | null;
}
export interface HubSignupSettings {
  registration: 'open' | 'closed';
  defaultGroupId: number;
  newUsersTrusted: boolean;
}
export interface Account {
  user: User | null;
  permissions: string[];
  settings: HubSignupSettings | null;
  permissionNames: Record<string, string>;
  checked: boolean;
  fileKeyAt: number;
}

let account: Account = {
  user: null,
  permissions: [],
  settings: null,
  permissionNames: {},
  checked: false,
  fileKeyAt: 0
};
const listeners = new Set<(value: Account) => void>();
function set(value: Partial<Account>) {
  account = { ...account, ...value };
  for (const listener of listeners) listener(account);
  keepFileKey();
}

// The signature for meetings' private files (see hub.ts), for viewers who may see meetings: fetched on sign-in and
// renewed every few hours (it lasts 12). Pages showing private pictures and media re-render when it arrives.
let fileKeyTimer: number | null = null;
function keepFileKey() {
  const wanted = account.permissions.includes('view.meetings');
  if (!wanted) {
    setFileKey(null);
    if (fileKeyTimer) {
      clearInterval(fileKeyTimer);
      fileKeyTimer = null;
    }
    return;
  }
  if (fileKeyTimer) return;
  const fetchKey = () =>
    hubCall<{ e: number; s: string }>('file-key')
      .then((key) => {
        setFileKey(key);
        set({ fileKeyAt: Date.now() });
      })
      .catch(() => {
        /* tried again later */
      });
  fileKeyTimer = window.setInterval(fetchKey, 4 * 3600 * 1000);
  fetchKey();
}

export const currentAccount = () => account;
export const can = (permission: string, value = account) => value.permissions.includes(permission);

// The account, re-rendering the component whenever it changes (sign-in, sign-out, a new file key).
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useAccount = () => useSyncExternalStore(subscribe, currentAccount);

// Asks the hub who this browser is (on start, and after the hub address changes).
export async function refreshAccount() {
  if (!hubSettings().url) {
    set({ user: null, permissions: [], settings: null, checked: true });
    return account;
  }
  try {
    const me = await hubCall<Omit<Account, 'checked' | 'fileKeyAt'>>('me');
    if (!me.user && hubSettings().token) await forgetSession(); // the session ended
    set({ ...me, checked: true });
  } catch {
    set({ checked: true }); // hub unreachable: keep what we knew
  }
  return account;
}

async function startOver() {
  await idbStore.clearHubCopy();
  syncNow();
}

async function signedIn(reply: { token: string } & Omit<Account, 'checked' | 'fileKeyAt'>) {
  saveHubSettings({ token: reply.token });
  set({
    user: reply.user,
    permissions: reply.permissions,
    settings: reply.settings,
    permissionNames: reply.permissionNames,
    checked: true
  });
  await startOver();
}

export async function signIn(username: string, password: string) {
  await signedIn(await hubCall('login', { username, password }));
}

export async function signUp(username: string, password: string, displayName: string) {
  await signedIn(await hubCall('register', { username, password, displayName }));
}

// Signs out here (and on the hub). Changes not yet sent are this person's, so they go too.
export async function signOut() {
  try {
    await hubCall('logout', {});
  } catch {
    /* signed out here regardless */
  }
  await forgetSession();
}

async function forgetSession() {
  saveHubSettings({ token: '' });
  set({ user: null, permissions: [] });
  await idbStore.clear();
  syncNow();
}

// The sync loop calls this when the hub says the session ended.
export const sessionEnded = () => forgetSession().then(refreshAccount);
