// Tasks on a meeting (src/recorder/prompts.js): the meeting's record fills the prompt (transcript with speakers,
// chapters, votes, earlier meetings), a pretend Ollama answers (a long transcript is read in parts first), the answer
// is saved; automatic tasks are queued for meetings finished since they were marked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SyncClient } from '../src/sync/client.js';
import { MemoryStore } from '../src/sync/stores/memory.js';
import { meetingRecord, queueAutoPrompts, runPrompt } from '../src/recorder/prompts.js';
import { fillPrompt, SUGGESTED_PROMPTS } from '../src/sync/prompts.js';

async function meeting(lines) {
  const client = new SyncClient({ store: new MemoryStore() });
  await client.put('recordings', 'm1', {
    title: 'Town council',
    sourceKey: 'town',
    sourceName: 'Town',
    status: 'done',
    startedAt: '2026-10-06T22:00:00Z',
    stoppedAt: '2026-10-06T23:00:00Z'
  });
  await client.put('recordings', 'm0', {
    title: 'Town council',
    sourceKey: 'town',
    status: 'done',
    startedAt: '2026-09-01T22:00:00Z'
  });
  await client.put('transcript_chunks', 'm1:final:0', { recordingId: 'm1', kind: 'final', part: 'p0', from: 0, lines });
  await client.put('marks', 'town:people', {
    people: [
      { id: 'mayor', name: 'Pat Lee', role: 'Mayor' },
      { id: 'res', name: 'Sam Ortiz' }
    ]
  });
  await client.put('marks', 'm1:p0:speakers', {
    turns: [
      { at: 0, speakers: ['mayor'] },
      { at: 30, speakers: ['res'] }
    ]
  });
  await client.put('marks', 'm1:p0:agenda', { items: [{ at: 25, title: 'Broadband' }] });
  await client.put('marks', 'm0:p0:agenda', { items: [{ at: 10, title: 'Broadband grant' }] });
  await client.put('marks', 'm1:p0:votes', {
    votes: [{ at: 50, motion: 'Approve the grant', changes: [{ member: 'mayor', choice: 'for' }] }]
  });
  return client;
}

test('the meeting record fills a prompt', async () => {
  const client = await meeting([
    { start: 5, end: 9, text: 'The meeting will come to order.' },
    { start: 31, end: 35, text: 'I support broadband.' }
  ]);
  const record = await meetingRecord(client, 'm1');
  assert.equal(
    record.transcript,
    '[0:00:05] Pat Lee (Mayor): The meeting will come to order.\n[0:00:31] Sam Ortiz: I support broadband.'
  );
  assert.equal(record.chapters, '[0:00:25] Broadband');
  assert.equal(record.votes, '[0:00:50] Approve the grant: Pat Lee (Mayor) for');
  assert.equal(record.pastMeetings, 'Town council, 2026-09-01: Broadband grant');
  assert.match(fillPrompt(SUGGESTED_PROMPTS[0].prompt, record), /Town council \(Town\), 2026-10-06/);
  assert.equal(fillPrompt('{{title}} {{unknown}}', { title: 'A' }), 'A {{unknown}}');
});

test('a task run with Ollama (a long transcript read in parts), and automatic tasks queued', async () => {
  const asked = [];
  const ollama = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      const content = JSON.parse(body).messages[0].content;
      asked.push(content);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ message: { content: content.startsWith('Take careful notes') ? 'notes' : 'The summary.' } })
      );
    });
  });
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  try {
    const long = Array.from({ length: 1500 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 2,
      text: 'word '.repeat(10)
    }));
    const client = await meeting(long);
    await client.put('prompts', 'summary', { name: 'Summary', prompt: 'Summarize {{title}}:\n{{transcript}}' });
    const steps = [];
    const result = await runPrompt(
      { recordingId: 'm1', promptId: 'summary' },
      {
        client,
        // The agent's server, and its default model (the task names none).
        servers: [
          {
            label: 'Ollama',
            kind: 'ollama',
            ok: true,
            url: `http://127.0.0.1:${ollama.address().port}`,
            models: [{ name: 'palace-9:f16' }, { name: 'llama3.1:8b' }]
          }
        ],
        taskModel: 'llama3.1:8b',
        signal: undefined,
        progress: (_, message) => steps.push(message)
      }
    );
    assert.equal(result.model, 'llama3.1:8b');
    assert.ok(asked.length >= 3, `read in parts, then summarized (${asked.length} requests)`);
    assert.match(asked.at(-1), /^Summarize Town council:\n\(Notes on the transcript, part by part:\)/);
    assert.equal((await client.get('prompt_results', 'm1:summary')).data.text, 'The summary.');
    assert.ok(steps.some((step) => step.startsWith('Reading part 1 of')));

    // Automatic: only for meetings finished after it was marked, and not twice.
    await client.put('prompts', 'minutes', {
      name: 'Minutes',
      prompt: '{{transcript}}',
      auto: true,
      autoSince: '2026-10-01T00:00:00Z'
    });
    assert.equal(await queueAutoPrompts(client), 1);
    assert.equal((await client.get('jobs', 'prompt-m1-minutes')).data.type, 'prompt');
    assert.equal(await queueAutoPrompts(client), 0);
  } finally {
    ollama.close();
  }
});
