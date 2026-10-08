// End to end: a recorder records a scheduled meeting from a simulated stream and publishes it to a real hub.
//   npm run test:recorder        (takes a few minutes; needs php, ffmpeg, whisper.cpp, and a captured session to replay:
//                                  SIM_SESSION=<folder>, or the newest session under data/)
// In a temporary folder, with its own settings (STREAMSCRIBE_CONFIG): a PHP hub, the simulated stream (program, then a
// long "Executive Session" title card spanning the scheduled end, a little more program, then the standby slide), a
// one-minute meeting on the schedule, the recorder, and a second recorder as backup. Along the way the recorder is
// restarted mid-meeting and the hub goes down for 20 seconds. Checks:
//   - only one recorder records; it starts at the lead time; the title card doesn't stop it, the standby slide does
//   - live status, the live picture, and quick transcripts reach the hub (none lost to the outage)
//   - the final transcript and stills are published, and the recording is marked done
//   - review marks go both ways (title-card chapters to the hub; a chapter added on the hub into the local file)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { SyncClient } from '../src/sync/client.js';
import { MemoryStore } from '../src/sync/stores/memory.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const timeZone = 'America/New_York';

function findSession() {
  if (process.env.SIM_SESSION) return path.resolve(process.env.SIM_SESSION);
  const found = execFileSync('find', [path.join(repo, 'data'), '-name', 'segments.jsonl', '-path', '*/live/*'], {
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((file) => path.dirname(file))
    .filter((dir) => fs.readFileSync(path.join(dir, 'segments.jsonl'), 'utf8').split('\n').length > 60);
  if (!found.length) throw new Error('No captured session to replay; set SIM_SESSION');
  return found.sort().at(-1);
}
const localMinute = (ms) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
    .format(new Date(ms))
    .replace(', ', 'T');

test('a recorder records a scheduled meeting and publishes it', { timeout: 15 * 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-recorder-'));
  const processes = [];
  const logs = {};
  const start = (name, command, args, env = {}) => {
    const child = spawn(command, args, {
      cwd: repo,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    logs[name] = logs[name] || '';
    fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
    const onData = (chunk) => {
      logs[name] += chunk;
      fs.appendFileSync(path.join(dir, 'logs', `${name}.log`), chunk);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    processes.push(child);
    return child;
  };
  const hubPort = 47600 + Math.floor(Math.random() * 300);
  const simPort = hubPort + 400;
  const hubUrl = `http://127.0.0.1:${hubPort}/api.php`;
  let hubProcess;
  const startHub = async () => {
    hubProcess = start('hub', 'php', [
      '-d',
      'upload_max_filesize=2M',
      '-d',
      'post_max_size=8M',
      '-d',
      'max_execution_time=30',
      '-S',
      `127.0.0.1:${hubPort}`,
      '-t',
      path.join(dir, 'hub')
    ]);
    for (let i = 0; i < 50; i += 1) {
      try {
        if ((await fetch(`${hubUrl}/info`)).ok) return;
      } catch {
        /* starting */
      }
      await sleep(100);
    }
    throw new Error('hub did not start');
  };
  const recorderState = (id) => {
    const file = path.join(dir, id, 'data', 'state', `recorder-${id}.sqlite`);
    if (!fs.existsSync(file)) return null;
    try {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA busy_timeout = 5000');
      try {
        const row = db.prepare("SELECT value FROM meta WHERE name = 'recorder'").get();
        return row ? JSON.parse(row.value) : null;
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  };
  try {
    // The hub, with an editor key and a recorder key.
    fs.cpSync(path.join(repo, 'hub-php'), path.join(dir, 'hub'), { recursive: true });
    const editorKey = 'ss_e2e_editor';
    const recorderKey = 'ss_e2e_recorder';
    fs.writeFileSync(
      path.join(dir, 'hub', 'config.php'),
      `<?php return ['name' => 'e2e', 'database' => '${path.join(dir, 'hub-data', 'hub.sqlite')}', 'media_dir' => '${path.join(dir, 'hub', 'media')}', 'allowed_origins' => [], 'max_media_bytes' => 2000000, 'keys' => [['hash' => '${sha(editorKey)}', 'scope' => 'editor', 'name' => 'Editor'], ['hash' => '${sha(recorderKey)}', 'scope' => 'recorder', 'name' => 'Recorder']]];\n`
    );
    await startHub();

    // Settings for each recorder: its own data folder, the simulated source, and short overrun times.
    const writeConfig = (id) => {
      fs.mkdirSync(path.join(dir, id, 'data'), { recursive: true });
      const file = path.join(dir, id, 'config.js');
      fs.writeFileSync(
        file,
        `export default ${JSON.stringify(
          {
            dataDir: path.join(dir, id, 'data'),
            tools: {
              ffmpeg: '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg',
              ffprobe: '/opt/homebrew/opt/ffmpeg-full/bin/ffprobe'
            },
            locale: { timeZone },
            transcription: { context: 'Public meeting.' },
            http: {
              robots: { enabled: false },
              profiles: { liveMedia: { cooldownMs: 50, burst: 10 }, liveBackfill: { cooldownMs: 50, burst: 10 } }
            },
            sources: [
              {
                key: 'sim',
                name: 'Simulated meeting',
                provider: 'swagit',
                liveUrls: [`http://127.0.0.1:${simPort}/live/playlist.m3u8`]
              }
            ],
            recorder: {
              hubUrl,
              key: recorderKey,
              id,
              name: `E2E ${id}`,
              pollSeconds: 3,
              heartbeatSeconds: 3,
              thumbnailSeconds: 5,
              quickTranscribeSeconds: 60,
              maxStills: 12,
              overrun: { standbyMinutes: 0.4, idleMinutes: 1.5, capMinutes: 6 }
            }
          },
          null,
          2
        )};\n`
      );
      return file;
    };
    const mainConfig = writeConfig('main-recorder');
    // (The main recorder, as an agent, uploads its work to this test's hub through the API.)
    const agentEnv = { STREAMSCRIBE_CONFIG: mainConfig };
    const backupConfig = writeConfig('backup-recorder');

    // A one-minute meeting starting at the next whole minute at least 50 seconds away, with a 9-second lead.
    const startAt = Math.ceil((Date.now() + 50000) / 60000) * 60000;
    const editor = new SyncClient({ store: new MemoryStore(), hubUrl, key: editorKey });
    await editor.put('schedules', 'e2e-meeting', {
      title: 'E2E meeting',
      sourceKey: 'sim',
      timeZone,
      start: localMinute(startAt),
      durationMinutes: 1,
      rrule: '',
      leadMinutes: 0.15,
      preferredRecorder: 'main-recorder'
    });
    await editor.sync();
    const endAt = startAt + 60000;

    // Both recorders; the schedule prefers the main one, so the backup waits for the scheduled start and finds the
    // meeting taken.
    let mainRecorder = start('main', process.execPath, ['bin/recorder.js', '--tick-seconds', '1'], agentEnv);
    await sleep(4000);
    start('backup', process.execPath, ['bin/recorder.js', '--tick-seconds', '1'], {
      STREAMSCRIBE_CONFIG: backupConfig
    });

    // The stream starts 15 seconds before the meeting: 2 seconds per segment; program until about 13 seconds in,
    // then the title card until a second after the scheduled end, a few segments of program, then standby.
    await sleep(Math.max(0, startAt - 15000 - Date.now()));
    start(
      'sim',
      process.execPath,
      [
        'bin/simulate-hls.js',
        '--session',
        findSession(),
        '--port',
        String(simPort),
        '--plan',
        'program:20,card:25,program:3,standby',
        '--speed',
        '2',
        '--available',
        '6',
        '--renew-every',
        '15',
        '--cache',
        path.join(dir, 'sim-cache')
      ],
      { STREAMSCRIBE_CONFIG: mainConfig }
    );

    // While it records: a restart of the recorder, and the hub down for 20 seconds.
    const liveSeen = [];
    const watch = setInterval(async () => {
      try {
        const live = await (await fetch(`${hubUrl}/live`, { headers: { 'x-streamscribe-key': editorKey } })).json();
        liveSeen.push(...live.recorders.map((item) => item.status?.state + ':' + item.recorderId));
      } catch {
        /* hub down */
      }
    }, 2000);
    await sleep(Math.max(0, startAt + 15000 - Date.now()));
    mainRecorder.kill('SIGINT');
    await sleep(3000);
    mainRecorder = start('main', process.execPath, ['bin/recorder.js', '--tick-seconds', '1'], agentEnv);
    await sleep(Math.max(0, startAt + 35000 - Date.now()));
    hubProcess.kill();
    await sleep(20000);
    await startHub();

    // Wait for the recording to be published.
    const readAll = async () => {
      const client = new SyncClient({ store: new MemoryStore(), hubUrl, key: editorKey }); // meetings are private: keys see them
      await client.pull();
      return client;
    };
    let recording = null;
    for (let i = 0; i < 160 && recording?.data?.status !== 'done'; i += 1) {
      await sleep(5000);
      try {
        recording = (await (await readAll()).list('recordings'))[0] || null;
      } catch {
        /* hub restarting */
      }
    }
    clearInterval(watch);
    assert.equal(
      recording?.data?.status,
      'done',
      `recording not published; main recorder said:\n${logs.main.slice(-3000)}`
    );

    // Only the main recorder recorded; it started at the lead time; standby after the end stopped it.
    assert.equal(recording.data.recorderId, 'main-recorder');
    assert.ok(
      !fs.existsSync(path.join(dir, 'backup-recorder', 'data', 'sim', 'live')),
      'the backup recorder captured too'
    );
    assert.match(logs.backup, /being recorded by main-recorder/);
    assert.match(logs.main, /Continuing E2E meeting/);
    const started = Date.parse(recording.data.startedAt);
    assert.ok(
      started >= startAt - 9000 - 3000 && started < startAt,
      `started ${(started - startAt) / 1000}s from the scheduled start`
    );
    assert.equal(recording.data.stopReason, 'standby');
    assert.ok(Date.parse(recording.data.stoppedAt) > endAt, 'stopped before the scheduled end');
    assert.ok(recording.data.parts.length >= 1 && recording.data.durationSeconds > 0);

    // Live reports, the live picture, quick and final transcripts (quick chunks numbered without gaps), stills.
    assert.ok(liveSeen.includes('recording:main-recorder'), 'no live status while recording');
    // Meetings' pictures are private: outside the web folder (beside the database).
    const privateDir = path.join(dir, 'hub-data', 'private');
    assert.ok(fs.existsSync(path.join(privateDir, 'live', 'main-recorder.jpg')), 'no live picture');
    const hubCopy = await readAll();
    const chunks = (await hubCopy.list('transcript_chunks')).filter(
      (record) => record.data.recordingId === recording.id
    );
    const quick = chunks
      .filter((record) => record.data.kind === 'quick')
      .map((record) => Number(record.id.split('-').at(-1)))
      .sort((a, b) => a - b);
    assert.ok(quick.length >= 2, `${quick.length} quick transcript chunks`);
    assert.deepEqual(
      quick,
      quick.map((_, index) => index),
      'quick chunks went missing'
    );
    assert.ok(
      chunks.some((record) => record.data.kind === 'final' && record.data.lines.length),
      'no final transcript'
    );
    const stills = (await hubCopy.list('stills')).filter((record) => record.data.recordingId === recording.id);
    assert.ok(stills.length >= 1, 'no stills');
    assert.match(stills[0].data.path, /^private\//);
    assert.ok(
      fs.existsSync(path.join(privateDir, stills[0].data.path.slice('private/'.length))),
      'still picture missing on the hub'
    );

    // Marks: the title card's chapters reached the hub; a chapter added on the hub reaches the local file.
    const part = recording.data.parts[0];
    const agendaId = `${recording.id}:${part.name}:agenda`;
    let agenda = null;
    for (let i = 0; i < 20 && !agenda; i += 1) {
      await editor.sync();
      agenda = await editor.get('marks', agendaId);
      if (!agenda) await sleep(3000);
    }
    assert.ok(
      agenda?.data?.items?.some((item) => /Executive Session/.test(item.title)),
      `title-card chapters not on the hub: ${JSON.stringify(agenda?.data)}`
    );
    await editor.put('marks', agendaId, {
      ...agenda.data,
      items: [...agenda.data.items, { id: 'e2e-added', at: 1, title: 'Added on the hub' }]
    });
    await editor.sync();
    const localAgenda = path.join(dir, 'main-recorder', 'data', 'sim', part.dir, 'agenda.json');
    let local = null;
    for (let i = 0; i < 20; i += 1) {
      await sleep(2000);
      try {
        local = JSON.parse(fs.readFileSync(localAgenda, 'utf8'));
      } catch {
        /* not yet */
      }
      if (local?.items?.some((item) => item.id === 'e2e-added')) break;
    }
    assert.ok(
      local?.items?.some((item) => item.id === 'e2e-added'),
      'the chapter added on the hub did not reach the local file'
    );

    // Agents' work. The recorder queued its own job for the meeting's private audio and video; and a clip published on
    // the hub is cut by the agent and uploaded to the public folder.
    const published = await (
      await fetch(`${hubUrl}/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-streamscribe-key': editorKey },
        body: JSON.stringify({
          title: 'E2E clip',
          body: 'Notes about it.',
          recordingId: recording.id,
          part: part.name,
          from: 2,
          to: 14,
          clip: true,
          transcript: true,
          lines: [{ start: 3, end: 6, speaker: 'Someone', text: 'Hello there.' }]
        })
      })
    ).json();
    assert.equal(published.publication?.clip?.status, 'queued', JSON.stringify(published));
    let jobs = [];
    let clip = null;
    for (let i = 0; i < 120; i += 1) {
      await sleep(5000);
      const copy = await readAll();
      jobs = (await copy.list('jobs')).map((record) => ({ id: record.id, ...record.data }));
      clip = (await copy.get('publications', published.id))?.data?.clip;
      if (jobs.length >= 2 && jobs.every((job) => ['done', 'failed'].includes(job.status))) break;
    }
    assert.deepEqual(
      jobs.map((job) => `${job.type}:${job.status}`).sort(),
      ['clip:done', 'encode:done'],
      `jobs: ${JSON.stringify(jobs)}\nmain recorder said:\n${logs.main.slice(-2000)}`
    );
    assert.ok(jobs.every((job) => job.agent === 'main-recorder' && job.progress === 1));
    const media = (await (await readAll()).get('media', `${recording.id}:${part.name}`))?.data;
    assert.match(media.audio.path, /^private\/recordings\//);
    assert.ok(
      fs.existsSync(path.join(privateDir, media.audio.path.slice('private/'.length))),
      'private audio not uploaded'
    );
    assert.ok(
      fs.existsSync(path.join(privateDir, media.video.path.slice('private/'.length))),
      'private video not uploaded'
    );
    assert.equal(clip.status, 'ready');
    const clipFile = path.join(dir, 'hub', clip.video.path);
    assert.ok(
      fs.existsSync(clipFile) && fs.existsSync(path.join(dir, 'hub', clip.audio.path)),
      'clip files not in the public folder'
    );
    const clipSeconds = Number(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'csv=p=0',
        clipFile
      ]).toString()
    );
    assert.ok(Math.abs(clipSeconds - 12) < 0.3, `clip is ${clipSeconds}s, expected 12`);
    assert.equal((await fetch(hubUrl.replace('api.php', clip.video.path))).status, 200, 'the clip is public');
  } finally {
    for (const child of processes) child.kill('SIGINT');
    // Captures run detached; stop any the recorders left (they stop them themselves when a meeting ends).
    for (const id of ['main-recorder', 'backup-recorder']) {
      for (const recording of Object.values(recorderState(id)?.recordings || {})) {
        for (const pid of [recording.capturePid, recording.thumbnailsPid]) {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            /* gone */
          }
        }
      }
    }
    if (process.env.KEEP_E2E) console.log(`Kept ${dir}`);
    else fs.rmSync(dir, { recursive: true, force: true });
  }
});
