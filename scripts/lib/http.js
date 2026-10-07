import { fetchWithDefaults } from './fetch.js';

const defaultMaxRedirects = 10;

export function isRedirectResponse(status) {
  return [301, 302, 303, 307, 308].includes(status);
}

export function safeUrl(value) {
  try {
    return new URL(String(value || ''));
  } catch {
    return null;
  }
}

// Follows redirects manually so cookies set along the chain are kept by fetchWithDefaults.
export async function fetchWithRedirectCookies(url, options = {}) {
  let currentUrl = url;
  const redirectChain = [url];
  const redirects = Number(options.maxRedirects || defaultMaxRedirects);

  for (let redirectCount = 0; redirectCount <= redirects; redirectCount += 1) {
    const headers = new Headers(options.headers || {});

    const response = await fetchWithDefaults(currentUrl, {
      headers,
      redirect: 'manual'
    });

    if (!isRedirectResponse(response.status)) {
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

export function onceDrain(stream) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      stream.off('error', onError);
      stream.off('drain', onDrain);
    };
    stream.on('error', onError);
    stream.on('drain', onDrain);
  });
}

export function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(() => resolve());
  });
}
