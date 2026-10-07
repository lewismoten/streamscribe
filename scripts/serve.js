import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { SOURCES } from './lib/runtime-config.js';
import { fileExists } from './lib/fs-utils.js';
import { escapeHtml } from './lib/html.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4873;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const roots = await buildRoots(options.customRoots);
  const server = http.createServer((request, response) => {
    handleRequest(request, response, roots).catch((error) => {
      response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      response.end(`Server error: ${error.message}`);
    });
  });

  server.listen(options.port, options.host, () => {
    console.log(`Serving local files at http://${options.host}:${options.port}/`);
    for (const root of roots) {
      console.log(`  /${root.slug}/ -> ${root.dir}`);
    }
  });
}

function parseArgs(args) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    customRoots: []
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim();
    if (arg === '--host') {
      options.host = String(args[index + 1] || '').trim() || DEFAULT_HOST;
      index += 1;
      continue;
    }
    if (arg === '--port') {
      const value = Number.parseInt(String(args[index + 1] || '').trim(), 10);
      if (!Number.isFinite(value) || value < 1 || value > 65535) {
        throw new Error('Expected a valid port number after --port');
      }
      options.port = value;
      index += 1;
      continue;
    }
    if (arg === '--root') {
      const value = String(args[index + 1] || '').trim();
      if (!value.includes('=')) {
        throw new Error('Expected --root alias=/absolute/path');
      }
      const separatorIndex = value.indexOf('=');
      options.customRoots.push({
        alias: value.slice(0, separatorIndex).trim(),
        dir: value.slice(separatorIndex + 1).trim()
      });
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

async function buildRoots(customRoots) {
  // Each source's folder (its live captures, full meetings, archive downloads, and people) at /{source key}/.
  const baseRoots = SOURCES.map((source) => ({ slug: slugify(source.key), label: source.name, dir: source.storageDir }));

  for (const root of Array.isArray(customRoots) ? customRoots : []) {
    if (!root?.alias || !root?.dir) {
      continue;
    }
    baseRoots.push({
      slug: slugify(root.alias),
      label: root.alias,
      dir: root.dir
    });
  }

  const roots = [];
  const seen = new Set();
  for (const root of baseRoots) {
    const dir = path.resolve(String(root.dir || '').trim());
    const slug = slugify(root.slug);
    if (!dir || !slug || seen.has(slug)) {
      continue;
    }
    if (!(await fileExists(dir))) {
      continue;
    }
    seen.add(slug);
    roots.push({
      slug,
      label: String(root.label || slug).trim(),
      dir
    });
  }

  if (roots.length === 0) {
    throw new Error('No readable roots were found to serve');
  }

  return roots;
}

async function handleRequest(request, response, roots) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'PUT') {
    return handlePut(request, response, roots);
  }
  if (method === 'POST') {
    return handleRetranscribe(request, response, roots);
  }
  if (!['GET', 'HEAD'].includes(method)) {
    response.writeHead(405, { allow: 'GET, HEAD, PUT, POST' });
    response.end();
    return;
  }

  const url = new URL(request.url || '/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname || '/');

  if (pathname === '/' || pathname === '') {
    return writeHtml(response, method, 200, renderRootIndex(roots));
  }

  const [, rootSlug, ...restParts] = pathname.split('/');
  const root = roots.find((entry) => entry.slug === rootSlug);
  if (!root) {
    return writeText(response, method, 404, 'Not found');
  }

  const safeRelativePath = restParts.join('/');
  const resolvedPath = path.resolve(root.dir, safeRelativePath);
  if (!resolvedPath.startsWith(root.dir)) {
    return writeText(response, method, 403, 'Forbidden');
  }

  if (containsIgnoredPathSegment(safeRelativePath)) {
    return writeText(response, method, 404, 'Not found');
  }

  let stats;
  try {
    stats = await fs.promises.stat(resolvedPath);
  } catch {
    return writeText(response, method, 404, 'Not found');
  }

  if (stats.isDirectory()) {
    const indexPath = path.join(resolvedPath, 'index.html');
    if (await fileExists(indexPath)) {
      const indexStats = await fs.promises.stat(indexPath);
      return streamFile(response, request, method, indexPath, indexStats);
    }

    const listing = await renderDirectoryIndex(root, resolvedPath, pathname);
    return writeHtml(response, method, 200, listing);
  }

  return streamFile(response, request, method, resolvedPath, stats);
}

