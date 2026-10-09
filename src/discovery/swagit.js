import { datesIn, decode, minutesOf, plain } from './text.js';

// A Swagit site's archive (any site: its address is configuration): the archive pages (/views/<n>/, found from the
// site's front page, or given) list every video by category and year; each video's page has its chapters (index
// items with times), its automated transcript (words with times), its agenda, and the address of its stream.
const ok = async (fetcher, url) => {
  const response = await fetcher(url, { headers: { accept: 'text/html,*/*' } });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return { html: await response.text(), url: response.url || url };
};

// The archive pages of a site: given, or linked (or framed) from its front page.
export function archivePages(html, baseUrl) {
  const pages = new Set();
  for (const match of String(html || '').matchAll(/(?:href|src)="([^"]*\/views\/\d+\/?)"/gi))
    pages.add(new URL(decode(match[1]), baseUrl).toString());
  return [...pages];
}

// The videos an archive page lists: id, category, year, title, date, and length.
export function archiveVideos(html, baseUrl) {
  const videos = [];
  const categories =
    /<button[^>]*aria-controls="collapse[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/button>([\s\S]*?)(?=<h4 class="panel-title">|$)/gi;
  for (const category of String(html || '').matchAll(categories)) {
    for (const year of category[2].matchAll(
      /<div role="tabpanel"[^>]*id="[^"]*-(\d{4})"[^>]*>[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/gi
    )) {
      for (const row of year[2].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
        const link = row[1].match(/href="([^"]*\/videos\/(\d+)[^"]*)"/i);
        if (!link) continue;
        const cells = [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((cell) => cell[1]);
        videos.push({
          videoId: Number(link[2]),
          category: plain(category[1]),
          title: plain(cells[0] || ''),
          date: datesIn(plain(cells[1] || ''))[0]?.date || null,
          durationMinutes: minutesOf(plain(cells[2] || '')),
          url: new URL(`/videos/${link[2]}`, baseUrl).toString()
        });
      }
    }
  }
  return videos;
}

// Every video of a site: its archive pages (feed.views, else found from feed.base), each read once.
export async function discoverSwagit(feed, fetcher) {
  const base = String(feed.base).replace(/\/+$/, '');
  const pages = feed.views?.length
    ? feed.views.map((view) => `${base}/views/${view}/`)
    : archivePages((await ok(fetcher, `${base}/`)).html, `${base}/`);
  const found = new Map();
  for (const page of pages) {
    const { html, url } = await ok(fetcher, page);
    for (const video of archiveVideos(html, url)) found.set(video.videoId, { ...found.get(video.videoId), ...video });
  }
  return [...found.values()].map((video) => ({
    key: `swagit:${new URL(base).host}:${video.videoId}`,
    provider: 'swagit',
    title: video.title || video.category,
    category: video.category,
    date: video.date,
    time: null,
    durationMinutes: video.durationMinutes,
    url: video.url,
    official: { swagit: { base, videoId: String(video.videoId) } }
  }));
}

// A video's page: its chapters, its transcript's words (with sections), its agenda, and its stream's address.
export function videoPage(html, baseUrl) {
  const chapters = [];
  for (const match of String(html || '').matchAll(
    /<a class="playerControl"[^>]*data-id="([^"]+)"[^>]*data-ts="([^"]+)"[^>]*data-end-ts="([^"]+)"[^>]*data-title="([^"]*)"/gi
  ))
    chapters.push({
      id: match[1],
      at: Number(match[2]) || 0,
      to: Number(match[3]) || 0,
      title: decode(match[4]).trim()
    });
  const words = [];
  const block = String(html || '').match(/<div id="transcript-fragments">([\s\S]*?)<!-- \/transcript -->/i)?.[1] || '';
  // (Attributes are read whole, quotes and all: a label can hold a ">".)
  const attributes = `(?:[^>"']|"[^"]*"|'[^']*')*`;
  const pattern = new RegExp(
    `<a\\b${attributes}data-ts="([^"]+)"${attributes}>([\\s\\S]*?)<\\/a>|<b>\\[([\\s\\S]*?)\\]<\\/b>`,
    'gi'
  );
  for (const match of block.matchAll(pattern)) {
    if (match[1]) {
      const text = plain(match[2]);
      if (text) words.push({ at: Number(match[1]) || 0, text });
    } else if (match[3]) words.push({ section: plain(match[3]) });
  }
  const stream = String(html || '').match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/)?.[0] || null;
  // (The agenda's address can come wrapped in a viewer's: ?url=<the PDF>.)
  const found = String(html || '').match(/https?:\/\/[^"'<>\\\s]+agenda_file[^"'<>\\\s]+\.pdf/i)?.[0] || null;
  const wrapped = found && decode(found).match(/[?&]url=([^&]+)/);
  const agenda = found ? (wrapped ? decodeURIComponent(wrapped[1]) : decode(found)) : null;
  return { chapters, words, stream, agenda, baseUrl };
}

export async function swagitVideo(official, fetcher) {
  const { html, url } = await ok(fetcher, `${official.base}/videos/${official.videoId}`);
  return videoPage(html, url);
}

// Captions written in capitals, in sentence case: lower case, then a capital at each sentence's start and for "I".
export const sentenceCase = (text) =>
  /[a-z]/.test(text)
    ? text
    : text
        .toLowerCase()
        .replace(/(^|[.?!]\s+)([a-z])/g, (_, before, letter) => before + letter.toUpperCase())
        .replace(/\bi\b/g, 'I')
        .replace(/\bi'/g, "I'");

// Words into transcript lines: a new line at each section, after a sentence ends, at a pause of two seconds, or at
// twenty words; each line { start, end, text } (in sentence case when the captions are in capitals).
export function linesOf(words) {
  const lines = [];
  let line = null;
  const close = (end) => {
    if (line?.words.length)
      lines.push({ start: line.start, end: end ?? line.last, text: sentenceCase(line.words.join(' ')) });
    line = null;
  };
  for (const word of words) {
    if (word.section) {
      close();
      continue;
    }
    if (line && (word.at - line.last > 2 || line.words.length >= 20)) close(word.at);
    if (!line) line = { start: word.at, last: word.at, words: [] };
    line.words.push(word.text);
    line.last = word.at;
    if (/[.?!]$/.test(word.text) && line.words.length >= 4) close(word.at + 0.5);
  }
  close();
  return lines.map((item) => ({ ...item, end: Math.max(item.end, item.start + 0.5) }));
}
