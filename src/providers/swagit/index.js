import { execFile as execFileCallback } from 'child_process';
import { promisify } from 'util';
import { TOOLS } from '../../config/runtime-config.js';

const execFileAsync = promisify(execFileCallback);

// Swagit (swagit.com), the streaming service many local governments use. What capture needs to know about it:
//   - Discovery: a government page (often CivicPlus) embeds Swagit views; a view embeds a media.swagit.com player whose
//     page names the HLS playlist.
//   - Segment names are media-<identifier>_<sequence>.ts. Swagit renews the identifier about hourly (skipping one
//     sequence number) and serves any sequence under any identifier, so earlier and missed segments can be fetched by
//     name for a few minutes.
//   - Between meetings it streams a silent standby slide (the locality's seal on black), which is not worth keeping.
//   - Archived meetings are pages like https://<site>.swagit.com/videos/<id> with a download link.
export const name = 'swagit';

export function isProviderUrl(url) {
  return /(?:^|\.)swagit\.com$/i.test(String(url?.hostname || ''));
}

// Pages to follow from a discovery page. A CivicPlus page includes its whole site navigation, so only links or embeds
// that lead to Swagit views are followed (other listing pages belong in liveUrls).
export function candidatePageUrls(html, baseUrl, decodeHtmlEntities) {
  const urls = new Set();
  for (const match of String(html || '').matchAll(/<(?:a|iframe)\b[^>]+(?:href|src)="([^"]+)"/gi)) {
    const href = String(match[1] || '').trim();
    if (!href || href.startsWith('#') || /^javascript:/i.test(href)) {
      continue;
    }
    let absolute;
    try {
      absolute = new URL(decodeHtmlEntities(href), baseUrl);
    } catch {
      continue;
    }
    if (!isProviderUrl(absolute)) {
      continue;
    }
    const pathname = absolute.pathname.replace(/\/+$/g, '') || '/';
    if (/^\/views\/\d+$/i.test(pathname)) {
      absolute.hash = '';
      urls.add(absolute.toString());
    }
  }
  return Array.from(urls);
}

// Live player pages embedded in a page (each names an HLS playlist).
export function playerPageUrls(html, baseUrl, decodeHtmlEntities) {
  const urls = new Set();
  for (const match of String(html || '').matchAll(/<iframe\b[^>]+src="([^"]+)"/gi)) {
    try {
      const url = new URL(decodeHtmlEntities(match[1]), baseUrl);
      if (/^media\.swagit\.com$/i.test(url.hostname) && /\/play\/fp\/?$/i.test(url.pathname)) {
        urls.add(url.toString());
      }
    } catch {
      // Ignore malformed embeds.
    }
  }
  return Array.from(urls);
}

// The stream identifier in a segment address: { filePrefix: 'media-<id>', identifier: '<id>' }, or null.
export function segmentIdentity(value) {
  try {
    const match = new URL(String(value || '')).pathname.match(/\/(media-([^_/?]+))_(\d+)\.ts$/i);
    return match ? { filePrefix: match[1], identifier: match[2] } : null;
  } catch {
    return null;
  }
}

// The address of another segment of the same stream: `sequence`, optionally under another identifier's prefix.
export function segmentUrl(url, sequence, filePrefix = '') {
  if (!/_(\d+)(\.[^/?]+)(\?[^#]*)?$/.test(String(url || ''))) {
    return '';
  }
  const renamed = filePrefix ? url.replace(/media-[A-Za-z0-9]+_/, `${filePrefix}_`) : url;
  return renamed.replace(/_(\d+)(\.[^/?]+)(\?[^#]*)?$/, `_${sequence}$2$3`);
}

export function cleanTitle(title) {
  return String(title || '').replace(/\s*\|\s*Swagit.*$/i, '').trim();
}

// Whether a segment is the silent standby slide: digital silence, and in three frames the black rails and seal of the
// standby picture (points are proportions of the frame).
const standbySilenceDb = -90;
const blackBelow = 60;
const sealAtLeast = 65;
export async function classifySegment(filePath, durationSeconds, { readMaxVolumeDb }) {
  const maxVolumeDb = await readMaxVolumeDb(filePath);
  if (!Number.isFinite(maxVolumeDb) || maxVolumeDb > standbySilenceDb) {
    return { discard: false, reason: 'audible-or-unreadable-audio', maxVolumeDb, samples: [] };
  }
  const signature = await readStandbySignature(filePath, durationSeconds);
  return {
    discard: signature.allSamplesMatch,
    reason: signature.allSamplesMatch ? 'silent-persistent-slide-signature' : 'no-persistent-slide-signature',
    maxVolumeDb,
    samples: signature.samples
  };
}

async function readStandbySignature(filePath, durationSeconds) {
  // Four rail corners, four black points outside the seal, and four non-black points inside the seal.
  const railPoints = [[0.02, 0.02], [0.20, 0.02], [0.02, 0.98], [0.20, 0.98]];
  const outsideSealPoints = [[0.015, 0.50], [0.215, 0.50], [0.12, 0.30], [0.12, 0.70]];
  const insideSealPoints = [[0.12, 0.45], [0.12, 0.55], [0.075, 0.50], [0.165, 0.50]];
  const width = 320;
  const height = 180;
  const frameSize = width * height * 3;
  try {
    const duration = Math.max(1, Number(durationSeconds || 10));
    const { stdout } = await execFileAsync(TOOLS.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-i', filePath,
      '-vf', `fps=3/${duration},scale=${width}:${height}:flags=area,format=rgb24`, '-f', 'rawvideo', '-'
    ], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
    const data = Buffer.from(stdout || '');
    const samples = [];
    for (let offset = 0; offset + frameSize <= data.length && samples.length < 3; offset += frameSize) {
      const luminance = ([xRatio, yRatio]) => {
        const x = Math.min(width - 1, Math.max(0, Math.round(xRatio * (width - 1))));
        const y = Math.min(height - 1, Math.max(0, Math.round(yRatio * (height - 1))));
        const pixel = offset + ((y * width + x) * 3);
        return Math.round((data[pixel] + data[pixel + 1] + data[pixel + 2]) / 3);
      };
      const blackPointValues = [...railPoints, ...outsideSealPoints].map(luminance);
      const sealPointValues = insideSealPoints.map(luminance);
      samples.push({
        sample: ['start', 'middle', 'end'][samples.length],
        blackPointValues,
        sealPointValues,
        matches: blackPointValues.every((value) => value < blackBelow) && sealPointValues.every((value) => value >= sealAtLeast)
      });
    }
    return { samples, allSamplesMatch: samples.length === 3 && samples.every((sample) => sample.matches) };
  } catch {
    return { samples: [], allSamplesMatch: false };
  }
}

// Archived meetings: pages like https://<site>.swagit.com/videos/<id>. The id names the archive folder, and the page's
// /download address redirects to the video file (a signed, one-hour link).
export function archiveVideoId(url) {
  return String(url || '').match(/\/videos\/(\d+)/)?.[1] || '';
}

export async function archiveDownloadUrl(pageUrl, videoId, fetchWithDefaults) {
  const downloadPage = new URL(`/videos/${videoId}/download`, pageUrl).toString();
  const response = await fetchWithDefaults(downloadPage, { redirect: 'manual', quiet: true });
  const location = response.headers.get('location');
  if (!location) {
    throw new Error(`${downloadPage} did not redirect to a video file (status ${response.status})`);
  }
  return new URL(location, downloadPage).toString();
}