// Pages can save a few kinds of metadata back (the thumbnails page's speaker marks and its people roster), and
// nothing else: {session}/speakers.json, audio-boosts.json, meeting-info.json, agenda.json, votes.json, and views.json, people/people.json, and people/<id>.png face crops. A PUT from another
// website is blocked by the browser, because this server never answers the CORS preflight such a request needs.
const writablePaths = [
  { pattern: /(^|\/)speakers\.json$/, type: 'json' },
  { pattern: /(^|\/)audio-boosts\.json$/, type: 'json' },
  { pattern: /(^|\/)meeting-info\.json$/, type: 'json' },
  { pattern: /(^|\/)agenda\.json$/, type: 'json' },
  { pattern: /(^|\/)votes\.json$/, type: 'json' },
  { pattern: /(^|\/)views\.json$/, type: 'json' },
  { pattern: /(^|\/)people\/people\.json$/, type: 'json', createParent: true },
  { pattern: /(^|\/)people\/[a-z0-9][a-z0-9-]*\.png$/, type: 'png', createParent: true }
];
const maxUploadBytes = 8 * 1024 * 1024;

async function handlePut(request, response, roots) {
  const url = new URL(request.url || '/', 'http://localhost');
  const [, rootSlug, ...restParts] = decodeURIComponent(url.pathname || '/').split('/');
  const root = roots.find((entry) => entry.slug === rootSlug);
  const relativePath = restParts.join('/');
  const rule = writablePaths.find((item) => item.pattern.test(relativePath));
  const resolvedPath = root ? path.resolve(root.dir, relativePath) : '';
  if (!root || !rule || !resolvedPath.startsWith(root.dir + path.sep) || containsIgnoredPathSegment(relativePath)) {
    return writeText(response, 'PUT', 403, 'Only speakers.json, audio-boosts.json, meeting-info.json, agenda.json, votes.json, views.json, people/people.json, and people/<id>.png can be saved');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUploadBytes) {
      return writeText(response, 'PUT', 413, 'Too large');
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  if (rule.type === 'json') {
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      return writeText(response, 'PUT', 400, 'Not valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return writeText(response, 'PUT', 400, 'Expected a JSON object');
    }
  } else if (!body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return writeText(response, 'PUT', 400, 'Not a PNG image');
  }

  const parent = path.dirname(resolvedPath);
  if (rule.createParent) {
    await fs.promises.mkdir(parent, { recursive: true });
  } else if (!(await fileExists(parent))) {
    return writeText(response, 'PUT', 404, 'No such folder');
  }
  const temporaryPath = `${resolvedPath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporaryPath, body);
  await fs.promises.rename(temporaryPath, resolvedPath);
  console.log(`Saved ${path.relative(root.dir, resolvedPath)} (${body.length} bytes)`);
  return writeText(response, 'PUT', 200, 'Saved');
}

// POST {session or meeting folder}/retranscribe with JSON { action: 'preview' | 'peaks' | 'clip' | 'transcribe' | 'remove', from, to,
// gainDb, highpassHz, normalize, denoise, quality, portionId } starts retranscribe-range in the background and
// answers { job, status } right away; the page follows {folder}/retranscribe/jobs/{job}.json. Only JSON is accepted,
// which makes browsers ask permission first for any other website's request, and this server never grants it.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function handleRetranscribe(request, response, roots) {
  const url = new URL(request.url || '/', 'http://localhost');
  const [, rootSlug, ...restParts] = decodeURIComponent(url.pathname || '/').split('/');
  const root = roots.find((entry) => entry.slug === rootSlug);
  if (!root || restParts.at(-1) !== 'retranscribe') {
    return writeText(response, 'POST', 404, 'Not found');
  }
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) {
    return writeText(response, 'POST', 415, 'Expected application/json');
  }
  const sessionDir = path.resolve(root.dir, restParts.slice(0, -1).join('/'));
  if (!sessionDir.startsWith(root.dir + path.sep) || !(await fileExists(path.join(sessionDir, 'segments.jsonl')))) {
    return writeText(response, 'POST', 404, 'Not a captured session or meeting folder');
  }
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 10000) return writeText(response, 'POST', 413, 'Too large');
  }
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return writeText(response, 'POST', 400, 'Not valid JSON');
  }
  const number = (value, low, high) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= low && parsed <= high ? parsed : null;
  };
  const args = ['--session', sessionDir];
  if (input.action === 'remove') {
    if (!/^[a-z0-9-]{1,40}$/.test(String(input.portionId || ''))) return writeText(response, 'POST', 400, 'Expected portionId');
    args.push('--remove', input.portionId);
  } else if (['preview', 'transcribe', 'peaks', 'clip'].includes(input.action)) {
    const from = number(input.from, 0, 86400);
    const to = number(input.to, 0, 86400);
    const gain = number(input.gainDb ?? 0, -10, 40);
    const highpass = number(input.highpassHz ?? 0, 0, 500);
    if (from === null || to === null || !(to > from) || gain === null || highpass === null) {
      return writeText(response, 'POST', 400, 'Expected from < to (seconds), gainDb -10..40, highpassHz 0..500');
    }
    args.push('--from', String(from), '--to', String(to), '--gain', String(gain), '--highpass', String(highpass),
      '--quality', input.quality === 'quick' ? 'quick' : 'thorough');
    if (input.normalize) args.push('--normalize');
    if (input.denoise) args.push('--denoise');
    if (input.action === 'preview') args.push('--preview');
    if (input.action === 'peaks') args.push('--peaks');
    if (input.action === 'clip') args.push('--clip', ...(input.accurate ? ['--accurate'] : []));
  } else {
    return writeText(response, 'POST', 400, 'Unknown action');
  }
  const job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  args.push('--job', job);
  const jobsDir = path.join(sessionDir, 'retranscribe', 'jobs');
  await fs.promises.mkdir(jobsDir, { recursive: true });
  await fs.promises.writeFile(path.join(jobsDir, `${job}.json`), `${JSON.stringify({ id: job, action: input.action, status: 'queued', updatedAt: new Date().toISOString() }, null, 2)}\n`);
  const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'retranscribe-range.js'), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (error) => console.error(`retranscribe job ${job}: ${error.message}`));
  console.log(`Started ${input.action} job ${job} for ${path.relative(root.dir, sessionDir)}`);
  response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ job, status: 'queued', statusUrl: `retranscribe/jobs/${job}.json` }));
}

function renderRootIndex(roots) {
  const rows = roots.map((root) => {
    return `<li><a href="/${escapeHtml(root.slug)}/">${escapeHtml(root.label)}</a> <code>${escapeHtml(root.dir)}</code></li>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Local Archive Server</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f6f3ed; color: #1b1b1b; }
    main { max-width: 960px; margin: 0 auto; padding: 24px; }
    section { background: white; border: 1px solid #d8cfbf; border-radius: 16px; padding: 20px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
    li + li { margin-top: 10px; }
    a { color: #114b5f; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Local Archive Server</h1>
      <p>Open one of the mounted archive roots below over <code>http://</code> instead of <code>file://</code>.</p>
      <ul>
        ${rows}
      </ul>
    </section>
  </main>
</body>
</html>`;
}

async function renderDirectoryIndex(root, directoryPath, requestPath) {
  const entries = (await fs.promises.readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => !isIgnoredName(entry.name));
  entries.sort((left, right) => {
    if (left.isDirectory() !== right.isDirectory()) {
      return left.isDirectory() ? -1 : 1;
    }
    return left.name.localeCompare(right.name);
  });

  const parentHref = requestPath === `/${root.slug}/`
    ? '/'
    : requestPath.replace(/\/[^/]+\/?$/, '/') || `/${root.slug}/`;

  const items = entries.map((entry) => {
    const suffix = entry.isDirectory() ? '/' : '';
    const href = `${requestPath.replace(/\/?$/, '/')}${encodeURIComponent(entry.name)}${suffix}`;
    const label = `${entry.name}${suffix}`;
    return `<li><a href="${escapeHtml(href)}">${escapeHtml(label)}</a></li>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(requestPath)}</title>
  <style>
    body { font-family: Georgia, "Times New Roman", serif; margin: 0; background: #f6f3ed; color: #1b1b1b; }
    main { max-width: 1100px; margin: 0 auto; padding: 24px; }
    section { background: white; border: 1px solid #d8cfbf; border-radius: 16px; padding: 20px; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em; }
    li + li { margin-top: 8px; }
    a { color: #114b5f; }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>${escapeHtml(requestPath)}</h1>
      <p><a href="${escapeHtml(parentHref)}">Up</a> <code>${escapeHtml(directoryPath)}</code></p>
      <ul>
        ${items}
      </ul>
    </section>
  </main>
</body>
</html>`;
}

function streamFile(response, request, method, filePath, stats) {
  const totalSize = Number(stats.size || 0);
  const contentType = contentTypeFor(filePath);
  const rangeHeader = String(request.headers.range || '').trim();

  if (rangeHeader) {
    const range = parseRange(rangeHeader, totalSize);
    if (!range) {
      response.writeHead(416, {
        'content-range': `bytes */${totalSize}`
      });
      response.end();
      return;
    }

    response.writeHead(206, {
      'accept-ranges': 'bytes',
      'content-length': range.end - range.start + 1,
      'content-range': `bytes ${range.start}-${range.end}/${totalSize}`,
      'content-type': contentType
    });

    if (method === 'HEAD') {
      response.end();
      return;
    }

    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
    return;
  }

  response.writeHead(200, {
    'accept-ranges': 'bytes',
    'content-length': totalSize,
    'content-type': contentType
  });

  if (method === 'HEAD') {
    response.end();
    return;
  }

  fs.createReadStream(filePath).pipe(response);
}

function parseRange(value, totalSize) {
  const match = String(value || '').match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) {
    return null;
  }

  let start = match[1] ? Number.parseInt(match[1], 10) : null;
  let end = match[2] ? Number.parseInt(match[2], 10) : null;

  if (start === null && end === null) {
    return null;
  }

  if (start === null) {
    const suffixLength = end;
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
      return null;
    }
    if (end === null || !Number.isFinite(end) || end >= totalSize) {
      end = totalSize - 1;
    }
  }

  if (end < start) {
    return null;
  }

  return { start, end };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.pdf':
      return 'application/pdf';
    case '.mp4':
      return 'video/mp4';
    case '.m4a':
      return 'audio/mp4';
    case '.wav':
      return 'audio/wav';
    case '.m3u8':
      return 'application/vnd.apple.mpegurl';
    case '.ts':
      return 'video/mp2t';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.svg':
      return 'image/svg+xml';
    case '.webp':
      return 'image/webp';
    default:
      return 'application/octet-stream';
  }
}

function containsIgnoredPathSegment(relativePath) {
  return String(relativePath || '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => isIgnoredName(segment));
}

function isIgnoredName(value) {
  const name = String(value || '').trim();
  return name.startsWith('._');
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function writeHtml(response, method, statusCode, html) {
  response.writeHead(statusCode, { 'content-type': 'text/html; charset=utf-8' });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  response.end(html);
}

function writeText(response, method, statusCode, text) {
  response.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  if (method === 'HEAD') {
    response.end();
    return;
  }
  response.end(text);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
