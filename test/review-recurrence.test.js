import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

for (const [rule, count] of [
  ['BYMONTHDAY=30', 0],
  ['BYDAY=6MO', 0],
  ['BYMONTHDAY=28', 1]
]) {
  test(`SS-03: bounded February recurrence ${rule}`, async () => {
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      import(${JSON.stringify(new URL('../src/sync/recurrence.js', import.meta.url).href)}).then(({ occurrences }) => {
        parentPort.postMessage(occurrences({ id: 's', start: '2026-02-01T10:00', timeZone: 'UTC',
          rrule: 'FREQ=MONTHLY;INTERVAL=12;${rule}' }, Date.parse('2026-02-01Z'), Date.parse('2026-03-01Z')).length);
      });`,
      { eval: true }
    );
    try {
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('recurrence exceeded 2 second deadline')), 2000);
        worker.once('message', (value) => {
          clearTimeout(timer);
          resolve(value);
        });
        worker.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      assert.equal(result, count);
    } finally {
      await worker.terminate();
    }
  });
}
