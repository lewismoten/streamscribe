import { HTTP } from '../config/runtime-config.js';
import { RobotsDisallowedError, checkRobots, shouldCheckRobots } from './robots.js';

const ansi = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m'
};
const defaultUserAgent = HTTP.userAgent;
const cookieJar = new Map();
const rateBuckets = new Map();
const hostNextAllowedAt = new Map();

// Every web request goes through here: robots.txt is checked (from cache when fresh), then the request
// waits for its rate profile and any robots.txt Crawl-delay for the host.
// Options beyond fetch's own:
// - rateProfile: name of an `http.profiles` entry (defaults to the npm script name if configured, else 'default')
// - quiet: skip the "Fetching ..." log line
export async function fetchWithDefaults(input, init = {}) {
  const rawOptions = init && typeof init === 'object'
    ? { ...init }
    : {};
  const options = { ...rawOptions };
  const rateProfile = options.rateProfile;
  delete options.rateProfile;
  const quiet = Boolean(options.quiet);
  delete options.quiet;
  options.method = String(options.method || 'GET').toUpperCase();
  const requestUrl = normalizeFetchUrl(input);
  options.headers = mergeDefaultHeaders(options.headers, requestUrl);
  const url = formatFetchUrl(requestUrl || input);

  await prepareRequest(requestUrl, { rateProfile });
  if (!quiet) {
    console.log(`${ansi.cyan}Fetching ${url}${ansi.reset}`);
  }

  const response = await fetch(input, options);
  storeResponseCookies(response, requestUrl);
  return response;
}

function formatFetchUrl(input) {
  const raw = normalizeFetchUrl(input) || String(input || '');

  return raw.length > 71 ? raw.slice(-71) : raw;
}

function mergeDefaultHeaders(headers, requestUrl) {
  const merged = new Headers(headers || {});
  if (!merged.has('user-agent')) {
    merged.set('user-agent', defaultUserAgent);
  }
  mergeCookieHeader(merged, requestUrl);
  return merged;
}

function normalizeFetchUrl(input) {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input && typeof input === 'object' && 'url' in input
        ? String(input.url || '')
        : String(input || '');
  if (!raw) {
    return '';
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }
  if (raw.startsWith('//')) {
    return `https:${raw}`;
  }

  return raw;
}

function mergeCookieHeader(headers, requestUrl) {
  const jarCookieHeader = buildCookieHeader(requestUrl);
  if (!jarCookieHeader) {
    return;
  }

  const explicitCookieHeader = String(headers.get('cookie') || '').trim();
  if (!explicitCookieHeader) {
    headers.set('cookie', jarCookieHeader);
    return;
  }

  const mergedCookies = new Map();
  for (const cookie of explicitCookieHeader.split(/;\s*/g)) {
    const [name, ...rest] = cookie.split('=');
    if (!name || rest.length === 0) {
      continue;
    }
    mergedCookies.set(name, `${name}=${rest.join('=')}`);
  }
  for (const cookie of jarCookieHeader.split(/;\s*/g)) {
    const [name, ...rest] = cookie.split('=');
    if (!name || rest.length === 0 || mergedCookies.has(name)) {
      continue;
    }
    mergedCookies.set(name, `${name}=${rest.join('=')}`);
  }
  headers.set('cookie', Array.from(mergedCookies.values()).join('; '));
}

function buildCookieHeader(requestUrl) {
  const url = safeUrl(requestUrl);
  if (!url) {
    return '';
  }

  const now = Date.now();
  const matches = [];
  for (const [key, record] of cookieJar.entries()) {
    if (!record || typeof record !== 'object') {
      cookieJar.delete(key);
      continue;
    }
    if (record.expiresAt && record.expiresAt <= now) {
      cookieJar.delete(key);
      continue;
    }
    if (!domainMatches(url.hostname, record.domain)) {
      continue;
    }
    if (!pathMatches(url.pathname, record.path)) {
      continue;
    }
    if (record.secure && url.protocol !== 'https:') {
      continue;
    }
    matches.push(record);
  }

  matches.sort((left, right) => String(right.path || '/').length - String(left.path || '/').length);
  return matches.map((record) => `${record.name}=${record.value}`).join('; ');
}

function storeResponseCookies(response, requestUrl) {
  const url = safeUrl(requestUrl);
  if (!url || !response?.headers) {
    return;
  }

  for (const cookieString of getSetCookieHeaders(response.headers)) {
    const record = parseSetCookie(cookieString, url);
    if (!record) {
      continue;
    }
    const key = `${record.domain}|${record.path}|${record.name}`;
    if (record.expiresAt && record.expiresAt <= Date.now()) {
      cookieJar.delete(key);
      continue;
    }
    cookieJar.set(key, record);
  }
}

function getSetCookieHeaders(headers) {
  if (!headers) {
    return [];
  }
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const combined = headers.get('set-cookie');
  if (!combined) {
    return [];
  }

  return splitSetCookieHeader(combined);
}

function splitSetCookieHeader(value) {
  const parts = [];
  let current = '';
  let inExpires = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const tail = value.slice(index, index + 8).toLowerCase();
    if (tail === 'expires=') {
      inExpires = true;
    }
    if (char === ',' && !inExpires) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    if (inExpires && char === ';') {
      inExpires = false;
    }
    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts.filter(Boolean);
}

