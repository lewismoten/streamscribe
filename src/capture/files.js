import { appendFile, rename, rm, writeFile } from 'fs/promises';

// Small file helpers for capture sessions.

export function sanitizeSegment(value) {
  return (
    String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'stream'
  );
}

export async function appendJsonLine(filePath, value) {
  await appendFile(filePath, `${JSON.stringify(value)}\n`);
}

export async function writeTextAtomically(filePath, value) {
  const tempPath = `${filePath}.download`;
  await rm(tempPath, { force: true });
  await writeFile(tempPath, String(value || ''));
  await rename(tempPath, filePath);
}

export async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}
