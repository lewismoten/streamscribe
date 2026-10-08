// Where the hub is and this browser's editor key. Kept only in this browser (never in the site's files), so the static
// site can be public while only people with a key can change things.
export interface HubSettings {
  url: string;
  key: string;
}

const KEY = 'streamscribe.hub';

export function hubSettings(): HubSettings {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { url: String(value.url || ''), key: String(value.key || '') };
  } catch {
    return { url: '', key: '' };
  }
}

export function saveHubSettings(settings: HubSettings) {
  localStorage.setItem(KEY, JSON.stringify({ url: settings.url.trim().replace(/\/+$/, ''), key: settings.key.trim() }));
}

// The hub's folder (pictures are under it, at media/…): the API address without api.php.
export const hubBase = (url = hubSettings().url) => url.replace(/api\.php$/, '');
export const mediaUrl = (path: string, url = hubSettings().url) => (path ? hubBase(url) + path : '');