function parseSetCookie(cookieString, requestUrl) {
  const segments = String(cookieString || '').split(';').map((part) => part.trim()).filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  const [nameValue, ...attributes] = segments;
  const separatorIndex = nameValue.indexOf('=');
  if (separatorIndex < 1) {
    return null;
  }

  const name = nameValue.slice(0, separatorIndex).trim();
  const value = nameValue.slice(separatorIndex + 1);
  const record = {
    name,
    value,
    domain: requestUrl.hostname.toLowerCase(),
    path: defaultCookiePath(requestUrl.pathname),
    secure: false,
    expiresAt: 0
  };

  for (const attribute of attributes) {
    const [rawKey, ...rawValueParts] = attribute.split('=');
    const key = String(rawKey || '').trim().toLowerCase();
    const attributeValue = rawValueParts.join('=').trim();

    if (key === 'domain' && attributeValue) {
      record.domain = attributeValue.replace(/^\./, '').toLowerCase();
      continue;
    }
    if (key === 'path' && attributeValue) {
      record.path = attributeValue.startsWith('/') ? attributeValue : `/${attributeValue}`;
      continue;
    }
    if (key === 'secure') {
      record.secure = true;
      continue;
    }
    if (key === 'expires' && attributeValue) {
      const expiresAt = Date.parse(attributeValue);
      if (Number.isFinite(expiresAt)) {
        record.expiresAt = expiresAt;
      }
      continue;
    }
    if (key === 'max-age' && attributeValue) {
      const seconds = Number.parseInt(attributeValue, 10);
      if (Number.isFinite(seconds)) {
        record.expiresAt = Date.now() + (seconds * 1000);
      }
    }
  }

  return record;
}

function safeUrl(value) {
  try {
    const normalized = normalizeFetchUrl(value);
    if (!normalized || !/^https?:\/\//i.test(normalized)) {
      return null;
    }
    return new URL(normalized);
  } catch {
    return null;
  }
}

function defaultCookiePath(pathname) {
  const value = String(pathname || '/').trim() || '/';
  if (!value.startsWith('/')) {
    return '/';
  }
  if (value === '/') {
    return '/';
  }
  const lastSlash = value.lastIndexOf('/');
  return lastSlash > 0 ? value.slice(0, lastSlash) : '/';
}

function domainMatches(hostname, cookieDomain) {
  const host = String(hostname || '').toLowerCase();
  const domain = String(cookieDomain || '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(pathname, cookiePath) {
  const path = String(pathname || '/');
  const base = String(cookiePath || '/');
  return path === base || path.startsWith(base.endsWith('/') ? base : `${base}/`) || base === '/';
}

// Checks robots.txt and waits for a request slot. Use it directly before requests made outside
// fetchWithDefaults (for example with curl). Throws RobotsDisallowedError when robots.txt forbids the URL.
export async function prepareRequest(requestUrl, { rateProfile } = {}) {
  const profileName = resolveRateProfileName(rateProfile);
  const url = safeUrl(requestUrl);
  let crawlDelayMs = 0;
  if (url && shouldCheckRobots(url)) {
    const verdict = await checkRobots(url, (robotsUrl, timeoutMs) => fetchRobotsFile(robotsUrl, timeoutMs, profileName));
    if (!verdict.allowed) {
      throw new RobotsDisallowedError(url.toString(), verdict.robotsUrl, verdict.rule);
    }
    crawlDelayMs = verdict.crawlDelayMs;
  }
  await takeRateToken(profileName);
  if (url && crawlDelayMs > 0) {
    await waitForHostDelay(url.host, crawlDelayMs);
  }
}

export function isRobotsDisallowedError(error) {
  return error?.code === 'ROBOTS_DISALLOWED';
}

async function fetchRobotsFile(robotsUrl, timeoutMs, profileName) {
  await takeRateToken(profileName);
  return await fetch(robotsUrl, {
    headers: { 'user-agent': defaultUserAgent, accept: 'text/plain,*/*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function resolveRateProfileName(rateProfile) {
  if (rateProfile && HTTP.profiles[rateProfile]) {
    return rateProfile;
  }
  if (rateProfile) {
    throw new Error(`Unknown http rate profile "${rateProfile}". Configured profiles: ${Object.keys(HTTP.profiles).join(', ')}`);
  }
  const scriptName = String(process.env.npm_lifecycle_event || '');
  return HTTP.profiles[scriptName] ? scriptName : 'default';
}

// Token bucket per profile: up to `burst` requests may go out back to back, then one per `cooldownMs`.
// With burst 1 this is a plain cooldown between requests.
async function takeRateToken(profileName) {
  const profile = HTTP.profiles[profileName];
  if (!(profile.cooldownMs > 0)) {
    return;
  }
  let bucket = rateBuckets.get(profileName);
  if (!bucket) {
    bucket = { tokens: profile.burst, updatedAt: Date.now(), queue: Promise.resolve() };
    rateBuckets.set(profileName, bucket);
  }

  const turn = bucket.queue.then(async () => {
    const refill = () => {
      const now = Date.now();
      bucket.tokens = Math.min(profile.burst, bucket.tokens + ((now - bucket.updatedAt) / profile.cooldownMs));
      bucket.updatedAt = now;
    };
    refill();
    if (bucket.tokens < 1) {
      await sleep(Math.ceil((1 - bucket.tokens) * profile.cooldownMs));
      refill();
    }
    bucket.tokens -= 1;
  });
  bucket.queue = turn.catch(() => {});
  await turn;
}

async function waitForHostDelay(host, crawlDelayMs) {
  const previous = hostNextAllowedAt.get(host) || Promise.resolve(0);
  const turn = previous.then(async (nextAllowedAt) => {
    const waitMs = nextAllowedAt - Date.now();
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    return Date.now() + crawlDelayMs;
  });
  hostNextAllowedAt.set(host, turn.catch(() => Date.now() + crawlDelayMs));
  await turn;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
