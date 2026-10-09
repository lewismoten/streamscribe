import { stackMarks } from '../sync/layers.js';
import { officialLinks } from '../sync/official.js';
import { fillPrompt, promptJobId, resultId } from '../sync/prompts.js';
import { chat, modelFor, serverFor } from './llm.js';

// Running a task (a prompt from the hub's `prompts`; see src/sync/prompts.js) on a meeting with a language-model server
// this agent is set up to use (llm.js), one that has the task's model: the meeting's record (transcript with speakers, chapters, votes, pictures, official links,
// earlier meetings) fills the prompt's placeholders, the model answers, and the answer is saved as a `prompt_results`
// record. A transcript too long for one request is read in parts first (notes on each), and the notes stand in for it.
// Tasks marked `auto` are queued for each meeting that finishes (with its final transcript) after they were marked.

const PART_CHARACTERS = 40000;
const time = (seconds) => {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 3600)}:${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

// The meeting's record, as text for each placeholder.
export async function meetingRecord(client, recordingId) {
  const recording = (await client.get('recordings', recordingId))?.data;
  if (!recording) throw new Error('No such meeting');
  const allMarks = await client.list('marks');
  const marks = stackMarks(
    allMarks.filter((mark) => mark.id.startsWith(`${recordingId}:`) || mark.id.startsWith(`${recording.sourceKey}:`)),
    0
  );
  // Earlier meetings' agenda items (for {{pastMeetings}}).
  const agendas = stackMarks(
    allMarks.filter((mark) => mark.id.split('~')[0].endsWith(':agenda')),
    0
  );
  const agendaOf = (id) =>
    [...agendas.entries()]
      .filter(([markId]) => markId.startsWith(`${id}:`))
      .flatMap(([, stack]) => (stack.data?.items || []).map((item) => item.title))
      .filter(Boolean)
      .slice(0, 12);
  const data = (id) => marks.get(id)?.data || {};
  const roster = new Map((data(`${recording.sourceKey}:people`).people || []).map((person) => [person.id, person]));
  const nameOf = (id) => {
    const person = roster.get(id);
    if (!person) return id;
    const name = person.nameUnknown || !person.name ? person.role || 'Unknown' : person.name;
    return person.role && !person.nameUnknown && person.name ? `${name} (${person.role})` : name;
  };
  const chunks = (await client.list('transcript_chunks')).filter((chunk) => chunk.data.recordingId === recordingId);
  const kind = chunks.some((chunk) => chunk.data.kind === 'final') ? 'final' : 'quick';
  const parts = [...new Set(chunks.map((chunk) => chunk.data.part))];
  const transcript = [];
  const chapters = [];
  const votes = [];
  const spoken = new Map();
  for (const part of parts) {
    const turns = [...(data(`${recordingId}:${part}:speakers`).turns || [])].sort((a, b) => a.at - b.at);
    const speakersAt = (at) => turns.filter((turn) => turn.at <= at + 0.05).at(-1)?.speakers || [];
    turns.forEach((turn, index) => {
      const end = turns[index + 1]?.at ?? turn.at;
      for (const id of turn.speakers || []) spoken.set(id, (spoken.get(id) || 0) + Math.max(0, end - turn.at));
    });
    const lines = chunks
      .filter((chunk) => chunk.data.part === part && chunk.data.kind === kind)
      .sort((a, b) => a.data.from - b.data.from)
      .flatMap((chunk) => chunk.data.lines || []);
    let last = '';
    for (const line of lines) {
      const who = speakersAt(line.start).map(nameOf).join(', ');
      transcript.push(`[${time(line.start)}] ${who && who !== last ? `${who}: ` : ''}${line.text}`);
      last = who || last;
    }
    for (const item of data(`${recordingId}:${part}:agenda`).items || [])
      chapters.push(`[${time(item.at)}] ${item.title}`);
    for (const vote of data(`${recordingId}:${part}:votes`).votes || []) {
      const how = (vote.changes || [])
        .map((change) => `${nameOf(change.member || change.id || change.personId || '')} ${change.choice}`.trim())
        .filter(Boolean)
        .join('; ');
      votes.push(
        `[${time(vote.at)}] ${vote.motion || 'Motion'}${vote.result ? ` (${vote.result})` : ''}${how ? `: ${how}` : ''}`
      );
    }
  }
  const stills = (await client.list('stills'))
    .filter((still) => still.data.recordingId === recordingId)
    .map((still) => time(still.data.position))
    .slice(0, 400);
  const past = (await client.list('recordings'))
    .filter(
      (item) =>
        item.id !== recordingId &&
        item.data.sourceKey === recording.sourceKey &&
        String(item.data.startedAt) < String(recording.startedAt)
    )
    .sort((a, b) => String(b.data.startedAt).localeCompare(String(a.data.startedAt)))
    .slice(0, 30)
    .map((item) => {
      const titles = agendaOf(item.id);
      return `${item.data.title}, ${String(item.data.startedAt).slice(0, 10)}${titles.length ? `: ${titles.join('; ')}` : ''}`;
    });
  return {
    title: recording.title || '',
    date: String(recording.startedAt || recording.scheduledStart || '').slice(0, 10),
    body: recording.sourceName || recording.sourceKey || '',
    transcript: transcript.join('\n'),
    chapters: chapters.join('\n') || '(none marked)',
    votes: votes.join('\n') || '(none marked)',
    speakers:
      [...spoken.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, seconds]) => `${nameOf(id)}: ${Math.round(seconds / 60)} min`)
        .join('\n') || '(not marked)',
    stills: stills.join(', ') || '(none)',
    official: officialLinks(recording.official || null)
      .map((link) => `${link.label}: ${link.url}`)
      .join('\n'),
    pastMeetings: past.join('\n') || '(none)'
  };
}

