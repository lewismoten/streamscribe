import { promptJobId, resultId } from '../../../src/sync/prompts.js';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { syncNow } from '../data/sync.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { date } from '../format.ts';
import type { Prompt, PromptResult } from './types.ts';

// A meeting's tasks (see TasksPage): each one's answer for this meeting, and Run (or Run again) to queue it for an
// agent with a language model; a task being done shows its progress.
const now = () => new Date().toISOString();
interface TaskJob {
  status: string;
  progress?: number;
  message?: string;
  error?: string | null;
}

export default function MeetingTasks({ recordingId, title }: { recordingId: string; title: string }) {
  const account = useAccount();
  const { records: prompts } = useRecords<Prompt>('prompts');
  const { records: results } = useRecords<PromptResult>('prompt_results');
  const { records: jobs } = useRecords<TaskJob>('jobs');
  if (!prompts?.length) return null;
  const runner = can('publish', account);
  const run = async (promptId: string, name: string) => {
    await putRecord('jobs', promptJobId(recordingId, promptId), {
      type: 'prompt',
      status: 'queued',
      title: `${name}: ${title}`,
      recordingId,
      promptId,
      progress: 0,
      message: '',
      agent: null,
      createdAt: now(),
      createdBy: account.user?.displayName || account.user?.username || ''
    });
    syncNow();
  };
  return (
    <section className="panel meeting-tasks">
      <div className="panel-head">
        <h2>Tasks</h2>
        <Link to="/tasks" className="small">
          All tasks
        </Link>
      </div>
      <ul className="task-results">
        {[...prompts]
          .sort((a, b) => a.data.name.localeCompare(b.data.name))
          .map((prompt) => {
            const result = results?.find((item) => item.id === resultId(recordingId, prompt.id))?.data;
            const job = jobs?.find((item) => item.id === promptJobId(recordingId, prompt.id))?.data;
            const busy = job && (job.status === 'queued' || job.status === 'working');
            return (
              <li key={prompt.id}>
                <div className="toolbar small">
                  <strong className="grow">{prompt.data.name}</strong>
                  {busy && (
                    <span className="muted">
                      {job.status === 'queued'
                        ? 'Waiting for an agent'
                        : `${Math.round((job.progress || 0) * 100)}% ${job.message || ''}`}
                    </span>
                  )}
                  {job?.status === 'failed' && <span className="error">{job.error || 'Failed'}</span>}
                  {runner && !busy && (
                    <button type="button" className="button" onClick={() => run(prompt.id, prompt.data.name)}>
                      {result ? 'Run again' : 'Run'}
                    </button>
                  )}
                </div>
                {result && (
                  <details>
                    <summary className="small muted">
                      {result.model} · {date(result.createdAt)} · {result.seconds} s
                    </summary>
                    <div className="task-text">{result.text}</div>
                    <button
                      type="button"
                      className="link-button small"
                      onClick={() => navigator.clipboard?.writeText(result.text)}
                    >
                      Copy
                    </button>
                  </details>
                )}
              </li>
            );
          })}
      </ul>
    </section>
  );
}
