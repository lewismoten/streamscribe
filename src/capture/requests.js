import fs from 'fs';
import { fetchWithDefaults, isRobotsDisallowedError } from '../net/fetch.js';
import { endStream, isRedirectResponse, onceDrain } from '../net/http.js';
import { hlsRequestTimeoutMs, hlsFetchRetries, hlsRetryDelayMs, pageRequestTimeoutMs, pageFetchRetries, maxRedirects } from './constants.js';
import { sleep } from './files.js';

// Requests made while capturing: playlist and page fetch settings, redirects (with their cookies), and streaming
// a response to a file.

// Playlists and live segments use the steady `liveMedia` rate profile; the startup backfill of
// earlier segments uses the faster `liveBackfill` profile (see http.profiles in config.local.js).
export function hlsFetchOptions(timeoutMs = hlsRequestTimeoutMs, retries = hlsFetchRetries, rateProfile = 'liveMedia') {
  return {
    rateProfile,
    timeoutMs,
    retries,
    retryDelayMs: hlsRetryDelayMs,
    quiet: true
  };
}

export function pageFetchOptions() {
  return {
    timeoutMs: pageRequestTimeoutMs,
    retries: pageFetchRetries,
    retryDelayMs: hlsRetryDelayMs,
    quiet: true
  };
}

export function timeoutSignal(timeoutMs) {
  const value = Number(timeoutMs || 0);
  return Number.isFinite(value) && value > 0 && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(value)
    : undefined;
}

export async function fetchWithRedirectCookies(url, options = {}) {
  const retries = Math.max(0, Number(options.retries || 0));
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchRedirectChain(url, options);
    } catch (error) {
      if (isRobotsDisallowedError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt < retries) {
        await sleep(Number(options.retryDelayMs || hlsRetryDelayMs) * (attempt + 1));
      }
    }
  }
  throw lastError;
}

export async function fetchRedirectChain(url, options = {}) {
  let currentUrl = url;
  const redirectChain = [url];
  const redirects = Number(options.maxRedirects || maxRedirects);

  for (let redirectCount = 0; redirectCount <= redirects; redirectCount += 1) {
    const headers = new Headers(options.headers || {});
    const response = await fetchWithDefaults(currentUrl, {
      headers,
      redirect: 'manual',
      rateProfile: options.rateProfile,
      quiet: options.quiet,
      signal: timeoutSignal(options.timeoutMs)
    });

    if (!isRedirectResponse(response.status)) {
      if (isRetryableStatus(response.status)) {
        if (response.body) {
          await response.body.cancel().catch(() => {});
        }
        throw new Error(`Request returned ${response.status}: ${currentUrl}`);
      }
      return {
        response,
        finalUrl: currentUrl,
        redirectChain
      };
    }

    const location = response.headers.get('location');
    if (!location) {
      return {
        response,
        finalUrl: currentUrl,
        redirectChain
      };
    }

    currentUrl = new URL(location, currentUrl).toString();
    redirectChain.push(currentUrl);
  }

  throw new Error(`Too many redirects while fetching ${url}`);
}

export async function streamResponseToFile(response, destinationPath, options = {}) {
  if (!response.body) {
    throw new Error('Response body was empty');
  }

  const writeStream = fs.createWriteStream(destinationPath, { flags: 'w' });
  const reader = response.body.getReader();
  let downloadedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = Buffer.from(value);
      downloadedBytes += chunk.length;
      if (!writeStream.write(chunk)) {
        await onceDrain(writeStream);
      }
      options.onVisibleOutput?.();
    }

    await endStream(writeStream);
  } catch (error) {
    writeStream.destroy();
    throw error;
  }

  return downloadedBytes;
}

export function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}
