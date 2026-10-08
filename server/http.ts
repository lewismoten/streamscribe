import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

export const contentTypeFor = (filePath: string): string => TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

// Playlists, pages, and data change while a session is captured, so browsers and players always ask again; segments
// and images never change once written.
const freshness = (filePath: string): Record<string, string> => (/\.(m3u8|json|html)$/i.test(filePath) ? { 'cache-control': 'no-cache' } : {});

function parseRange(value: string, totalSize: number): { start: number; end: number } | null {
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!(suffix > 0)) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number(match[1]);
    if (!(start >= 0) || start >= totalSize) return null;
    end = match[2] ? Math.min(Number(match[2]), totalSize - 1) : totalSize - 1;
  }
  return end < start ? null : { start, end };
}

// Sends a file, honoring byte ranges (video players seek with them).
export function sendFile(request: IncomingMessage, response: ServerResponse, filePath: string, stats: fs.Stats) {
  const method = String(request.method || 'GET').toUpperCase();
  const totalSize = stats.size;
  const contentType = contentTypeFor(filePath);
  const rangeHeader = String(request.headers.range || '').trim();
  if (rangeHeader) {
    const range = parseRange(rangeHeader, totalSize);
    if (!range) {
      response.writeHead(416, { 'content-range': `bytes */${totalSize}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      'accept-ranges': 'bytes', 'content-length': range.end - range.start + 1, 'content-range': `bytes ${range.start}-${range.end}/${totalSize}`,
      'content-type': contentType, ...freshness(filePath)
    });
    if (method === 'HEAD') { response.end(); return; }
    fs.createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
    return;
  }
  response.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': totalSize, 'content-type': contentType, ...freshness(filePath) });
  if (method === 'HEAD') { response.end(); return; }
  fs.createReadStream(filePath).pipe(response);
}

export function sendText(response: ServerResponse, status: number, text: string) {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(text);
}

export function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  response.end(JSON.stringify(value));
}

export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
