import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from './paths.js';

// The version an agent reports: package.json's, with the commit it was built from, so the Agents page shows which
// agents run the newest code: from build.json (written into the agent package by bin/deploy-hub.sh), else from git
// when it runs from a copy of the repository (with "dirty" when that has uncommitted changes).
//   1.0.0+084f65d, 1.0.0+084f65d.dirty, or 1.0.0
export function buildVersion(root = REPO_ROOT) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  try {
    const build = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
    if (build.commit) return `${version}+${build.commit}`;
  } catch {
    /* not a deployed package */
  }
  if (!fs.existsSync(path.join(root, '.git'))) return version;
  try {
    const git = (args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const commit = git(['rev-parse', '--short', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim() ? '.dirty' : '';
    return `${version}+${commit}${dirty}`;
  } catch {
    return version;
  }
}
