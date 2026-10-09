import { clock } from '../format.ts';
import type { reviewProgress } from './review.ts';

// How much of the transcript has been checked, a minute at a time: its speakers and its words, and the next minute
// still to check (a click goes there).
export default function ReviewProgress({
  progress,
  onNext
}: {
  progress: ReturnType<typeof reviewProgress>;
  onNext: (part: string, minute: number) => void;
}) {
  const { total, speakers, words, next } = progress;
  if (!total) return null;
  const percent = (count: number) => Math.round((count / total) * 100);
  return (
    <p className="review-progress small">
      <span>
        Checked: speakers {speakers} of {total} minutes ({percent(speakers)}%) · words {words} of {total} (
        {percent(words)}%)
      </span>
      <meter min={0} max={total * 2} value={speakers + words} aria-label="How much of the transcript is checked" />
      {next ? (
        <button type="button" className="link-button" onClick={() => onNext(next.part, next.minute)}>
          Next to check: {clock(next.minute * 60)}
        </button>
      ) : (
        <span>✓ Every minute is checked.</span>
      )}
    </p>
  );
}
