import fs from 'fs';
import path from 'path';
import { mkdir } from 'fs/promises';

const VOLUMES_ROOT = path.join(path.sep, 'Volumes');

export function assertMountedPathSync(targetPath, label = 'Target path') {
  const issue = getMountedPathIssueSync(targetPath, label);
  if (issue) {
    throw new Error(issue);
  }
}

export async function assertMountedPath(targetPath, label = 'Target path') {
  const issue = await getMountedPathIssue(targetPath, label);
  if (issue) {
    throw new Error(issue);
  }
}

export async function mkdirChecked(targetPath, options) {
  await assertMountedPath(targetPath, 'Directory target');
  return await mkdir(targetPath, options);
}

export function getVolumeRoot(targetPath) {
  const normalizedPath = normalizePath(targetPath);
  if (!normalizedPath.startsWith(`${VOLUMES_ROOT}${path.sep}`)) {
    return '';
  }

  const relativePath = path.relative(VOLUMES_ROOT, normalizedPath);
  const [volumeName] = relativePath.split(path.sep).filter(Boolean);
  return volumeName ? path.join(VOLUMES_ROOT, volumeName) : '';
}

async function getMountedPathIssue(targetPath, label) {
  const volumeRoot = getVolumeRoot(targetPath);
  if (!volumeRoot) {
    return '';
  }

  const [parentStats, volumeStats] = await Promise.all([
    safeStat(VOLUMES_ROOT),
    safeStat(volumeRoot)
  ]);

  return formatMountIssue({
    targetPath,
    label,
    volumeRoot,
    parentStats,
    volumeStats
  });
}

function getMountedPathIssueSync(targetPath, label) {
  const volumeRoot = getVolumeRoot(targetPath);
  if (!volumeRoot) {
    return '';
  }

  const parentStats = safeStatSync(VOLUMES_ROOT);
  const volumeStats = safeStatSync(volumeRoot);

  return formatMountIssue({
    targetPath,
    label,
    volumeRoot,
    parentStats,
    volumeStats
  });
}

function formatMountIssue({ targetPath, label, volumeRoot, parentStats, volumeStats }) {
  const normalizedTargetPath = normalizePath(targetPath);
  const normalizedLabel = String(label || 'Target path');

  if (!volumeStats) {
    return `${normalizedLabel} is configured under ${volumeRoot}, but that volume is not currently mounted. Expected path: ${normalizedTargetPath}. Reconnect or remount the volume before rerunning this script.`;
  }

  if (!parentStats) {
    return `${normalizedLabel} is configured under ${volumeRoot}, but ${VOLUMES_ROOT} is unavailable. Expected path: ${normalizedTargetPath}. Reconnect or remount the volume before rerunning this script.`;
  }

  if (volumeStats.dev === parentStats.dev) {
    return `${normalizedLabel} is configured under ${volumeRoot}, but that path is acting like a normal local folder instead of a mounted volume. Expected path: ${normalizedTargetPath}. This usually means the volume was disconnected and macOS left behind an undetected mount point. Reconnect or remount the volume before rerunning this script.`;
  }

  return '';
}

function normalizePath(targetPath) {
  return path.resolve(String(targetPath || ''));
}

async function safeStat(targetPath) {
  try {
    return await fs.promises.stat(targetPath);
  } catch {
    return null;
  }
}

function safeStatSync(targetPath) {
  try {
    return fs.statSync(targetPath);
  } catch {
    return null;
  }
}
