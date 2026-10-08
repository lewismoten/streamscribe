import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { binPath } from '../../src/config/paths.js';
import { readBody, sendJson, sendText } from '../http.ts';
import { scan } from '../context.ts';

// Jobs a review page starts on its recording, run in the background with a status file the page follows: boosting and
// re-transcribing a portion (retranscribe-range), and joining a playlist of clips into one video (render-playlist).

// POST {recording}/retranscribe with JSON { action: 'preview' | 'peaks' | 'clip' | 'transcribe' | 'remove', from, to, gainDb,
// highpassHz, normalize, denoise, quality, portionId } starts retranscribe-range in the background and answers
// { job, status } right away; the page follows {recording}/retranscribe/jobs/{job}.json. Only JSON is accepted, which
// makes browsers ask permission first for any other website's request, and this server never grants it.
export async function handleRetranscribe(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sessionDir: string
) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json'))
    return sendText(response, 415, 'Expected application/json');
  if (!fs.existsSync(path.join(sessionDir, 'segments.jsonl')))
    return sendText(response, 404, 'Not a captured session or meeting folder');
  const body = await readBody(request, 10000);
  if (!body) return sendText(response, 413, 'Too large');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(body.toString('utf8'));
  } catch {
    return sendText(response, 400, 'Not valid JSON');
  }
  const number = (value: unknown, low: number, high: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= low && parsed <= high ? parsed : null;
  };
  const scriptArgs = ['--session', sessionDir];
  if (input.action === 'remove') {
    if (!/^[a-z0-9-]{1,40}$/.test(String(input.portionId || ''))) return sendText(response, 400, 'Expected portionId');
    scriptArgs.push('--remove', String(input.portionId));
  } else if (['preview', 'transcribe', 'peaks', 'clip'].includes(String(input.action))) {
    const from = number(input.from, 0, 86400);
    const to = number(input.to, 0, 86400);
    const gain = number(input.gainDb ?? 0, -10, 40);
    const highpass = number(input.highpassHz ?? 0, 0, 500);
    if (from === null || to === null || !(to > from) || gain === null || highpass === null) {
      return sendText(response, 400, 'Expected from < to (seconds), gainDb -10..40, highpassHz 0..500');
    }
    scriptArgs.push(
      '--from',
      String(from),
      '--to',
      String(to),
      '--gain',
      String(gain),
      '--highpass',
      String(highpass),
      '--quality',
      input.quality === 'quick' ? 'quick' : 'thorough'
    );
    if (input.normalize) scriptArgs.push('--normalize');
    if (input.denoise) scriptArgs.push('--denoise');
    if (input.action === 'preview') scriptArgs.push('--preview');
    if (input.action === 'peaks') scriptArgs.push('--peaks');
    if (input.action === 'clip') scriptArgs.push('--clip', ...(input.accurate ? ['--accurate'] : []));
  } else {
    return sendText(response, 400, 'Unknown action');
  }
  const job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  scriptArgs.push('--job', job);
  const jobsDir = path.join(sessionDir, 'retranscribe', 'jobs');
  await fs.promises.mkdir(jobsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(jobsDir, `${job}.json`),
    `${JSON.stringify({ id: job, action: input.action, status: 'queued', updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
  const child = spawn(process.execPath, [binPath('retranscribe-range'), ...scriptArgs], {
    stdio: ['ignore', 'inherit', 'inherit']
  });
  child.on('error', (error) => console.error(`retranscribe job ${job}: ${error.message}`));
  // A finished transcription changes the transcript, which the next scan picks up.
  child.on('exit', () => {
    scan();
  });
  console.log(`Started ${input.action} job ${job}`);
  return sendJson(response, 202, { job, status: 'queued', statusUrl: `retranscribe/jobs/${job}.json` });
}

// POST {recording}/render-playlist with JSON { clips: [{ from, to }, ...] } (video positions) joins the clips into one
// MP4 with render-playlist, in the background; the page follows {recording}/clips/jobs/{job}.json, then downloads the
// file it names.
export async function handleRenderPlaylist(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sessionDir: string
) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json'))
    return sendText(response, 415, 'Expected application/json');
  if (!fs.existsSync(path.join(sessionDir, 'segments.jsonl')))
    return sendText(response, 404, 'Not a captured session or meeting folder');
  const body = await readBody(request, 100000);
  if (!body) return sendText(response, 413, 'Too large');
  let clips: { from: number; to: number }[];
  try {
    clips = (JSON.parse(body.toString('utf8')).clips || []).map((clip: { from: unknown; to: unknown }) => ({
      from: Number(clip.from),
      to: Number(clip.to)
    }));
  } catch {
    return sendText(response, 400, 'Not valid JSON');
  }
  if (
    clips.length === 0 ||
    clips.length > 200 ||
    clips.some((clip) => !(clip.from >= 0) || !(clip.to > clip.from) || clip.to > 86400)
  ) {
    return sendText(response, 400, 'Expected 1 to 200 clips, each with from < to (seconds)');
  }
  const job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const jobsDir = path.join(sessionDir, 'clips', 'jobs');
  await fs.promises.mkdir(jobsDir, { recursive: true });
  await fs.promises.writeFile(
    path.join(jobsDir, `${job}.json`),
    `${JSON.stringify({ id: job, status: 'queued', updatedAt: new Date().toISOString() }, null, 2)}\n`
  );
  const child = spawn(
    process.execPath,
    [
      binPath('render-playlist'),
      '--session',
      sessionDir,
      '--clips',
      clips.map((clip) => `${clip.from.toFixed(3)}-${clip.to.toFixed(3)}`).join(','),
      '--job',
      job
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  child.on('error', (error) => console.error(`playlist job ${job}: ${error.message}`));
  console.log(`Started playlist job ${job} (${clips.length} clips)`);
  return sendJson(response, 202, { job, status: 'queued', statusUrl: `clips/jobs/${job}.json` });
}
