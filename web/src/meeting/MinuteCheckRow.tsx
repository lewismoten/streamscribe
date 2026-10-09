import { clock } from '../format.ts';
import type { MinuteCheck, ReviewField } from './review.ts';

// The start of a minute in the transcript, with whether its speakers and its words have been checked (toggled by
// people who may correct the transcript).
export default function MinuteCheckRow({
  minute,
  check,
  editable,
  onToggle
}: {
  minute: number;
  check: MinuteCheck;
  editable: boolean;
  onToggle: (field: ReviewField) => void;
}) {
  const done = check.speakers && check.words;
  const toggle = (field: ReviewField, label: string) =>
    editable ? (
      <button
        type="button"
        className={`check-toggle${check[field] ? ' on' : ''}`}
        aria-pressed={Boolean(check[field])}
        onClick={() => onToggle(field)}
        title={
          check[field] ? `${label} checked (click to undo)` : `Mark this minute's ${label.toLowerCase()} as checked`
        }
      >
        {check[field] ? '✓' : '○'} {label}
      </button>
    ) : (
      <span className={`check-toggle${check[field] ? ' on' : ''}`}>
        {check[field] ? '✓' : '○'} {label}
      </span>
    );
  return (
    <li className={`minute-check${done ? ' done' : ''}`} data-minute={minute}>
      <span className="minute-time">{clock(minute * 60)}</span>
      {toggle('speakers', 'Speakers')}
      {toggle('words', 'Words')}
    </li>
  );
}
