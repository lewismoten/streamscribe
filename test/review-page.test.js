// The review page's script (src/review-page/client/*.js, joined in CLIENT_PARTS order into one script).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CLIENT_PARTS } from '../src/review-page/page.js';

const clientDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'review-page', 'client');
const sources = CLIENT_PARTS.map((name) => ({
  name,
  text: fs.readFileSync(path.join(clientDir, `${name}.js`), 'utf8')
}));

test('every client file is listed in CLIENT_PARTS exactly once', () => {
  const files = fs
    .readdirSync(clientDir)
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.slice(0, -3))
    .sort();
  assert.deepEqual([...CLIENT_PARTS].sort(), files);
  assert.equal(new Set(CLIENT_PARTS).size, CLIENT_PARTS.length);
});

test('the joined parts parse as one script', () => {
  // new Function only parses the body; nothing in it runs.
  const script = sources.map((source) => source.text).join('');
  assert.doesNotThrow(() => new Function(script));
});

test('no top-level name is declared in two parts', () => {
  const declaration = /^(?:async function\*?|function\*?|let|const|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  const seen = new Map();
  const twice = [];
  for (const { name, text } of sources) {
    for (const [, identifier] of text.matchAll(declaration)) {
      if (seen.has(identifier)) twice.push(`${identifier} (${seen.get(identifier)} and ${name})`);
      else seen.set(identifier, name);
    }
  }
  assert.deepEqual(twice, []);
});
