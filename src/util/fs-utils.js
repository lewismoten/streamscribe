import fs from 'fs';
import path from 'path';
import { readFile, readdir, rename, rm, writeFile } from 'fs/promises';
import { mkdirChecked } from '../config/ensure-mounted-volume.js';

export async function fileExists(filePath) {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function loadJson(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await mkdirChecked(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJsonAtomically(filePath, value) {
  const tempPath = `${filePath}.download`;
  await mkdirChecked(path.dirname(filePath), { recursive: true });
  await rm(tempPath, { force: true });
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tempPath, filePath);
}

export async function listFilesRecursively(rootPath) {
  const entries = await fs.promises.readdir(rootPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

// Lists `.json` file names (not paths) directly inside rootPath, skipping macOS `._` sidecars.
export async function listJsonFiles(rootPath) {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.startsWith('._'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

// Deletes leftover `*.download` temp files from interrupted runs. Returns how many were removed.
export async function removeStaleDownloadFiles(rootDir) {
  let removedCount = 0;
  const pending = [rootDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    let entries = [];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith('.download')) {
        continue;
      }

      await rm(entryPath, { force: true }).catch(() => {});
      removedCount += 1;
    }
  }

  return removedCount;
}
