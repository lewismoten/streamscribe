import fs from 'fs';
import path from 'path';
import { readFile } from 'fs/promises';
import { fileExists, loadJson } from '../../util/fs-utils.js';

// The captured sessions (and their segment lists) to look through.

export async function findSessions(source) {
  const root = String(source.liveStorageDir || '').trim();
  const sessions = [];
  let captureDirectories = [];
  try {
    captureDirectories = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return sessions;
  }
  for (const captureDirectory of captureDirectories) {
    if (!captureDirectory.isDirectory()) continue;
    const captureDir = path.join(root, captureDirectory.name);
    let sessionDirectories = [];
    try {
      sessionDirectories = await fs.promises.readdir(captureDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sessionDirectory of sessionDirectories) {
      if (!sessionDirectory.isDirectory()) continue;
      const sessionDir = path.join(captureDir, sessionDirectory.name);
      const manifestPath = path.join(sessionDir, 'segments.jsonl');
      const sessionPath = path.join(sessionDir, 'session.json');
      const session = await loadJson(sessionPath);
      if (await fileExists(manifestPath) && /\/live\//i.test(String(session?.hlsUrl || ''))) {
        sessions.push({ captureId: captureDirectory.name, sessionDir, manifestPath });
      }
    }
  }
  return sessions;
}

export async function loadManifest(filePath) {
  try {
    return (await readFile(filePath, 'utf8')).split(/\r?\n/).flatMap((line) => {
      try {
        const entry = JSON.parse(line);
        return entry && entry.fileName ? [entry] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
