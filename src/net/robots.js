import crypto from 'crypto';
import path from 'path';
import { HTTP, STATE_ROOT } from '../config/runtime-config.js';
import { loadJson, writeJsonAtomically } from '../util/fs-utils.js';

// robots.txt support following RFC 9309, configured under `http.robots` in config.local.js.
// - 2xx: parse and obey the group for `userAgentToken`, falling back to the `*` group.
// - 4xx (including 404): no rules, everything allowed.
// - 5xx, timeouts, network errors: use the cached copy if there is one, otherwise `onUnreachable`.
// Copies are cached in memory and under `{STATE_ROOT}/robots/` for `cacheHours`.
const robotsCacheDir = path.join(STATE_ROOT, 'robots');
const robotsFetchTimeoutMs = 15000;
const maxRobotsBytes = 500 * 1024;
const unreachableCacheMs = 60 * 60 * 1000;
const memoryCache = new Map();
const pendingLoads = new Map();

export class RobotsDisallowedError extends Error {
  constructor(url, robotsUrl, rule) {
    super(`Blocked by robots.txt (${rule}): ${url}. See ${robotsUrl}, or add the host to http.robots.ignoreHosts in config.local.js.`);
    this.name = 'RobotsDisallowedError';
    this.code = 'ROBOTS_DISALLOWED';
    this.url = url;
    this.robotsUrl = robotsUrl;
  }
}

export function shouldCheckRobots(url) {
  const robots = HTTP.robots;
  if (!robots.enabled || !url || !/^https?:$/i.test(url.protocol)) {
    return false;
  }
  return !robots.ignoreHosts.some((host) => hostMatches(url.hostname, host));
}

// Returns { allowed, rule, robotsUrl, crawlDelayMs } for a URL. `fetchRobots(robotsUrl)` performs the
// network request so the caller can apply its own rate limiting and headers.
export async function checkRobots(url, fetchRobots) {
  const robotsUrl = `${url.origin}/robots.txt`;
  if (url.pathname === '/robots.txt') {
    return { allowed: true, rule: 'robots.txt itself', robotsUrl, crawlDelayMs: 0 };
  }
  const policy = await loadRobotsPolicy(url.origin, robotsUrl, fetchRobots);
  const verdict = evaluate(policy.group, `${url.pathname}${url.search}`);
  return {
    ...verdict,
    robotsUrl,
    crawlDelayMs: HTTP.robots.honorCrawlDelay ? policy.group.crawlDelayMs : 0
  };
}

// Serves a cached copy immediately, even when expired, and refreshes it in the background. Only the very
// first check for a site waits for the network, so a slow or unreachable robots.txt never stalls requests
// that are already flowing (such as a live capture, whose playlist only keeps about 30 seconds of video).
async function loadRobotsPolicy(origin, robotsUrl, fetchRobots) {
  let cached = memoryCache.get(origin);
  if (!cached) {
    const diskRecord = await loadJson(diskPathFor(origin));
    if (diskRecord) {
      cached = remember(origin, diskRecord);
    }
  }
  if (cached && isFresh(cached)) {
    return cached;
  }
  const refresh = startRefresh(origin, robotsUrl, fetchRobots);
  return cached || await refresh;
}

function startRefresh(origin, robotsUrl, fetchRobots) {
  if (!pendingLoads.has(origin)) {
    pendingLoads.set(origin, refreshRobotsPolicy(origin, robotsUrl, fetchRobots)
      .catch((error) => {
        console.warn(`robots.txt refresh failed for ${origin}: ${error.message}`);
        return memoryCache.get(origin);
      })
      .finally(() => pendingLoads.delete(origin)));
  }
  return pendingLoads.get(origin);
}

function diskPathFor(origin) {
  return path.join(robotsCacheDir, `${cacheFileName(origin)}.json`);
}

