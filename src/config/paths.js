import path from 'path';
import { fileURLToPath } from 'url';

// Where things are in the repository: the root, and bin/ with one entry point per npm command (what one tool runs to
// start another, as a child process).
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN_DIR = path.join(REPO_ROOT, 'bin');
export const binPath = (command) => path.join(BIN_DIR, command.endsWith('.js') ? command : `${command}.js`);
