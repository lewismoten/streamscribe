import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { REPO_ROOT } from './paths.js';

// The version an agent reports, as people compare versions: major.minor from package.json, and the build number as the
// patch (how many commits its code has, so a newer build always has a bigger number), such as 1.0.78. From build.json
// (written into the agent package by bin/deploy-hub.sh), else counted with git when it runs from a copy of the
// repository ("-dev" when that has uncommitted changes). Older packages, with only a commit, read 1.0.0+<commit>.
export function buildVersion(root = REPO_ROOT) {
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const majorMinor = version.split('.').slice(0, 2).join('.');
  try {
    const build = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
    if (build.version) return build.version;
    if (build.commit) return `${version}+${build.commit}`;
  } catch {
    /* not a deployed package */
  }
  if (!fs.existsSync(path.join(root, '.git'))) return version;
  try {
    const git = (args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const count = git(['rev-list', '--count', 'HEAD']).trim();
    const dirty = git(['status', '--porcelain', '--untracked-files=no']).trim() ? '-dev' : '';
    return `${majorMinor}.${count}${dirty}`;
  } catch {
    return version;
  }
}
