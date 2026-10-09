import { useState } from 'react';
import { SUGGESTED_PROMPTS } from '../../../src/sync/prompts.js';
import { can, useAccount } from '../data/account.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import Dialog from '../Dialog.tsx';
import TaskForm from './TaskForm.tsx';
import type { Prompt } from './types.ts';
import { useModels } from './useModels.ts';

// Tasks agents run on meetings with a language model (an Ollama server an agent is set up to use, on the Agents page):
// summaries, minutes, articles, YouTube descriptions, analysis… Each is a prompt with the meeting's placeholders; run
// one from a meeting's page, or have it run after each meeting.
export default function TasksPage() {
  const account = useAccount();
  const { records: prompts } = useRecords<Prompt>('prompts');
  const { models, ready } = useModels();
  const [editing, setEditing] = useState<{ id: string | null; value: Prompt } | null>(null);
  const editor = can('publish', account);
  if (!can('view.meetings', account)) return <p className="empty">Tasks run on meetings, which are private.</p>;
  if (!prompts) return <p className="empty">Loading…</p>;
  const missing = SUGGESTED_PROMPTS.filter((item) => !prompts.some((record) => record.id === item.id));
  const addSuggested = () =>
    Promise.all(
      missing.map((item) =>
        putRecord('prompts', item.id, { name: item.name, description: item.description, prompt: item.prompt })
      )
    );
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Tasks</h1>
        {editor && (
          <button
            type="button"
            className="button primary"
            onClick={() => setEditing({ id: null, value: { name: '', prompt: '' } })}
          >
            ＋ Task
          </button>
        )}
      </div>
      <p className="muted">
        Agents run these on a meeting&apos;s transcript with a language model on your network (set an agent&apos;s
        Ollama server on the Agents page). Run one from a meeting&apos;s Tasks panel, or have it run after each meeting.{' '}
        {ready ? `Models: ${models.join(', ')}.` : 'No agent has a working Ollama server yet.'}
      </p>
      {editor && missing.length > 0 && (
        <button type="button" className="button" onClick={addSuggested}>
          Add the {missing.length} suggested tasks
        </button>
      )}
      <ul className="task-list">
        {[...prompts]
          .sort((a, b) => a.data.name.localeCompare(b.data.name))
          .map((record) => (
            <li key={record.id} className="panel">
              <div className="toolbar">
                <strong className="grow">{record.data.name}</strong>
                {record.data.auto && <span className="tag">after each meeting</span>}
                {record.data.model && <span className="tag">{record.data.model}</span>}
                {editor && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setEditing({ id: record.id, value: record.data })}
                  >
                    Change
                  </button>
                )}
              </div>
              {record.data.description && <p className="muted small">{record.data.description}</p>}
            </li>
          ))}
      </ul>
      {editing && (
        <Dialog title={editing.id ? `Change “${editing.value.name}”` : 'New task'} onClose={() => setEditing(null)}>
          <TaskForm
            value={editing.value}
            models={models}
            onCancel={() => setEditing(null)}
            onSave={async (value) => {
              await putRecord('prompts', editing.id, value);
              setEditing(null);
            }}
            onRemove={
              editing.id
                ? async () => {
                    if (!confirm(`Delete the task “${editing.value.name}”?`)) return;
                    await removeRecord('prompts', editing.id!);
                    setEditing(null);
                  }
                : undefined
            }
          />
        </Dialog>
      )}
    </section>
  );
}
