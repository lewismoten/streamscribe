import { spawnSync } from 'child_process';
import { datesIn, decode } from './text.js';

// A YouTube channel's videos whose titles match (feed.match, a regular expression such as "Trustee|Meeting"): with
// yt-dlp when the agent has it (every video), else the channel's feed (its latest 15). A meeting's date is the date
// in its title, else when it was published.
async function channelId(channel, fetcher) {
  if (/^UC[\w-]{22}$/.test(channel)) return channel;
  const response = await fetcher(channel, { headers: { accept: 'text/html' } });
  const html = await response.text();
  return html.match(/"channelId":"(UC[\w-]{22})"/)?.[1] || html.match(/channel_id=(UC[\w-]{22})/)?.[1] || null;
}

function withYtDlp(channel) {
  const done = spawnSync('yt-dlp', ['--flat-playlist', '-J', `${channel.replace(/\/+$/, '')}/videos`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  if (done.status !== 0 || !done.stdout) return null;
  return (JSON.parse(done.stdout).entries || []).map((entry) => ({
    videoId: entry.id,
    title: entry.title || '',
    published: entry.upload_date
      ? `${entry.upload_date.slice(0, 4)}-${entry.upload_date.slice(4, 6)}-${entry.upload_date.slice(6, 8)}`
      : null,
    durationMinutes: entry.duration ? Math.round(entry.duration / 60) : null
  }));
}

export async function discoverYoutube(feed, fetcher) {
  const match = new RegExp(feed.match || '.', 'i');
  let videos = withYtDlp(feed.channel);
  if (!videos) {
    const id = await channelId(feed.channel, fetcher);
    if (!id) throw new Error(`No channel id found at ${feed.channel}`);
    const xml = await (await fetcher(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`)).text();
    videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((entry) => ({
      videoId: entry[1].match(/<yt:videoId>([^<]+)/)?.[1],
      title: decode(entry[1].match(/<title>([^<]*)/)?.[1] || ''),
      published: entry[1].match(/<published>(\d{4}-\d{2}-\d{2})/)?.[1] || null,
      durationMinutes: null
    }));
  }
  return videos
    .filter((video) => video.videoId && match.test(video.title))
    .map((video) => ({
      key: `youtube:${video.videoId}`,
      provider: 'youtube',
      title: video.title,
      category: feed.category || '',
      date: datesIn(video.title)[0]?.date || video.published,
      time: feed.time || null,
      durationMinutes: video.durationMinutes,
      url: `https://www.youtube.com/watch?v=${video.videoId}`,
      official: { video: { url: `https://www.youtube.com/watch?v=${video.videoId}`, param: 't' } }
    }));
}
