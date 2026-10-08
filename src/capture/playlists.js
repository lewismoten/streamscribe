import { hlsFetchOptions, fetchWithRedirectCookies } from './requests.js';

// HLS playlists: the variant (master) playlist that names the stream, and the media playlist that lists segments.

export async function resolveHlsStream(hlsUrl) {
  const fetchResult = await fetchWithRedirectCookies(hlsUrl, {
    ...hlsFetchOptions(),
    headers: {
      accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*'
    }
  });
  const response = fetchResult.response;
  if (!response.ok) {
    throw new Error(`HLS playlist returned ${response.status}`);
  }

  const masterPlaylistText = await response.text();
  const finalUrl = fetchResult.finalUrl;
  if (/#EXT-X-STREAM-INF/i.test(masterPlaylistText)) {
    const variants = parseVariantPlaylist(masterPlaylistText, finalUrl);
    if (variants.length === 0) {
      throw new Error('No variant playlists were found in the HLS master playlist');
    }

    variants.sort((left, right) => right.bandwidth - left.bandwidth);
    const selected = variants[0];
    const media = await fetchMediaPlaylist(selected.url);
    return {
      masterPlaylistUrl: finalUrl,
      masterPlaylistText,
      mediaPlaylistUrl: selected.url,
      mediaPlaylistText: media.text,
      endList: media.endList
    };
  }

  return {
    masterPlaylistUrl: '',
    masterPlaylistText,
    mediaPlaylistUrl: finalUrl,
    mediaPlaylistText: masterPlaylistText,
    endList: /#EXT-X-ENDLIST/i.test(masterPlaylistText)
  };
}

export function parseVariantPlaylist(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const variants = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('#EXT-X-STREAM-INF')) {
      continue;
    }

    const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/i);
    let nextIndex = index + 1;
    while (nextIndex < lines.length && (!lines[nextIndex] || lines[nextIndex].startsWith('#'))) {
      nextIndex += 1;
    }

    if (nextIndex >= lines.length) {
      continue;
    }

    const nextLine = lines[nextIndex].trim();
    try {
      variants.push({
        bandwidth: Number(bandwidthMatch?.[1] || 0),
        url: new URL(nextLine, baseUrl).toString()
      });
    } catch {
      continue;
    }
  }

  return variants;
}

export async function fetchMediaPlaylist(url) {
  const fetchResult = await fetchWithRedirectCookies(url, {
    ...hlsFetchOptions(),
    headers: {
      accept: 'application/x-mpegURL,application/vnd.apple.mpegurl,text/plain,*/*'
    }
  });
  const response = fetchResult.response;
  if (!response.ok) {
    throw new Error(`Media playlist returned ${response.status}`);
  }

  const text = await response.text();
  return {
    url: fetchResult.finalUrl,
    text,
    endList: /#EXT-X-ENDLIST/i.test(text),
    segments: parseMediaPlaylistSegments(text, fetchResult.finalUrl)
  };
}

export function parseMediaPlaylistSegments(text, baseUrl) {
  const lines = String(text || '').split(/\r?\n/);
  const segments = [];
  let nextDuration = 0;
  let mediaSequence = 0;
  let sequenceOffset = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number.parseInt(line.split(':')[1], 10) || 0;
      sequenceOffset = 0;
      continue;
    }

    if (line.startsWith('#EXTINF:')) {
      nextDuration = Number.parseFloat(line.slice('#EXTINF:'.length)) || 0;
      continue;
    }

    if (line.startsWith('#')) {
      continue;
    }

    const absoluteUrl = new URL(line, baseUrl).toString();
    const sequence = mediaSequence + sequenceOffset;
    sequenceOffset += 1;
    segments.push({
      sequence,
      durationSeconds: nextDuration,
      url: absoluteUrl,
      key: `${sequence}|${absoluteUrl}`
    });
    nextDuration = 0;
  }

  return segments;
}
