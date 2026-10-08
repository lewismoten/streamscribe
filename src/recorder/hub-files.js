import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { REPO_ROOT } from '../config/paths.js';
import { run } from '../media/encode.js';

// Large files for the hub (meetings' audio and video, published clips) go over SSH with rsync: the hub's upload
// limit is far too small for them. Settings as for bin/deploy-hub.sh: DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH (and
// DEPLOY_PORT, DEPLOY_SSH_OPTIONS), from the environment or deploy.local.env (STREAMSCRIBE_DEPLOY_ENV names another
// file, or none: tests point it at an empty one so nothing reaches a real server). Two places on the hub:
//   'private'  meetings' files, outside the web folder (records name them private/…)
//   'public'   published files, in the hub's media/ (records name them media/…)

export function deploySettings() {
  const settings = {};
  const file = process.env.STREAMSCRIBE_DEPLOY_ENV ?? path.join(REPO_ROOT, 'deploy.local.env');
  if (file && fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z_]+)=(.*)$/);
      if (!match) continue;
      settings[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/\$HOME|\$\{HOME\}/g, os.homedir()).replace(/^~(?=\/)/, os.homedir());
    }
  }
  for (const name of ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_PATH', 'DEPLOY_PORT', 'DEPLOY_SSH_OPTIONS', 'REMOTE_PHP']) if (process.env[name]) settings[name] = process.env[name];
  return settings;
}

export const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
export const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
export const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';

export function hubFiles(settings = deploySettings()) {
  const configured = Boolean(settings.DEPLOY_HOST && settings.DEPLOY_USER && settings.DEPLOY_PATH);
  const options = ['-p', settings.DEPLOY_PORT || '22', '-o', 'BatchMode=yes', ...(settings.DEPLOY_SSH_OPTIONS || '').split(/\s+/).filter(Boolean)];
  const remote = `${settings.DEPLOY_USER}@${settings.DEPLOY_HOST}`;
  const ssh = (command, signal) => run('ssh', [...options, remote, command], { signal });
  let places = null;
  // Where the hub keeps each kind of file (asked of the hub itself, once).
  const place = async (area) => {
    places ??= JSON.parse((await ssh(`cd ${quote(`${settings.DEPLOY_PATH}/hub`)} && ${settings.REMOTE_PHP || 'php'} tools/paths.php`)).stdout);
    return area === 'private' ? places.private_dir : places.media_dir;
  };
  const prefix = (area) => (area === 'private' ? 'private/' : 'media/');
  return {
    configured,
    // Sends files into one folder of the hub (relative to the area) and removes others there unless keepOthers.
    // Returns each file's path as records name it.
    async sendFolder(area, folder, files, { keepOthers = false, signal } = {}) {
      if (!configured) throw new Error('Uploading needs DEPLOY_HOST, DEPLOY_USER, and DEPLOY_PATH (deploy.local.env; see docs/hub/deploy.md)');
      const target = `${await place(area)}/${folder}`;
      await ssh(`mkdir -p ${quote(target)}`, signal);
      for (const file of files) {
        await run('rsync', ['--checksum', '--partial', '-e', ['ssh', ...options].join(' '), file.local, `${remote}:${target}/${file.name}`], { signal });
      }
      if (!keepOthers) await ssh(`find ${quote(target)} -maxdepth 1 -type f ${files.map((file) => `! -name ${quote(file.name)}`).join(' ')} -delete`, signal);
      return files.map((file) => `${prefix(area)}${folder}/${file.name}`);
    },
    // Removes a file the records name (private/… or media/…).
    async remove(recordPath) {
      const area = recordPath.startsWith('private/') ? 'private' : 'public';
      await ssh(`rm -f ${quote(`${await place(area)}/${recordPath.slice(prefix(area).length)}`)}`);
    }
  };
}
