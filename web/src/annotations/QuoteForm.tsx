import { useState, type FormEvent } from 'react';
import type { Quote } from './types.ts';

// Marking words as a quote: the actual words of the original (the speaker may say them loosely), who the speaker says
// said it, who really did (when that's known and different), where it's from, and a link for more.
export default function QuoteForm({
  value,
  words,
  onSave,
  onRemove
}: {
  value: Quote | null;
  // The words as said (the quote starts as them).
  words: string;
  onSave: (quote: Quote) => void;
  onRemove?: () => void;
}) {
  const [quote, setQuote] = useState<Quote>(value || { quote: words });
  const [problem, setProblem] = useState('');
  const set = (patch: Partial<Quote>) => setQuote({ ...quote, ...patch });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!quote.quote.trim()) return setProblem('The quote’s words');
    if (quote.url?.trim() && !/^https?:\/\/\S+$/.test(quote.url.trim()))
      return setProblem('A web address starts with https://');
    const clean = Object.fromEntries(
      Object.entries(quote)
        .map(([key, text]) => [key, String(text || '').trim()])
        .filter(([, text]) => text)
    ) as unknown as Quote;
    onSave(clean);
  };
  return (
    <form className="schedule-form" onSubmit={submit}>
      <label className="block">
        The quote (its actual words)
        <textarea rows={3} value={quote.quote} onChange={(event) => set({ quote: event.target.value })} />
      </label>
      <div className="form-grid">
        <label>
          Attributed to (by the speaker)
          <input
            value={quote.attributedTo || ''}
            onChange={(event) => set({ attributedTo: event.target.value })}
            placeholder="Thomas Jefferson"
          />
        </label>
        <label>
          Actually said by (if known)
          <input value={quote.saidBy || ''} onChange={(event) => set({ saidBy: event.target.value })} />
        </label>
        <label>
          From
          <input
            value={quote.source || ''}
            onChange={(event) => set({ source: event.target.value })}
            placeholder="A letter, 1816"
          />
        </label>
        <label>
          More about it
          <input
            type="url"
            value={quote.url || ''}
            onChange={(event) => set({ url: event.target.value })}
            placeholder="https://"
          />
        </label>
      </div>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save the quote
        </button>
        {onRemove && (
          <button type="button" className="link-button danger" onClick={onRemove}>
            Not a quote
          </button>
        )}
      </div>
    </form>
  );
}
