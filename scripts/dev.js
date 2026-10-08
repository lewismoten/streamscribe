import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

// Works on the web app: the streamscribe server (restarted when its code changes) and Vite (which reloads the app as
// it changes, at http://localhost:5173/, passing /api and /files through to the server).
//   npm run dev
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const children = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=scripts/lib', 'server/index.ts'], { cwd: repoRoot, stdio: 'inherit' }),
  spawn(path.join(repoRoot, 'node_modules', '.bin', 'vite'), [], { cwd: repoRoot, stdio: 'inherit' })
];
const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => { if (code) stop(); });
