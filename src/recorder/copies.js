import fs from 'fs';
import path from 'path';
import { DATA_ROOT, RECORDER, SOURCES } from '../config/runtime-config.js';
import { byNearness, mirrorRecording } from './peers.js';

// A storage agent: one with lots of space, told on the hub's Agents page to keep a copy of every recording
// (agent_settings keepsCopies, in copiesDir or its data folder's copies/). Every ten minutes it looks at the hub's
// recordings and copies, one part at a time, each finished one it doesn't have from whichever agent has it (nearest
// first; never through a relay), resuming where it stopped. Its copies are recordings like its own: the jobs find them,
// and the other agents fetch from it (peer-server.js), so a recorder's copy can come and go while the recording stays
// available. It stops copying while its drive has less than recorder.minFreeGb free.
// Kept in <copies>/copies.json: { [recordingId]: { title, sourceKey, sourceName, startedAt, parts: { [name]: { index,
// dir, seconds, folder, bytes, files, from, at } } } }.
const EVERY_MS = 10 * 60000;
const slug = (value) =>
  String(value || 'part')
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 80);
const freeGb = (folder) => {
  try {
    const stats = fs.statfsSync(folder);
    return Math.round((stats.bavail * stats.bsize) / 1e8) / 10;
  } catch {
    return null;
  }
};

export function copyKeeper({ client, peers, settings, isOwn = () => false, log = () => {}, mirror = mirrorRecording }) {
  let index = null;
  let indexRoot = null;
  let timer = 0;
  let running = null;
  let controller = null;
  let report = null;

  const root = () => settings().copiesDir || path.join(DATA_ROOT, 'copies');
  const indexFile = () => path.join(root(), 'copies.json');
  function load() {
    if (index && indexRoot === root()) return index;
    indexRoot = root();
    try {
      index = JSON.parse(fs.readFileSync(indexFile(), 'utf8'));
    } catch {
      index = {};
    }
    return index;
  }
  function save() {
    fs.mkdirSync(root(), { recursive: true });
    const temporary = `${indexFile()}.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(index, null, 1));
    fs.renameSync(temporary, indexFile());
  }

  // A copied recording, as findRecording gives one: the folder of a part (or the first) and every part as the jobs
  // and publish-media take them.
  function find(recordingId, partName) {
    const entry = load()[recordingId];
    if (!entry) return null;
    const source = SOURCES.find((item) => item.key === entry.sourceKey) || {
      key: entry.sourceKey,
      name: entry.sourceName || entry.sourceKey
    };
    const items = Object.entries(entry.parts)
      .filter(([, part]) => part.complete)
      .sort(([, a], [, b]) => a.index - b.index)
      .map(([name, part]) => ({
        row: { started_at: entry.startedAt },
        dir: path.join(root(), part.folder),
        id: recordingId,
        part: { index: part.index, name, dir: part.dir, seconds: part.seconds },
        title: entry.title,
        source
      }));
    const item = partName ? items.find((each) => each.part.name === partName) : items[0];
    return item ? { dir: item.dir, items } : null;
  }

  async function pass() {
    const copies = load();
    const all = (await client.list('recordings')).filter(
      (record) => record.data?.status !== 'recording' && (record.data?.parts || []).some((part) => part.dir)
    );
    let missing = 0;
    for (const record of all.sort((a, b) => String(b.data.startedAt).localeCompare(String(a.data.startedAt)))) {
      if (controller.signal.aborted || !settings().keepsCopies) break;
      if (isOwn(record.id)) continue;
      for (const part of record.data.parts.filter((item) => item.dir)) {
        const kept = copies[record.id]?.parts?.[part.name];
        if (kept?.complete && kept.seconds === part.seconds) continue;
        const free = freeGb(fs.existsSync(root()) ? root() : DATA_ROOT);
        if (free !== null && free < RECORDER.minFreeGb) {
          report = { ...report, error: `Copying paused: ${free} GB free, less than ${RECORDER.minFreeGb} GB` };
          return;
        }
        const nearby = byNearness(peers()).filter((peer) => peer.path !== 'relay');
        const folder = path.join(slug(record.id), slug(part.name));
        report = { ...report, copying: { title: record.data.title, part: part.name, share: 0 } };
        try {
          const copy = await mirror(nearby, record.id, {
            part: part.name,
            destDir: path.join(root(), folder),
            signal: controller.signal,
            onProgress: (share) => {
              report = { ...report, copying: { ...report.copying, share: Math.round(share * 100) / 100 } };
            }
          });
          copies[record.id] = {
            title: record.data.title,
            sourceKey: record.data.sourceKey,
            sourceName: record.data.sourceName,
            startedAt: record.data.startedAt,
            parts: copies[record.id]?.parts || {}
          };
          const files = fs.readdirSync(path.join(root(), folder, 'segments')).length;
          copies[record.id].parts[part.name] = {
            index: part.index,
            dir: part.dir,
            seconds: part.seconds,
            folder,
            files,
            from: copy.peer.agentId,
            at: new Date().toISOString(),
            complete: true
          };
          save();
          log(`Copies: ${record.data.title} (${part.name}) from ${copy.peer.name || copy.peer.agentId}`);
        } catch (error) {
          if (controller.signal.aborted) return;
          // Not on any agent this one reaches now (or it failed partway): tried again next time.
          missing += 1;
          if (!/No agent/.test(error.message)) log(`Copies: ${record.data.title}: ${error.message}`);
        }
      }
    }
    report = { ...report, copying: null, missing, error: null };
  }

  function summary() {
    const copies = load();
    const parts = Object.values(copies).flatMap((entry) => Object.values(entry.parts).filter((part) => part.complete));
    return { dir: root(), recordings: Object.keys(copies).length, parts: parts.length, freeGb: freeGb(root()) };
  }

  return {
    find,
    // The recordings copied here.
    held: () => Object.keys(load()),
    // Every ten minutes while told to keep copies; one pass at a time.
    tick(now) {
      if (!settings().keepsCopies || running || now < timer) return;
      timer = now + EVERY_MS;
      controller = new AbortController();
      report = { ...report, ...summary(), checkedAt: new Date().toISOString() };
      running = pass()
        .catch((error) => {
          report = { ...report, copying: null, error: error.message };
        })
        .finally(() => {
          running = null;
          report = { ...report, ...summary() };
        });
    },
    // { dir, recordings, parts, freeGb, copying: { title, part, share } | null, missing, error, checkedAt }, or null
    // when not keeping copies.
    report: () => (settings().keepsCopies ? report || summary() : null),
    // The pass under way, finished.
    settled: () => running || Promise.resolve(),
    async stop() {
      controller?.abort();
      await running;
    }
  };
}
