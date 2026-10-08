import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import { STATE_ROOT } from '../config/runtime-config.js';

const execFileAsync = promisify(execFile);
const sourcePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ocr.swift');
const binaryPath = path.join(STATE_ROOT, 'bin', 'ocr');
let ready = null;

// The text in an image (lines joined by spaces), read with macOS's built-in text recognition, or '' where that isn't
// available (another system, or no Swift compiler: install Xcode's command line tools). The small reader is compiled
// once into {state}/bin/ocr.
export async function readImageText(imagePath) {
  ready ??= prepare();
  if (!(await ready)) return '';
  try {
    const { stdout } = await execFileAsync(binaryPath, [imagePath], { timeout: 30000 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ');
  } catch {
    return '';
  }
}

async function prepare() {
  if (process.platform !== 'darwin') return false;
  try {
    if (fs.existsSync(binaryPath) && fs.statSync(binaryPath).mtimeMs >= fs.statSync(sourcePath).mtimeMs) return true;
    fs.mkdirSync(path.dirname(binaryPath), { recursive: true });
    await execFileAsync('swiftc', ['-O', sourcePath, '-o', binaryPath], { timeout: 180000 });
    return true;
  } catch {
    return false;
  }
}
