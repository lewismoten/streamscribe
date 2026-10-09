// An agent's language-model servers for tasks (src/recorder/llm.js): Ollama and OpenAI-style servers listed and asked
// alike; one that's off (swapped out for another on the GPUs) doesn't count; and a task goes only to a server with its
// model, or the agent's default when the task names none.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chat, listModels, modelFor, serverFor } from '../src/recorder/llm.js';

const serve = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const [status, value] = handler(request.url, body ? JSON.parse(body) : null);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

test('Ollama and OpenAI-style servers, and which takes a task', async () => {
  const ollama = await serve((url, body) =>
    url === '/api/tags'
      ? [200, { models: [{ name: 'qwen3:8b', size: 5.2e9 }] }]
      : [200, { message: { content: ` ollama says ${body.model} ` } }]
  );
  const openai = await serve((url, body) =>
    url === '/v1/models'
      ? [200, { data: [{ id: 'custom-27b' }] }]
      : [200, { choices: [{ message: { content: `openai says ${body.model}: ${body.messages[0].content}` } }] }]
  );
  try {
    const servers = await Promise.all([
      listModels({ label: 'Ollama', url: `http://127.0.0.1:${ollama.address().port}/`, kind: 'ollama' }),
      // (Given with /v1, as such servers often are.)
      listModels({ label: 'Custom', url: `http://127.0.0.1:${openai.address().port}/v1`, kind: 'openai' }),
      listModels({ label: 'Swapped out', url: 'http://127.0.0.1:9', kind: 'openai' })
    ]);
    assert.deepEqual(servers[0].models, [{ name: 'qwen3:8b', sizeGb: 5.2 }]);
    assert.deepEqual(servers[1].models, [{ name: 'custom-27b', sizeGb: null }]);
    assert.equal(servers[2].ok, false);

    assert.equal(serverFor(servers, 'custom-27b').label, 'Custom');
    assert.equal(serverFor(servers, 'qwen3:8b').label, 'Ollama');
    assert.equal(serverFor(servers, 'palace-9:f16'), null, 'nobody has it: not taken');
    assert.equal(modelFor({ model: 'custom-27b' }, 'qwen3:8b'), 'custom-27b', "the task's own model first");
    assert.equal(modelFor({}, 'qwen3:8b'), 'qwen3:8b', "else the agent's default");
    assert.equal(modelFor({}, null), null, 'else not taken by this agent');

    assert.equal(await chat(servers[0], 'qwen3:8b', 'hi'), 'ollama says qwen3:8b');
    assert.equal(await chat(servers[1], 'custom-27b', 'hi'), 'openai says custom-27b: hi');
  } finally {
    ollama.close();
    openai.close();
  }
});
