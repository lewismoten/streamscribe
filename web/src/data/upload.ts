import { hubSettings } from './hub.ts';

// A picture sent to the hub's private store (for a video's layers), by its sha256 (a picture already there isn't
// stored twice). Returns its path as records name it (private/stills/…), and its size in pixels.
export async function uploadPicture(file: File) {
  const { url, key, token } = hubSettings();
  if (!url) throw new Error('No hub set (Settings)');
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('JPEG, PNG, or WebP pictures');
  const bytes = await file.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const size = await new Promise<{ width: number; height: number }>((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 0, height: 0 });
    image.src = URL.createObjectURL(file);
  });
  const response = await fetch(`${url}/media?sha256=${hash}&type=${encodeURIComponent(file.type)}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      ...(token ? { 'x-streamscribe-token': token } : key ? { 'x-streamscribe-key': key } : {})
    },
    body: bytes
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `The hub answered ${response.status}`);
  return { path: value.path as string, ...size };
}
