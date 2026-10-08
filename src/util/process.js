import path from 'path';
import { spawn } from 'child_process';
import { fileExists } from './fs-utils.js';

// Runs a command and resolves with its stdout. Rejects with stderr (or stdout) when it exits non-zero.
export async function runCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(command)} exited with code ${code}`));
    });
  });
}

// Returns the full path of a command found on PATH, or '' when it is not installed.
// A command that already contains a path separator is checked as-is.
export async function findCommandPath(command) {
  if (command.includes(path.sep)) {
    return (await fileExists(command)) ? command : '';
  }
  const envPath = String(process.env.PATH || '');
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, command);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return '';
}
