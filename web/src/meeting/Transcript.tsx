import { useState, type Ref } from 'react';
import TimeLink from './TimeLink.tsx';
import WordEditor from './WordEditor.tsx';
import { lineKey } from './useFollowAlong.ts';
import type { Person, ShownLine, Word } from './words.ts';

// The meeting's transcript: every line with its time (a click plays from there), its words (a click on one, signed
// in, opens its editor), and who is speaking named wherever that changes. A find box narrows it to the lines holding
// some words; the line being played is followed along (see useFollowAlong).
export default function Transcript({
  kind,
  lines,
  status,
  editable,
  people,
  nameOf,
  speakersAt,
  correctedBy,
  canPlay,
  playAt,
  listRef,
  nowLine,
  following,
  onFollow,
  playing,
  picked,
  onPick,
  edits
}: {
  kind: 'quick' | 'final';
  lines: ShownLine[];
  status: string;
  editable: boolean;
  people: Person[];
  nameOf: (speaker: string) => string;
  speakersAt: (part: string, seconds: number) => string[];
  correctedBy: (word: Word) => string;
  canPlay: (part: string) => boolean;
  playAt: (part: string, seconds: number) => void;
  // From useFollowAlong: the transcript list, the line being played, whether it's followed, and following again.
  listRef: Ref<HTMLOListElement>;
  nowLine: string;
  following: boolean;
  onFollow: () => void;
  playing: boolean;
  picked: Word | null;
  onPick: (word: Word | null) => void;
  edits: {
    saveWord: (word: Word, text: string) => void;
    saveSpeakers: (word: Word, speakers: string[]) => void;
    addPerson: (word: Word, name: string, role: string) => void;
  };
}) {
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? lines.filter((line) =>
        line.words
          .map((word) => word.shown)
          .join(' ')
          .toLowerCase()
          .includes(needle)
      )
    : lines;
  const isPicked = (word: Word) =>
    picked !== null && picked.part === word.part && picked.line === word.line && picked.index === word.index;

  return (
    <section className="panel transcript">
      <div className="panel-head">
        <h2>Transcript{kind === 'quick' ? ' (quick, while recording)' : ''}</h2>
        <input
          type="search"
          placeholder="Find in this transcript"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Find in this transcript"
        />
        {playing && !following && nowLine && (
          <button type="button" className="button" onClick={onFollow}>
            ↓ Follow along
          </button>
        )}
      </div>
      {status && (
        <p className="note" aria-live="polite">
          {status}
        </p>
      )}
      {lines.length === 0 ? (
        <p className="muted">No transcript yet.</p>
      ) : (
        <ol className="lines" ref={listRef}>
          {shown.map((line, lineIndex) => {
            // A speaker is named where they start: at a line's first word only when they weren't speaking already.
            let last =
              lineIndex > 0 ? speakersAt(shown[lineIndex - 1].part, shown[lineIndex - 1].end - 0.01).join() : '';
            const key = lineKey(line);
            return (
              <li key={key} data-line={key} className={nowLine === key ? 'now' : undefined}>
                <TimeLink
                  seconds={line.start}
                  onPlay={canPlay(line.part) ? () => playAt(line.part, line.start) : null}
                />
                <span className="words">
                  {line.words.map((word) => {
                    const speakers = speakersAt(line.part, word.at);
                    const label = speakers.join() !== last ? speakers.map(nameOf).join(', ') : '';
                    last = speakers.join();
                    const by = word.edit ? correctedBy(word) : '';
                    return (
                      <span key={word.index}>
                        {label && <strong className="speaker-label">{label}: </strong>}
                        {word.edit && word.shown === '' ? (
                          editable && (
                            <button
                              type="button"
                              className="word deleted"
                              title={`Deleted “${word.text}”${by ? ` by ${by}` : ''}`}
                              aria-label={`Deleted word “${word.text}”`}
                              onClick={() => onPick(word)}
                            >
                              ×
                            </button>
                          )
                        ) : (
                          <button
                            type="button"
                            className={`word${word.edit ? ' edited' : ''}`}
                            disabled={!editable}
                            data-at={word.at}
                            title={word.edit ? `Was “${word.text}”${by ? ` · corrected by ${by}` : ''}` : undefined}
                            onClick={() => onPick(word)}
                          >
                            {word.shown}
                          </button>
                        )}{' '}
                        {isPicked(word) && (
                          <WordEditor
                            word={word}
                            people={people}
                            speakers={speakers}
                            onWord={edits.saveWord}
                            onSpeakers={edits.saveSpeakers}
                            onAdd={edits.addPerson}
                            onClose={() => onPick(null)}
                          />
                        )}
                      </span>
                    );
                  })}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
