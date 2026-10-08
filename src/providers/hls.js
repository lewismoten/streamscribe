// Any plain HLS live stream (a .m3u8 playlist). Configure its playlist address in sources[].liveUrls, or a page that
// names it in discoveryUrls. Without a provider's knowledge:
//   - pages are not crawled; a page's own playlist address (in its HTML) is used
//   - earlier and missed segments are fetched by changing the trailing number in a segment's file name
//     (segment_123.ts -> segment_122.ts, keeping zero padding); servers that name segments differently just 404
//   - with sources[].segmentPattern (a regular expression whose first group is the stream identifier and second the
//     sequence number), identifier changes are tracked like Swagit's
//   - nothing is discarded as a standby slide
export function create(source) {
  const pattern = source.segmentPattern ? new RegExp(source.segmentPattern) : null;
  return {
    name: 'hls',
    isProviderUrl: () => false,
    candidatePageUrls: () => [],
    // The page itself, so its own playlist address is found.
    playerPageUrls: (html, baseUrl) => [baseUrl],
    segmentIdentity(value) {
      if (!pattern) return null;
      try {
        const match = new URL(String(value || '')).pathname.split('/').pop().match(pattern);
        return match ? { filePrefix: match[1], identifier: match[1] } : null;
      } catch {
        return null;
      }
    },
    // Another segment's address: the same file name with the trailing number replaced.
    segmentUrl(url, sequence) {
      const match = String(url || '').match(/^(.*?)(\d+)(\.[^/?#]+)(\?[^#]*)?$/);
      if (!match) return '';
      const [, before, digits, extension, query] = match;
      return before + String(sequence).padStart(digits.length, '0') + extension + (query || '');
    },
    cleanTitle: (title) => String(title || '').trim(),
    classifySegment: async () => ({ discard: false, reason: 'not-checked', maxVolumeDb: null, samples: [] }),
    // Archives: a direct link to a video file is downloaded as is (see archiveIdFor).
    archiveVideoId: () => '',
    archiveDownloadUrl: async (url) => url
  };
}