async function refreshRobotsPolicy(origin, robotsUrl, fetchRobots) {
  const diskPath = diskPathFor(origin);
  const diskRecord = await loadJson(diskPath);

  let record;
  try {
    const response = await fetchRobots(robotsUrl, robotsFetchTimeoutMs);
    if (response.status >= 500) {
      throw new Error(`robots.txt returned ${response.status}`);
    }
    const body = response.ok ? (await response.text()).slice(0, maxRobotsBytes) : '';
    record = { origin, robotsUrl, status: response.status, fetchedAt: new Date().toISOString(), body };
    await writeJsonAtomically(diskPath, record);
  } catch (error) {
    const fallback = memoryCache.get(origin) || diskRecord;
    if (fallback) {
      console.warn(`robots.txt unreachable for ${origin} (${error.message}); using cached copy from ${fallback.fetchedAt}`);
      // Retry in an hour rather than on every request.
      return remember(origin, { ...fallback, fetchedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + unreachableCacheMs).toISOString() });
    }
    const allow = HTTP.robots.onUnreachable !== 'disallow';
    console.warn(`robots.txt unreachable for ${origin} (${error.message}); ${allow ? 'allowing' : 'disallowing'} requests (http.robots.onUnreachable)`);
    // Cached for a shorter time than a real robots.txt so it is retried soon, without slowing every restart.
    const unreachable = {
      origin,
      robotsUrl,
      status: 0,
      error: error.message,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + unreachableCacheMs).toISOString(),
      body: allow ? '' : 'User-agent: *\nDisallow: /'
    };
    await writeJsonAtomically(diskPath, unreachable);
    return remember(origin, unreachable);
  }
  return remember(origin, record);
}

function remember(origin, record) {
  const policy = { ...record, group: selectGroup(parseRobots(record.body), HTTP.robots.userAgentToken) };
  memoryCache.set(origin, policy);
  return policy;
}

function isFresh(record) {
  if (record.expiresAt) {
    return Date.now() < Date.parse(record.expiresAt);
  }
  const fetchedAt = Date.parse(record.fetchedAt || '');
  return Number.isFinite(fetchedAt) && Date.now() - fetchedAt < HTTP.robots.cacheHours * 60 * 60 * 1000;
}

function cacheFileName(origin) {
  const readable = origin.replace(/^https?:\/\//i, '').replace(/[^a-z0-9.-]+/gi, '_');
  return `${readable}-${crypto.createHash('sha1').update(origin).digest('hex').slice(0, 8)}`;
}

// Parses robots.txt into groups: { agents: [...], rules: [{ allow, pattern }], crawlDelayMs }.
export function parseRobots(body) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;

  for (const rawLine of String(body || '').split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();

    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [], crawlDelayMs: 0 };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) {
      continue;
    }
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) {
        current.rules.push({ allow: key === 'allow', pattern: value });
      }
    } else if (key === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        current.crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  }
  return groups;
}

// Merges every group naming our product token; falls back to the `*` groups.
export function selectGroup(groups, userAgentToken) {
  const token = String(userAgentToken || '').toLowerCase();
  const matching = groups.filter((group) => token && group.agents.some((agent) => agent !== '*' && token.startsWith(agent)));
  const chosen = matching.length > 0 ? matching : groups.filter((group) => group.agents.includes('*'));
  return {
    rules: chosen.flatMap((group) => group.rules),
    crawlDelayMs: Math.max(0, ...chosen.map((group) => group.crawlDelayMs))
  };
}

// The longest matching pattern wins; Allow wins a tie. No match means allowed.
export function evaluate(group, pathAndQuery) {
  let best = null;
  for (const rule of group.rules) {
    if (!patternMatches(rule.pattern, pathAndQuery)) {
      continue;
    }
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) {
      best = rule;
    }
  }
  return best
    ? { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` }
    : { allowed: true, rule: 'no matching rule' };
}

function patternMatches(pattern, pathAndQuery) {
  const anchored = pattern.endsWith('$');
  const body = safeDecode(anchored ? pattern.slice(0, -1) : pattern);
  const regex = body.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${regex}${anchored ? '$' : ''}`).test(safeDecode(pathAndQuery));
}

function safeDecode(value) {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

function hostMatches(hostname, host) {
  const value = String(host || '').toLowerCase().trim();
  const name = String(hostname || '').toLowerCase();
  return Boolean(value) && (name === value || name.endsWith(`.${value}`));
}
