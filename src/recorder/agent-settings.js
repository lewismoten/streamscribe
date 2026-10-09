import fs from 'fs';
import os from 'os';
import path from 'path';
import { DATA_ROOT, RECORDER } from '../config/runtime-config.js';
import { run } from '../media/encode.js';
import { lanAddresses, tailscaleCommand, tailscalePath } from './peer-net.js';
import { peerServer } from './peer-server.js';
import { measureSpeed } from './peers.js';

// What an agent is told on the hub's Agents page (its agent_settings record, id = the agent's id), applied here, and
// what it finds, reported with its heartbeat (see live.js):
//   workDir      where working files go (temporary files, renders): a local drive, a USB drive, a network folder;
//                os.tmpdir() unless set (or unless it can't be written)
//   storage      more places to keep an eye on [{ label, path, kind: local | usb | network }]: each reported as there
//                and writable or not, with its free space (recordings themselves stay where config.local.js says)
//   ollama       { url, testAt }: an Ollama server on the network; its models are listed (each check, and when the
//                page asks with testAt)
//   peerPort     the port this agent answers the other agents on (4874 unless set), on its Tailscale address only
//                (peer-server.js: pings, and its recordings' files); it pings the other agents (their addresses from
//                the hub's live view) and reports who it reached, by which path (peer-net.js: the same network, a
//                direct connection elsewhere, or a relay), and how fast a transfer from each goes
//   peerTestAt   asks for the other agents to be checked again now, and transfers timed (they are every six hours;
//                relayed agents only when asked): the website can't reach agents, so it asks through the hub
// The website shows who reaches whom from these reports (the hub's server needn't be on the tailnet).
//   tools        tools to install on itself (tools.js): { whisper: { model, at } }, a new `at` asking again; its
//                progress and what's installed are reported as tools
//   keepsCopies  keeps a copy of every recording (a storage agent; copies.js), in copiesDir (its data folder's copies/
//                unless set)
// The report: { workDir, data, storage, ollama, tailscale, peers, checkedAt }.
const SPEED_EVERY_MS = 6 * 3600000;
const OFFLINE_MS = 5 * 60000;

