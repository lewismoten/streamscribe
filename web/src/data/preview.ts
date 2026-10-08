// An admin's preview of the public view: the app shows what a signed-out visitor sees (a signed-out copy of the hub's
// records, and no permissions) until the admin switches back. Kept for the tab only (sessionStorage).
const KEY = 'streamscribe.previewPublic';
const listeners = new Set<() => void>();
let previewing = (() => {
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
})();

export const isPreviewing = () => previewing;

export function setPreviewing(on: boolean) {
  if (on === previewing) return;
  previewing = on;
  try {
    if (on) sessionStorage.setItem(KEY, '1');
    else sessionStorage.removeItem(KEY);
  } catch {
    /* kept in memory only */
  }
  for (const listener of listeners) listener();
}

export function onPreviewChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