// Runs a task job: { recordingId, promptId }, with the model it names (or the agent's default for tasks), on the
// agent's server that has it now (llm.js). servers: the agent's checked servers, from its settings report.
export async function runPrompt(job, { client, servers, taskModel, signal, progress }) {
  const prompt = (await client.get('prompts', job.promptId))?.data;
  if (!prompt) throw new Error('The task is gone');
  const model = modelFor(prompt, taskModel);
  if (!model) throw new Error('The task names no model, and this agent has no default model for tasks');
  const server = serverFor(servers, model);
  if (!server) throw new Error(`None of this agent's servers has ${model} now`);
  const started = Date.now();
  progress(0.05, 'Gathering the meeting');
  const values = await meetingRecord(client, job.recordingId);
  if (!values.transcript) throw new Error('This meeting has no transcript yet');
  // A long transcript: notes on each part first.
  if (values.transcript.length > PART_CHARACTERS) {
    const lines = values.transcript.split('\n');
    const pieces = [];
    let piece = [];
    for (const line of lines) {
      if (piece.join('\n').length + line.length > PART_CHARACTERS && piece.length) {
        pieces.push(piece.join('\n'));
        piece = [];
      }
      piece.push(line);
    }
    if (piece.length) pieces.push(piece.join('\n'));
    const notes = [];
    for (const [index, text] of pieces.entries()) {
      progress(0.1 + (0.6 * index) / pieces.length, `Reading part ${index + 1} of ${pieces.length}`);
      notes.push(
        await chat(
          server,
          model,
          `Take careful notes on this part of a public meeting (${values.title}, ${values.date}): every topic, decision, motion and vote, figure, and name, each with its [h:mm:ss] time, and quote anything notable word for word.\n\n${text}`,
          { signal }
        )
      );
    }
    values.transcript = `(Notes on the transcript, part by part:)\n\n${notes.join('\n\n')}`;
  }
  progress(0.75, `Asking ${model}`);
  const text = await chat(server, model, fillPrompt(prompt.prompt, values), { signal });
  const id = resultId(job.recordingId, job.promptId);
  await client.put('prompt_results', id, {
    recordingId: job.recordingId,
    promptId: job.promptId,
    name: prompt.name,
    model,
    server: server.label || server.url,
    text,
    seconds: Math.round((Date.now() - started) / 1000),
    createdAt: new Date().toISOString()
  });
  return { resultId: id, model };
}

// Tasks marked to run after each meeting: queued for meetings finished (with a final transcript) since they were
// marked, unless already queued or done.
export async function queueAutoPrompts(client) {
  const prompts = (await client.list('prompts')).filter((record) => record.data.auto && record.data.autoSince);
  if (!prompts.length) return 0;
  const jobs = new Set((await client.list('jobs')).map((record) => record.id));
  const results = new Set((await client.list('prompt_results')).map((record) => record.id));
  const finals = new Set(
    (await client.list('transcript_chunks'))
      .filter((chunk) => chunk.data.kind === 'final')
      .map((chunk) => chunk.data.recordingId)
  );
  let queued = 0;
  for (const recording of await client.list('recordings')) {
    if (recording.data.status !== 'done' || !finals.has(recording.id)) continue;
    for (const prompt of prompts) {
      if (String(recording.data.stoppedAt || recording.data.startedAt) < prompt.data.autoSince) continue;
      if (prompt.data.sourceKeys?.length && !prompt.data.sourceKeys.includes(recording.data.sourceKey)) continue;
      const id = promptJobId(recording.id, prompt.id);
      if (jobs.has(id) || results.has(resultId(recording.id, prompt.id))) continue;
      await client.put('jobs', id, {
        type: 'prompt',
        status: 'queued',
        title: `${prompt.data.name}: ${recording.data.title}`,
        recordingId: recording.id,
        promptId: prompt.id,
        progress: 0,
        message: '',
        agent: null,
        createdAt: new Date().toISOString(),
        createdBy: 'automatic'
      });
      queued += 1;
    }
  }
  return queued;
}
