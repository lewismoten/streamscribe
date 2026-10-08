// Where the hub is, and how this browser speaks to it: a signed-in person's session token, or a key (for scripts and
// recorders' own pages). Kept only in this browser (never in the site's files), so the site can be public while only
// people allowed to can change things.
//
// A site built with VITE_HUB_URL starts out pointed at that hub (relative addresses, such as hub/api.php on the hub's
// own server, are taken from the page's address); anyone can point it elsewhere, or at nothing, under Settings.
export interface HubSettings {
  url: string;
  key: string;
  token: string;
}

const KEY = 'streamscribe.hub';
const builtIn = String(import.meta.env.VITE_HUB_URL || '').trim();

function resolve(url: string) {
  if (!url) return '';
  try { return new URL(url, location.href).href.replace(/\/+$/, ''); } catch { return url; }
}

export const defaultHubUrl = () => resolve(builtIn);

export function hubSettings(): HubSettings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!value) return { url: defaultHubUrl(), key: '', token: '' };
    return { url: resolve(String(value.url || '')), key: String(value.key || ''), token: String(value.token || '') };
  } catch {
    return { url: defaultHubUrl(), key: '', token: '' };
  }
}

export function saveHubSettings(settings: Partial<HubSettings>) {
  const next = { ...hubSettings(), ...settings };
  localStorage.setItem(KEY, JSON.stringify({ url: next.url.trim().replace(/\/+$/, ''), key: next.key.trim(), token: next.token }));
}

// The hub's folder (published files are under it, at media/…): the API address without api.php.
export const hubBase = (url = hubSettings().url) => url.replace(/api\.php$/, '');

// Meetings' files are private (private/…): served through the API with a signature that expires, which viewers who
// may see meetings get after signing in (account.ts keeps it fresh).
let fileKey: { e: number; s: string } | null = null;
export const setFileKey = (key: { e: number; s: string } | null) => { fileKey = key; };
export const mediaUrl = (path: string, url = hubSettings().url) => {
  if (!path) return '';
  if (!path.startsWith('private/')) return hubBase(url) + path;
  return fileKey ? `${url}/file/${path.split('/').map(encodeURIComponent).join('/')}?e=${fileKey.e}&s=${fileKey.s}` : '';
};

// A call to the hub's API with this browser's session or key. Throws the hub's message on failure.
export async function hubCall<T = Record<string, unknown>>(route: string, body?: unknown): Promise<T> {
  const { url, key, token } = hubSettings();
  if (!url) throw new Error('No hub set (Settings)');
  const response = await fetch(`${url}/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    cache: 'no-store',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { 'x-streamscribe-token': token } : key ? { 'x-streamscribe-key': key } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(value.error || `The hub answered ${response.status}`), { status: response.status });
  return value as T;
}
