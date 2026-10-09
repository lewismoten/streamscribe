import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { DATA_ROOT, RECORDER } from '../config/runtime-config.js';
import { run } from '../media/encode.js';

// What an agent is told on the hub's Agents page (its agent_settings record, id = the agent's id), applied here, and
// what it finds, reported with its heartbeat (see live.js):
//   workDir      where working files go (temporary files, renders): a local drive, a USB drive, a network folder;
//                os.tmpdir() unless set (or unless it can't be written)
//   storage      more places to keep an eye on [{ label, path, kind: local | usb | network }]: each reported as there
//                and writable or not, with its free space (recordings themselves stay where config.local.js says)
//   ollama       { url, testAt }: an Ollama server on the network; its models are listed (each check, and when the
//                page asks with testAt)
//   peerPort     the port this agent answers pings on (4874 unless set), on its Tailscale address only; it pings the
//                other agents (their addresses from the hub's live view) and reports who it reached
// The report: { workDir, data, storage, ollama, tailscale, peers, checkedAt }.

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
    const status = JSON.parse((await run('tailscale', ['status', '--json'])).stdout);
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

export function agentSettings({ client, hubGet, log, detectNet = tailscale }) {
  let settings = {};
  let report = { checkedAt: null };
  let server = null;
  let lastOllamaTest = null;
  let timer = 0;

  // The settings as last synced (the sync client keeps the hub's records).
  async function read() {
    try {
      settings = (await client.get('agent_settings', RECORDER.id))?.data || {};
    } catch {
      /* keep the last ones */
    }
    return settings;
  }

  // Answering pings on the Tailscale address (and only there), started or moved as needed; true once listening.
  async function listen(address, port, version) {
    if (server && server.address()?.address === address && server.address()?.port === port) return true;
    server?.close();
    const created = http.createServer((request, response) => {
      if (request.method !== 'GET' || request.url !== '/ping') {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: RECORDER.id, name: RECORDER.name, version, time: new Date().toISOString() }));
    });
    server = created;
    return new Promise((resolve) => {
      created.once('error', (error) => {
        log(`Pings: can't listen on ${address}:${port} (${error.code || error.message})`);
        if (server === created) server = null;
        resolve(false);
      });
      created.listen(port, address, () => {
        created.unref();
        resolve(true);
      });
    });
  }

  async function check({ version }) {
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
      next.tailscale = { ...net, port, listening: await listen(net.ip, port, version) };
      // The other agents, by the addresses they report.
      try {
        const live = await hubGet('live');
        const others = (live.recorders || []).filter(
          (agent) => agent.recorderId !== RECORDER.id && agent.status?.settings?.tailscale?.ip
        );
        next.peers = await Promise.all(
          others.map(async (agent) => {
            const address = agent.status.settings.tailscale;
            return {
              agentId: agent.recorderId,
              name: agent.status.name || agent.name,
              ...(await ping(address.ip, address.port || 4874))
            };
          })
        );
      } catch {
        next.peers = report.peers || [];
      }
    } else next.tailscale = null;
    report = next;
    return report;
  }

  return {
    // Checked every minute (and right away when the Ollama test is asked for).
    async tick(now, context) {
      await read();
      if (now < timer && (settings.ollama?.testAt || null) === lastOllamaTest) return false;
      timer = now + 60000;
      await check(context);
      return true;
    },
    report: () => report,
    // Where working files go now.
    workDir: () => (report.workDir?.ok ? report.workDir.path : os.tmpdir()),
    stop: () => server?.close()
  };
}
