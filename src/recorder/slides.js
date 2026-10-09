import fs from 'fs';
import path from 'path';
import { uploadMedia } from './hub-api.js';

// A meeting part's slides (extract-slides; their text from ocr-slides) to the hub: each picture to the private store
// and a `slides` record (id <recording>:<part>:<file name>) with when it was shown and its text. A slide the hub has
// already, with the same text, isn't sent again. Returns how many were sent.
export async function sendSlides(client, { recordingId, part, dir, dryRun = false }) {
  const index = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'slides', 'slides.json'), 'utf8'));
    } catch {
      return null;
    }
  })();
  let sent = 0;
  for (const slide of index?.slides || []) {
    const file = path.join(dir, 'slides', slide.fileName);
    if (!fs.existsSync(file)) continue;
    const id = `${recordingId}:${part}:${slide.fileName.replace(/\.[^.]+$/, '')}`;
    const shows = (slide.showings || []).map((showing) => ({
      at: Math.round(showing.startSeconds * 10) / 10,
      seconds: Math.round((showing.durationSeconds || 0) * 10) / 10
    }));
    const existing = (await client.get('slides', id))?.data;
    if (existing && existing.text === (slide.text ?? null) && JSON.stringify(existing.shows) === JSON.stringify(shows))
      continue;
    sent += 1;
    if (dryRun) continue;
    const media = existing?.path
      ? { path: existing.path, sha256: existing.sha256 }
      : await uploadMedia(file, 'image/png');
    await client.put('slides', id, {
      recordingId,
      part,
      fileName: slide.fileName,
      path: media.path,
      sha256: media.sha256,
      shows,
      text: slide.text ?? null,
      textModel: slide.textModel || null
    });
  }
  return sent;
}
