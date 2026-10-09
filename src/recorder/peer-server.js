import fs from 'fs';
import http from 'http';
import path from 'path';

// What an agent serves the other agents, on its Tailscale address only (agent-settings.js starts it there):
//   GET /ping                                      who it is (open to the tailnet: the hub pings it too)
//   GET /speed?bytes=N                             N bytes of nothing much (at most 64 MB), to time a transfer
//   GET /recordings/<id>/files?part=<name>         a recording part's files that can be fetched: [{ path, bytes }]
//   GET /recordings/<id>/file?part=&path=<path>    one of them (Range requests resume a transfer)
// All but /ping answer only the other agents: requests from addresses the hub doesn't list as an agent's are refused.
// What can be fetched of a part is its segments (segments/*.ts) and the small files that describe them (the
// part's top-level .json and .jsonl files), never anything outside its folder.
const MOST_SPEED_BYTES = 64 * 1024 * 1024;
const BLOCK = Buffer.alloc(1024 * 1024, 0x5a);

export const servable = (relative) =>
  /^segments\/[\w.-]+\.ts$/.test(relative) || /^[\w .-]+\.jsonl?$/.test(relative) ? !relative.includes('..') : false;

// A part's servable files, with their sizes.
export function partFiles(dir) {
  const files = [];
  const add = (relative) => {
    try {
      const stats = fs.statSync(path.join(dir, relative));
      if (stats.isFile()) files.push({ path: relative, bytes: stats.size });
    } catch {
      /* gone meanwhile */
    }
  };
  for (const name of fs.readdirSync(dir)) if (servable(name)) add(name);
  const segments = path.join(dir, 'segments');
  if (fs.existsSync(segments))
    for (const name of fs.readdirSync(segments).sort()) if (servable(`segments/${name}`)) add(`segments/${name}`);
  return files;
}

const plainAddress = (address) => String(address || '').replace(/^::ffff:/, '');

export function peerServer({ identity, findRecording, allowed, log = () => {} }) {
  let server = null;
  let wanted = null;

  // Listening on one address and port: null once listening, else the error.
  function open(address, port) {
    const created = http.createServer((request, response) => {
      try {
        handle(request, response);
      } catch (error) {
        if (!response.headersSent) json(response, 500, { error: error.message });
        else response.destroy();
      }
    });
    return new Promise((resolve) => {
      created.once('error', resolve);
      created.listen(port, address, () => {
        created.unref();
        server = created;
        resolve(null);
      });
    });
  }

  const json = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  };

  function sendFile(request, response, file) {
    const size = fs.statSync(file).size;
    const range = String(request.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end && size > 0) {
      response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      'content-type': 'application/octet-stream',
      'content-length': size ? end - start + 1 : 0,
      'accept-ranges': 'bytes',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {})
    });
    if (!size) return response.end();
    fs.createReadStream(file, { start, end }).pipe(response);
  }

  function sendSpeed(response, bytes) {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes });
    let left = bytes;
    const more = () => {
      while (left > 0) {
        const piece = BLOCK.subarray(0, Math.min(BLOCK.length, left));
        left -= piece.length;
        if (!response.write(piece)) return response.once('drain', more);
      }
      response.end();
    };
    more();
  }

  function handle(request, response) {
    const url = new URL(request.url, 'http://agent');
    if (request.method !== 'GET') return json(response, 405, { error: 'GET only' });
    if (url.pathname === '/ping') return json(response, 200, { ...identity(), time: new Date().toISOString() });
    const from = plainAddress(request.socket.remoteAddress);
    if (!allowed().has(from)) return json(response, 403, { error: `${from} isn't one of the hub's agents` });
    if (url.pathname === '/speed') {
      const bytes = Math.max(0, Math.min(MOST_SPEED_BYTES, Number(url.searchParams.get('bytes')) || 0));
      return sendSpeed(response, bytes);
    }
    const match = url.pathname.match(/^\/recordings\/([\w-]+)\/(files|file)$/);
    if (!match) return json(response, 404, { error: 'Not here' });
    const found = findRecording(match[1], url.searchParams.get('part') || undefined);
    if (!found) return json(response, 404, { error: "This agent doesn't have that recording" });
    if (match[2] === 'files') return json(response, 200, { agent: identity().id, files: partFiles(found.dir) });
    const relative = String(url.searchParams.get('path') || '');
    if (!servable(relative)) return json(response, 400, { error: "That file can't be fetched" });
    const file = path.join(found.dir, relative);
    if (!fs.existsSync(file)) return json(response, 404, { error: 'No such file' });
    sendFile(request, response, file);
  }

  return {
    // Listening on an address and port (moved if either changes). When another agent on this machine has the port,
    // the next free one of the ten after it is taken. The port it listens on, or null.
    async listen(address, port) {
      if (server && wanted === `${address}:${port}`) return server.address()?.port ?? null;
      server?.close();
      server = null;
      wanted = `${address}:${port}`;
      for (let tried = port; tried < port + 10; tried += 1) {
        const error = await open(address, tried);
        if (!error) return tried;
        if (error.code !== 'EADDRINUSE') break;
      }
      log(`Peers: can't listen on ${address} at port ${port} or the nine after it`);
      wanted = null;
      return null;
    },
    close: () => server?.close()
  };
}