const statusOf = (folder) => {
  try {
    fs.mkdirSync(folder, { recursive: true });
    const probe = path.join(folder, `.streamscribe-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    const stats = fs.statfsSync(folder);
    return { path: folder, ok: true, freeGb: Math.round((stats.bavail * stats.bsize) / 1e8) / 10 };
  } catch (error) {
    return { path: folder, ok: false, error: error.code || error.message };
  }
};

async function tailscale() {
  try {
    const status = JSON.parse((await run(tailscaleCommand(), ['status', '--json'])).stdout);
    const self = status.Self || {};
    return {
      ip: (self.TailscaleIPs || []).find((address) => address.includes('.')) || self.TailscaleIPs?.[0] || null,
      name: String(self.DNSName || self.HostName || '').replace(/\.$/, ''),
      online: Boolean(self.Online)
    };
  } catch {
    return null;
  }
}

async function ollamaModels(url) {
  const started = Date.now();
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok)
      return { url, ok: false, error: `answered ${response.status}`, checkedAt: new Date().toISOString() };
    const { models = [] } = await response.json();
    return {
      url,
      ok: true,
      ms: Date.now() - started,
      models: models.map((model) => ({ name: model.name, sizeGb: Math.round((model.size || 0) / 1e8) / 10 })),
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return { url, ok: false, error: error.cause?.code || error.message, checkedAt: new Date().toISOString() };
  }
}

async function ping(address, port) {
  const started = Date.now();
  try {
    const response = await fetch(`http://${address}:${port}/ping`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json();
    return { ok: response.ok, ms: Date.now() - started, id: body.id };
  } catch (error) {
    return { ok: false, error: error.cause?.code || error.message };
  }
}

// The name of the machine an agent runs on: its host name, else its Tailscale name.
const machineName = (status) =>
  status.hostname ||
  status.capabilities?.hostname ||
  String(status.settings?.tailscale?.name || '').split('.')[0] ||
  '';

export function agentSettings({
  client,
  hubGet,
  log,
  detectNet = tailscale,
  findRecording = () => null,
  installer = null,
  findPath = tailscalePath,
  speed = measureSpeed
}) {
  let settings = {};
  let report = { checkedAt: null };
  let lastOllamaTest = null;
  let lastPeerTest = null;
  let timer = 0;
  let version = '';
  // The other agents' Tailscale addresses (only they may fetch files), and the last transfer timed from each.
  let allowed = new Set();
  const speeds = new Map();
  // The recordings each other agent holds (from its live report).
  let holdings = new Map();
  const server = peerServer({
    identity: () => ({ id: RECORDER.id, name: RECORDER.name, version }),
    findRecording: (...args) => findRecording(...args),
    allowed: () => allowed,
    log
  });

  // The settings as last synced (the sync client keeps the hub's records).
  async function read() {
    try {
      settings = (await client.get('agent_settings', RECORDER.id))?.data || {};
    } catch {
      /* keep the last ones */
    }
    return settings;
  }

  // How this agent reaches another: its ping answered (and how fast), the path tailscale takes, and (when due) how fast
  // a transfer goes.
  async function reach(agent, { timeSpeed, asked }) {
    const address = agent.status.settings.tailscale;
    const port = address.port || 4874;
    const [answer, route] = await Promise.all([ping(address.ip, port), findPath(address.ip)]);
    const peer = {
      agentId: agent.recorderId,
      name: agent.status.name || agent.name,
      host: machineName(agent.status),
      ip: address.ip,
      port,
      ...answer,
      path: route.ok ? route.path : null,
      via: route.ok ? route.via : null,
      pathMs: route.ok ? route.ms : null,
      checkedAt: new Date().toISOString()
    };
    const last = speeds.get(peer.agentId);
    const due = timeSpeed && (asked || !last || Date.now() - Date.parse(last.at) > SPEED_EVERY_MS);
    if (peer.ok && due && (peer.path !== 'relay' || asked)) {
      const timed = await speed(peer, peer.path === 'local' ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
      speeds.set(peer.agentId, { ...timed, at: new Date().toISOString() });
    }
    const timed = speeds.get(peer.agentId);
    return timed ? { ...peer, speed: timed } : peer;
  }

  async function check(context) {
    version = context.version || '';
    await read();
    const next = { checkedAt: new Date().toISOString() };
    next.workDir = statusOf(settings.workDir || os.tmpdir());
    next.data = statusOf(DATA_ROOT);
    next.storage = (settings.storage || []).map((place) => ({
      ...statusOf(place.path),
      label: place.label,
      kind: place.kind
    }));
    if (settings.ollama?.url) {
      const asked = settings.ollama.testAt || null;
      const due =
        asked !== lastOllamaTest || !report.ollama || Date.now() - Date.parse(report.ollama.checkedAt) > 15 * 60000;
      next.ollama = due ? await ollamaModels(settings.ollama.url) : report.ollama;
      lastOllamaTest = asked;
    }
    const net = await detectNet();
    const port = Number(settings.peerPort) || 4874;
    if (net?.ip) {
      // (The port it listens on: the one set, or a later one if another agent on this machine has that.)
      const listening = await server.listen(net.ip, port);
      next.tailscale = { ...net, port: listening || port, listening: Boolean(listening), lan: lanAddresses() };
      // The other agents, by the addresses they report.
      try {
        const live = await hubGet('live');
        // (Agents not heard from in five minutes are offline: not pinged.)
        const others = (live.recorders || []).filter(
          (agent) =>
            agent.recorderId !== RECORDER.id &&
            agent.status?.settings?.tailscale?.ip &&
            !(Date.now() - Date.parse(agent.updatedAt) > OFFLINE_MS)
        );
        allowed = new Set(others.map((agent) => agent.status.settings.tailscale.ip));
        holdings = new Map(others.map((agent) => [agent.recorderId, new Set(agent.status.holds || [])]));
        const asked = (settings.peerTestAt || null) !== lastPeerTest;
        lastPeerTest = settings.peerTestAt || null;
        next.peers = await Promise.all(others.map((agent) => reach(agent, { timeSpeed: true, asked })));
      } catch {
        next.peers = report.peers || [];
      }
    } else next.tailscale = null;
    report = next;
    return report;
  }

  return {
    // Checked every minute (and right away when an Ollama or transfer test is asked for).
    async tick(now, context) {
      await read();
      installer?.consider(settings.tools);
      const asked =
        (settings.ollama?.testAt || null) !== lastOllamaTest || (settings.peerTestAt || null) !== lastPeerTest;
      if (now < timer && !asked) return false;
      timer = now + 60000;
      await check(context);
      return true;
    },
    // (With the installer's progress as it is now.)
    report: () => (installer ? { ...report, tools: installer.report() } : report),
    // Where working files go now.
    workDir: () => (report.workDir?.ok ? report.workDir.path : os.tmpdir()),
    // The other agents this one reaches, nearest first being the caller's choice (peers.js byNearness).
    peers: () => report.peers || [],
    holders: () => holdings,
    // Its settings as last read.
    current: () => settings,
    stop: () => {
      installer?.stop();
      server.close();
    }
  };
}
