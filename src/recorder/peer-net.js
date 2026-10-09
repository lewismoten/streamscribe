import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// How this agent reaches another over Tailscale, and so whether they share a network. `tailscale ping` says which path
// its packets take:
//   local    straight to the other machine's address on a private network (192.168.x.x, 10.x.x.x, …): the same home or
//            office, even across two routers, where the two machines' own addresses look like different networks
//   direct   straight to a public address: another place, but a direct connection (NAT traversal worked)
//   relay    through one of Tailscale's relay servers (DERP): another place, and the slowest path
// Transfers prefer local agents, then direct ones; a relayed one is used only when no other has what's needed.
export const PATH_RANK = { local: 0, direct: 1, relay: 2 };

// RFC 1918 and RFC 4193 (and link-local) addresses: a machine's address on its own network.
export function isPrivateAddress(address) {
  const ip = String(address || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  const four = ip.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (four) {
    const [a, b] = [Number(four[1]), Number(four[2])];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

// One line of `tailscale ping`: "pong from pi5-01 (100.121.195.7) via 192.168.54.109:41641 in 17ms", or "… via
// DERP(iad) in 16ms".
export function parseTailscalePing(text) {
  const line = String(text || '')
    .split('\n')
    .find((item) => item.startsWith('pong from'));
  if (!line)
    return {
      ok: false,
      error:
        String(text || '')
          .trim()
          .split('\n')
          .at(-1) || 'no answer'
    };
  const ms = Number(line.match(/ in ([\d.]+)ms/)?.[1]);
  const relay = line.match(/via DERP\(([^)]+)\)/)?.[1];
  if (relay) return { ok: true, path: 'relay', via: `DERP ${relay}`, ms };
  const via = line.match(/ via (\[[^\]]+\]|[^\s]+?):\d+ in /)?.[1]?.replace(/^\[|\]$/g, '');
  if (!via) return { ok: true, path: 'direct', via: null, ms };
  return { ok: true, path: isPrivateAddress(via) ? 'local' : 'direct', via, ms };
}

// The tailscale command: on the PATH, else where its installers put it (a service's PATH is often short: launchd's
// leaves out /usr/local/bin, where the Mac app's command line goes).
const TAILSCALE_PLACES = [
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale',
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale'
];
let tailscaleFound = null;
export function tailscaleCommand() {
  if (tailscaleFound) return tailscaleFound;
  const onPath = (process.env.PATH || '')
    .split(path.delimiter)
    .map((folder) => path.join(folder, 'tailscale'))
    .find((file) => fs.existsSync(file));
  tailscaleFound = onPath || TAILSCALE_PLACES.find((file) => fs.existsSync(file)) || 'tailscale';
  return tailscaleFound;
}

// The path to another agent's Tailscale address, by asking tailscale. (It exits with an error when no direct
// connection was made, though it may have had an answer through a relay, so its output is read either way.)
const pingCommand = (ip) =>
  new Promise((resolve) => {
    execFile(
      tailscaleCommand(),
      ['ping', '-c', '1', '--timeout', '3s', ip],
      { timeout: 10000 },
      (error, stdout, stderr) =>
        resolve(`${stdout || ''}\n${stderr || ''}${error && !stdout && !stderr ? error.message : ''}`)
    );
  });

export async function tailscalePath(ip, ping = pingCommand) {
  return parseTailscalePing(await ping(ip));
}

// This machine's own addresses on its networks (not Tailscale's, not loopback), shown on the Agents page.
export function lanAddresses(interfaces = os.networkInterfaces()) {
  return Object.entries(interfaces)
    .flatMap(([name, list]) => (list || []).map((item) => ({ ...item, name })))
    .filter((item) => !item.internal && item.family === 'IPv4' && isPrivateAddress(item.address))
    .map((item) => `${item.address}/${item.cidr?.split('/')[1] || ''}`.replace(/\/$/, ''));
}
