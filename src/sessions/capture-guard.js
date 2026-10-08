import path from 'path';
import { execFileSync } from 'child_process';
import { STATE_ROOT, SOURCES } from '../config/runtime-config.js';
import { loadJson, writeJsonAtomically } from '../util/fs-utils.js';

// For tools that rearrange session folders: wait until captures and session tools have stopped, and drop a folder
// from the capture state.

// A running capture keeps its session in the state file; drop it so a restart rebuilds from the folders.
export async function forgetCaptureState(sessionDir) {
  for (const source of SOURCES) {
    const statePath = path.join(STATE_ROOT, `capture-${source.key.replace(/[^a-z0-9-]+/gi, '-')}-state.json`);
    const state = await loadJson(statePath);
    if (!state?.captures) {
      continue;
    }
    let changed = false;
    for (const [key, capture] of Object.entries(state.captures)) {
      if (path.resolve(String(capture?.sessionDir || '')) === sessionDir) {
        delete state.captures[key];
        changed = true;
      }
    }
    if (changed) {
      await writeJsonAtomically(statePath, state);
    }
  }
}

export function assertCaptureStopped(action = 'splitting') {
  const running = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    // Only processes that are Node itself running one of these scripts (not a shell whose command mentions them).
    .filter((line) =>
      /^\s*\d+\s+(\S*\/)?node\s+(\S+\s+)*\S*(bin|scripts)\/(capture|transcribe|extract-slides|extract-thumbnails)\.js/.test(
        line
      )
    );
  if (running.length > 0) {
    throw new Error(
      `Wait for these to finish (or stop them) before ${action}:\n${running.map((line) => `  ${line.trim()}`).join('\n')}`
    );
  }
}
