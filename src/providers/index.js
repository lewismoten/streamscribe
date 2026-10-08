import * as swagit from './swagit/index.js';
import { create as createHls } from './hls.js';

// The provider for a source: what capture and archive backfill need to know about its streaming service.
export function providerFor(source) {
  if (source?.provider === 'swagit') {
    return swagit;
  }
  return createHls(source || {});
}

// The folder name for an archived copy of a meeting: --id if given, else the provider's video id from its page address
// (Swagit's /videos/<id>), else the file name of a video link or local file.
export function archiveIdFor({ id = '', url = '', file = '' }, source) {
  const fromName = (value) =>
    String(value || '')
      .split(/[\\/]/)
      .pop()
      .replace(/\?.*$/, '')
      .replace(/\.[^.]+$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  return String(id || '').trim() || (url && providerFor(source).archiveVideoId(url)) || fromName(file || url);
}
