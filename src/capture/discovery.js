import { SOURCES } from '../config/runtime-config.js';
import { decodeHtmlEntities } from '../util/html.js';
import { safeUrl } from '../net/http.js';
import { sourceProvider } from './constants.js';
import { sanitizeSegment } from './files.js';
import { hlsFetchOptions, pageFetchOptions, fetchWithRedirectCookies } from './requests.js';

// Finding live streams: configured playlists, pages that embed a player (through the provider), and the meeting
// title on a live page.

export async function discoverLiveEntries(source, context) {
  const directPlaylistEntries = await discoverConfiguredLivePlaylists(source);
  if (directPlaylistEntries.length > 0) {
    return directPlaylistEntries;
  }

  const discovered = new Map();
  const seedUrls = getMonitorUrls(source).filter((url) => !/\.m3u8(?:\?|$)/i.test(url));
  const queue = seedUrls.slice();
  const visited = new Set();

  while (queue.length > 0) {
    const liveUrl = String(queue.shift() || '').trim();
    if (!liveUrl || visited.has(liveUrl)) {
      continue;
    }
    visited.add(liveUrl);
    context.setCurrentLabel?.(`${source.key} | discover ${visited.size}/${Math.max(queue.length + visited.size, seedUrls.length)}`);
    const fetchResult = await fetchWithRedirectCookies(liveUrl, {
      ...pageFetchOptions(),
      headers: {
        accept: 'text/html,*/*'
      }
    });
    const response = fetchResult.response;
    if (!response.ok) {
      throw new Error(`Live page returned ${response.status}: ${liveUrl}`);
    }

    const html = await response.text();
    context.onVisibleOutput?.();
    for (const candidateUrl of sourceProvider(source).candidatePageUrls(html, fetchResult.finalUrl, decodeHtmlEntities)) {
      if (!visited.has(candidateUrl) && !queue.includes(candidateUrl)) {
        queue.push(candidateUrl);
      }
    }
    for (const entry of await discoverEmbeddedLiveStreams(html, fetchResult.finalUrl, source)) {
      discovered.set(String(entry.id), entry);
    }
  }

  return Array.from(discovered.values()).sort((left, right) => String(left.id).localeCompare(String(right.id)));
}

export async function discoverConfiguredLivePlaylists(source) {
  const entries = [];
  const urls = Array.isArray(source.liveUrls) ? source.liveUrls : [];
  for (const url of urls) {
    const playlistUrl = String(url || '').trim();
    if (!/\.m3u8(?:\?|$)/i.test(playlistUrl)) {
      continue;
    }
    try {
      const fetchResult = await fetchWithRedirectCookies(playlistUrl, {
        ...hlsFetchOptions(),
        headers: {
          accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*'
        }
      });
      if (!fetchResult.response.ok) {
        continue;
      }
      const text = await fetchResult.response.text();
      if (!/^#EXTM3U/m.test(text)) {
        continue;
      }
      entries.push(buildLiveStreamEntry(fetchResult.finalUrl, source));
    } catch {
      // Fall back to the public Watch Live page when the direct endpoint is unavailable.
    }
  }
  return entries;
}

export async function discoverEmbeddedLiveStreams(html, baseUrl, source) {
  const entries = [];
  for (const playerUrl of sourceProvider(source).playerPageUrls(html, baseUrl, decodeHtmlEntities)) {
    const fetchResult = await fetchWithRedirectCookies(playerUrl, {
      ...pageFetchOptions(),
      headers: { accept: 'text/html,*/*' }
    });
    if (!fetchResult.response.ok) {
      continue;
    }
    const hlsUrl = extractHlsUrl(await fetchResult.response.text(), fetchResult.finalUrl);
    if (!hlsUrl) {
      continue;
    }
    entries.push(buildLiveStreamEntry(hlsUrl, source, fetchResult.finalUrl, baseUrl));
  }
  return entries;
}

export function buildLiveStreamEntry(hlsUrl, source, pageUrl = hlsUrl, livePageUrl = '') {
  const parsed = safeUrl(hlsUrl);
  return {
    id: `live-${sanitizeSegment(`${parsed?.hostname || 'stream'}-${parsed?.pathname || 'live'}`)}`,
    title: 'Live stream',
    duration: '',
    pageUrl,
    livePageUrl: livePageUrl || source.discoveryUrls?.[0] || '',
    hlsUrl
  };
}

export function getMonitorUrls(source) {
  return Array.from(new Set([
    ...(Array.isArray(source?.liveUrls) ? source.liveUrls : []),
    ...(Array.isArray(source?.discoveryUrls) ? source.discoveryUrls : [])
  ].map((item) => String(item || '').trim()).filter(Boolean)));
}

export async function fetchLiveVideoPage(pageUrl) {
  const fetchResult = await fetchWithRedirectCookies(pageUrl, {
    ...pageFetchOptions(),
    headers: {
      accept: 'text/html,*/*'
    }
  });
  const response = fetchResult.response;
  if (!response.ok) {
    throw new Error(`Video page returned ${response.status}`);
  }

  const html = await response.text();
  return {
    html,
    finalUrl: fetchResult.finalUrl,
    hlsUrl: extractHlsUrl(html, fetchResult.finalUrl),
    meetingTitle: extractMeetingTitle(html, pageUrl)
  };
}

export function extractHlsUrl(html, baseUrl) {
  const patterns = [
    /\{\s*type:\s*"application\/x-mpegurl"\s*,\s*src:\s*"([^"]+)"/gi,
    /source\s+src="([^"]+\.m3u8[^"]*)"/gi,
    /"([^"]+\.m3u8[^"]*)"/gi
  ];

  for (const pattern of patterns) {
    for (const match of String(html || '').matchAll(pattern)) {
      const candidate = String(match[1] || '').trim().replace(/\\\//g, '/');
      if (!candidate || !/\.m3u8\b/i.test(candidate)) {
        continue;
      }

      try {
        return new URL(candidate, baseUrl).toString();
      } catch {
        continue;
      }
    }
  }

  return '';
}

export function extractAnchorText(html) {
  const match = String(html || '').match(/<a[^>]*>([\s\S]*?)<\/a>/i);
  return match ? match[1] : html;
}

export function cleanInlineText(value) {
  return decodeHtmlEntities(String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

export function extractMeetingTitle(html, pageUrl) {
  const match = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const source = SOURCES.find((item) => sourceProvider(item).isProviderUrl(safeUrl(pageUrl))) || SOURCES[0];
  return match ? sourceProvider(source).cleanTitle(decodeHtmlEntities(match[1])) : '';
}
