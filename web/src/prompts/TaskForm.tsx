import { useState, type FormEvent } from 'react';
import { PLACEHOLDERS } from '../../../src/sync/prompts.js';
import type { Prompt } from './types.ts';

// A task's name, what it's for, its prompt (with the meeting's {{placeholders}}), the model (any the agents' Ollama
// servers have, else the first one), and whether it runs after each meeting.
export default function TaskForm({
  value,
  models,
  onSave,
  onCancel,
  onRemove
}: {
  value: Prompt;
  models: string[];
  onSave: (prompt: Prompt) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const [prompt, setPrompt] = useState<Prompt>(value);
  const [problem, setProblem] = useState('');
  const set = (patch: Partial<Prompt>) => setPrompt({ ...prompt, ...patch });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.name.trim() || !prompt.prompt.trim()) return setProblem('A task needs a name and a prompt');
    onSave({
      ...prompt,
      name: prompt.name.trim(),
      // Automatic from now on (not for every meeting already done).
      autoSince: prompt.auto ? prompt.autoSince || new Date().toISOString() : undefined
    });
  };
  return (
    <form className="schedule-form" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Name
          <input value={prompt.name} onChange={(event) => set({ name: event.target.value })} />
        </label>
        <label>
          Model
          <input
            value={prompt.model || ''}
            onChange={(event) => set({ model: event.target.value })}
            list="task-models"
            placeholder="the agent's first model"
          />
        </label>
      </div>
      <datalist id="task-models">
        {models.map((model) => (
          <option key={model} value={model} aria-label={model} />
        ))}
      </datalist>
      <label className="block">
        What it&apos;s for
        <input value={prompt.description || ''} onChange={(event) => set({ description: event.target.value })} />
      </label>
      <label className="block">
        Prompt
        <textarea rows={10} value={prompt.prompt} onChange={(event) => set({ prompt: event.target.value })} />
      </label>
      <p className="muted small">
        The meeting goes in its placeholders: {PLACEHOLDERS.map((name) => `{{${name}}}`).join(' ')}
      </p>
      <label className="inline">
        <input
          type="checkbox"
          checked={Boolean(prompt.auto)}
          onChange={(event) => set({ auto: event.target.checked })}
        />{' '}
        Run after each meeting (from now on)
      </label>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save the task
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
        {onRemove && (
          <button type="button" className="link-button danger" onClick={onRemove}>
            Delete the task
          </button>
        )}
      </div>
    </form>
  );
}
