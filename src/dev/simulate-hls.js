import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { TOOLS } from '../config/runtime-config.js';
import { runCommand } from '../util/process.js';

// A simulated live meeting stream for testing capture and recorders without waiting for a real meeting. It serves a
// Swagit-style live playlist (media-<identifier>_<sequence>.ts, a sliding window of the newest segments, earlier ones
// still fetchable by name) that follows a plan:
//   program:N   N real segments from a saved session, in order
//   card:N      a still title card ("Executive Session") with the microphones off: frozen picture, near silence
//   standby:N   the standby slide between meetings: a seal on black, digital silence (what capture discards)
// The last part of the plan repeats forever if it has no count. Time runs faster than real time (--speed seconds per
// 10-second segment).
//   npm run simulate-hls -- --session <folder> [--port 47811] [--plan program:12,card:6,program:6,standby]
//     [--speed 1] [--renew-every 0] [--first-sequence 1000] [--available 30]
// Point a source at it: { key: 'sim', provider: 'swagit', liveUrls: ['http://127.0.0.1:47811/live/playlist.m3u8'] }.

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = path.resolve(options.session);
  const real = fs
    .readFileSync(path.join(sessionDir, 'segments.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .map((item) => ({ file: path.join(sessionDir, 'segments', item.fileName), duration: item.durationSeconds }))
    .filter((item) => fs.existsSync(item.file));
  if (real.length === 0) throw new Error(`No segments in ${sessionDir}`);
  const templates = await makeTemplates(real[0].file, options);
  // Which segment each sequence number is, by the plan (the last part repeats if it has no count).
  let realIndex = 0;
  const assigned = new Map();
  const segmentFor = (sequence) => {
    if (assigned.has(sequence)) return assigned.get(sequence);
    let offset = sequence - options.firstSequence;
    let kind = options.plan.at(-1).kind;
    for (const part of options.plan) {
      if (part.count === null || offset < part.count) {
        kind = part.kind;
        break;
      }
      offset -= part.count;
    }
    let segment;
    if (kind === 'program') segment = real[realIndex++ % real.length];
    else segment = { file: templates[kind], duration: 10 };
    const value = { ...segment, kind };
    assigned.set(sequence, value);
    return value;
  };
  for (
    let sequence = options.firstSequence;
    sequence < options.firstSequence + 2000 && assigned.size < 2000;
    sequence += 1
  )
    segmentFor(sequence);
  const started = Date.now();
  const newest = () =>
    options.firstSequence + options.available + Math.floor((Date.now() - started) / (options.speed * 1000));
  const identifier = (sequence) =>
    `sim${options.renewEvery ? Math.floor((sequence - options.firstSequence) / options.renewEvery) : 0}x`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/live/playlist.m3u8') {
      const last = newest();
      const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:11', `#EXT-X-MEDIA-SEQUENCE:${last - 5}`];
      for (let sequence = last - 5; sequence <= last; sequence += 1) {
        lines.push(
          `#EXTINF:${segmentFor(sequence).duration.toFixed(3)},`,
          `media-${identifier(sequence)}_${sequence}.ts`
        );
      }
      response.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-cache' });
      response.end(lines.join('\n') + '\n');
      return;
    }
    const match = url.pathname.match(/^\/live\/media-[a-z0-9]+_(\d+)\.ts$/);
    const sequence = match ? Number(match[1]) : -1;
    // Like Swagit: any identifier serves any sequence, from a little before the window up to the newest.
    if (sequence >= options.firstSequence && sequence <= newest()) {
      const file = segmentFor(sequence).file;
      response.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(response);
      return;
    }
    if (url.pathname === '/status') {
      const last = newest();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ newest: last, kind: segmentFor(last).kind, identifier: identifier(last) }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(options.port, '127.0.0.1', () => {
    console.log(
      `Simulated stream at http://127.0.0.1:${options.port}/live/playlist.m3u8 (plan ${options.plan.map((part) => part.kind + (part.count === null ? '' : ':' + part.count)).join(',')}, ${options.speed}s per segment)`
    );
  });
  const stop = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// The title card and standby slide, made from a real segment so they match its video and audio format.
async function makeTemplates(sample, options) {
  const dir = options.cache || path.join(os.tmpdir(), 'streamscribe-simulate-hls');
  fs.mkdirSync(dir, { recursive: true });
  const make = async (name, videoFilter, volume) => {
    const target = path.join(dir, `${name}.ts`);
    if (!fs.existsSync(target)) {
      // Every stream of the sample in its order (Swagit's carry a timed ID3 stream first), or joined playlists of real
      // and made segments read the wrong packets as video.
      await runCommand(TOOLS.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        sample,
        '-map',
        '0',
        '-vf',
        videoFilter,
        '-af',
        `volume=${volume}`,
        '-c:v',
        'libx264',
        '-profile:v',
        'baseline',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-c:d',
        'copy',
        '-f',
        'mpegts',
        `${target}.tmp`
      ]);
      fs.renameSync(`${target}.tmp`, target);
    }
    return target;
  };
  return {
    // Light blue with a darker band, and the words, all still; the microphones off but not digital silence.
    card: await make(
      'card',
      "drawbox=color=0xD3DFEE:t=fill,drawbox=y=0:w=iw:h=ih*0.14:color=0x2E4A7D:t=fill,drawbox=y=ih*0.86:w=iw:h=ih*0.14:color=0x2E4A7D:t=fill,drawtext=text='Executive Session':fontcolor=0x2E4A7D:fontsize=h/9:x=(w-text_w)/2:y=(h-text_h)/2",
      '0.0004'
    ),
    // Black with a light seal on the left rail, as Swagit's standby slide is recognized; digital silence.
    standby: await make(
      'standby',
      'drawbox=color=black:t=fill,drawbox=x=iw*0.06:y=ih*0.38:w=iw*0.12:h=ih*0.24:color=0xC8C8B4:t=fill',
      '0'
    )
  };
}

function parseArgs(argv) {
  const options = {
    session: '',
    port: 47811,
    plan: 'program:12,card:6,program:6,standby',
    speed: 1,
    renewEvery: 0,
    firstSequence: 1000,
    available: 30,
    cache: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--session') options.session = next();
    else if (arg === '--port') options.port = Number(next());
    else if (arg === '--plan') options.plan = next();
    else if (arg === '--speed') options.speed = Number(next());
    else if (arg === '--renew-every') options.renewEvery = Number(next());
    else if (arg === '--first-sequence') options.firstSequence = Number(next());
    else if (arg === '--available') options.available = Number(next());
    else if (arg === '--cache') options.cache = next();
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.session) throw new Error('Expected --session <folder with segments>');
  options.plan = options.plan.split(',').map((part) => {
    const [kind, count] = part.split(':');
    if (!['program', 'card', 'standby'].includes(kind))
      throw new Error(`Unknown plan part ${kind} (program, card, or standby)`);
    return { kind, count: count === undefined ? null : Number(count) };
  });
  return options;
}

// Started by bin/simulate-hls.js.
export const run = () =>
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
