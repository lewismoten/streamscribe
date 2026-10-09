// The language-model servers an agent uses for tasks (prompts.js): its Ollama server, and more set on the Agents page
// (agent_settings llmServers: [{ label, url, kind }]), each either
//   ollama   an Ollama server: GET /api/tags, POST /api/chat
//   openai   an OpenAI-style server (llama.cpp's server, vLLM, LM Studio, …): GET /v1/models, POST /v1/chat/completions
// A machine may run only some of them at a time (swapping models on its GPUs), so each is checked every minute and a
// task goes to a server that answers now with the model it needs.
export const LLM_KINDS = ['ollama', 'openai'];
const base = (url) => String(url || '').replace(/\/+$/, '');
const openaiBase = (url) => base(url).replace(/\/v1$/, '');

export async function listModels(server, { fetchUrl = fetch } = {}) {
  const started = Date.now();
  const kind = server.kind === 'openai' ? 'openai' : 'ollama';
  const checked = { label: server.label || '', url: server.url, kind, checkedAt: new Date().toISOString() };
  try {
    const url = kind === 'openai' ? `${openaiBase(server.url)}/v1/models` : `${base(server.url)}/api/tags`;
    const response = await fetchUrl(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { ...checked, ok: false, error: `answered ${response.status}` };
    const body = await response.json();
    const models =
      kind === 'openai'
        ? (body.data || []).map((model) => ({ name: String(model.id), sizeGb: null }))
        : (body.models || []).map((model) => ({
            name: model.name,
            sizeGb: Math.round((model.size || 0) / 1e8) / 10
          }));
    return { ...checked, ok: true, ms: Date.now() - started, models };
  } catch (error) {
    return { ...checked, ok: false, error: error.cause?.code || error.message };
  }
}

// The server (of an agent's checked ones) that answers now and has the model; null if none.
export const serverFor = (servers, model) =>
  (servers || []).find((server) => server.ok && (server.models || []).some((item) => item.name === model)) || null;

// The model a task runs with: the one it names, else the agent's default for tasks; null when neither is set (an agent
// then leaves it for one that has a default).
export const modelFor = (prompt, taskModel) => prompt?.model || taskModel || null;

export async function chat(server, model, content, { signal, fetchUrl = fetch } = {}) {
  if (server.kind === 'openai') {
    const response = await fetchUrl(`${openaiBase(server.url)}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content }], temperature: 0.3, stream: false }),
      signal
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${server.label || server.url}: ${value.error?.message || response.status}`);
    return String(value.choices?.[0]?.message?.content || '').trim();
  }
  const response = await fetchUrl(`${base(server.url)}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [{ role: 'user', content }],
      options: { num_ctx: 32768, temperature: 0.3 }
    }),
    signal
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Ollama: ${value.error || response.status}`);
  return String(value.message?.content || '').trim();
}
