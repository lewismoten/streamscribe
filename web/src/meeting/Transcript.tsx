import { Link } from 'react-router';
import { Fragment, useEffect, useRef, useState, type Ref } from 'react';
import { clock } from '../format.ts';
import Avatar, { type AvatarPerson } from '../people/Avatar.tsx';
import Dialog from '../Dialog.tsx';
import LinkForm from './LinkForm.tsx';
import TimeLink from './TimeLink.tsx';
import WordEditor from './WordEditor.tsx';
import { covers, endsAt, linkHref, linkLabel, type TranscriptLink } from './links.ts';
import { lineKey } from './useFollowAlong.ts';
import type { Person, ShownLine, Word } from './words.ts';

// The meeting's transcript: every line with its time (a click plays from there), its words (a click on one, signed
// in, opens its editor), and who is speaking named wherever that changes. Signed in, selecting words (with the mouse,
// or Shift and the arrow keys) opens a menu under them: mark them as a Bible passage, or link them to a web page. A find box narrows it to the lines holding
// some words; the line being played is followed along (see useFollowAlong).
export default function Transcript({
  kind,
  lines,
  status,
  editable,
  people,
  nameOf,
  personHref,
  avatarOf,
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
  edits,
  linksFor,
  scriptureSite,
  onLink,
  onUnlink
}: {
  kind: 'quick' | 'final';
  lines: ShownLine[];
  status: string;
  editable: boolean;
  people: Person[];
  nameOf: (speaker: string) => string;
  // Where a speaker's own page is (the People directory), when there's one.
  personHref?: (speaker: string) => string | null;
  // A speaker as their picture shows them (their photo, private ones included: this page is private too).
  avatarOf: (speaker: string) => AvatarPerson;
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
  // Links on phrases (web pages, Bible passages), per part, and saving or removing one.
  linksFor: (part: string) => TranscriptLink[];
  scriptureSite: string;
  onLink: (part: string, link: Omit<TranscriptLink, 'id'> & { id?: string }) => void;
  onUnlink: (part: string, link: TranscriptLink) => void;
}) {
  const [filter, setFilter] = useState('');
  // Words selected in the transcript: the menu under them, and the dialog one of its choices opens.
  const area = useRef<HTMLElement>(null);
  const [menu, setMenu] = useState<{ part: string; words: Word[]; top: number; left: number } | null>(null);
  // Marking words (or changing a link already on them): the part, the words, and what they link to.
  const [marking, setMarking] = useState<{
    part: string;
    words: Word[];
    kind: 'passage' | 'web';
    link: TranscriptLink | null;
  } | null>(null);
  // The links on some words (any of them), and a link's own words.
  const linksOn = (part: string, words: Word[]) =>
    linksFor(part).filter((link) => words.some((word) => covers(link, { line: word.line, index: word.index })));
  const wordsOf = (part: string, link: TranscriptLink) =>
    lines
      .filter((line) => line.part === part)
      .flatMap((line) => line.words)
      .filter((word) => covers(link, { line: word.line, index: word.index }));
  const change = (part: string, link: TranscriptLink, words = wordsOf(part, link)) => {
    setMarking({ part, words, kind: link.passage ? 'passage' : 'web', link });
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  };
  const unlink = (part: string, link: TranscriptLink) => {
    onUnlink(part, link);
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  };
  const wordKey = (word: Word) => `${word.part}|${word.line}|${word.index}`;
  const readSelection = () => {
    const selection = window.getSelection();
    if (!editable || !selection || selection.isCollapsed || !selection.rangeCount || !area.current)
      return setMenu(null);
    const range = selection.getRangeAt(0);
    const keys = [...area.current.querySelectorAll<HTMLElement>('[data-word]')]
      .filter((element) => range.intersectsNode(element))
      .map((element) => element.dataset.word);
    const byKey = new Map(lines.flatMap((line) => line.words).map((word) => [wordKey(word), word]));
    const words = keys.map((key) => byKey.get(key || '')).filter((word) => word !== undefined);
    // One part at a time (a link belongs to a part's transcript).
    const chosen = words.filter((word) => word.part === words[0]?.part);
    if (!chosen.length) return setMenu(null);
    const box = range.getBoundingClientRect();
    setMenu({ part: chosen[0].part, words: chosen, top: box.bottom + 6, left: Math.max(8, box.left) });
  };
  // A selection is read when it's made: the mouse let go, or a key (Shift and an arrow) let up.
  const reading = useRef(readSelection);
  useEffect(() => {
    reading.current = readSelection;
  });
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const read = () => reading.current();
    element.addEventListener('mouseup', read);
    element.addEventListener('keyup', read);
    return () => {
      element.removeEventListener('mouseup', read);
      element.removeEventListener('keyup', read);
    };
  }, []);
  // The menu goes when the selection does, on Escape, or when the page scrolls away from it.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const changed = () => {
      if (window.getSelection()?.isCollapsed) close();
    };
    const key = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('selectionchange', changed);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('selectionchange', changed);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);
  const mark = (choice: 'passage' | 'web') => {
    if (!menu) return;
    setMarking({ part: menu.part, words: menu.words, kind: choice, link: null });
    setMenu(null);
    window.getSelection()?.removeAllRanges();
  };
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
  // Whoever is speaking when a line starts heads a block of lines, with their picture and name (it stays at the top
  // while their lines scroll by), unless the block above is theirs; someone starting during a line is named there, and
  // heads a block of their own from the next line.
  const openings = shown.map((line) => speakersAt(line.part, line.words[0]?.at ?? line.start));
  const headings = new Set<number>();
  let block = '';
  shown.forEach((line, index) => {
    if (index === 0 || shown[index - 1].part !== line.part) block = '';
    if (openings[index].length && openings[index].join() !== block) {
      headings.add(index);
      block = openings[index].join();
    }
  });
  // Speakers' pictures and names (each linking to their page when they have one).
  const speakerNames = (speakers: string[], size: number) =>
    speakers.map((speaker, index) => {
      const href = personHref?.(speaker);
      const face = <Avatar person={avatarOf(speaker)} size={size} />;
      return (
        <span key={speaker} className="speaker-name">
          {index > 0 && ', '}
          {href ? (
            <Link to={href}>
              {face}
              {nameOf(speaker)}
            </Link>
          ) : (
            <>
              {face}
              {nameOf(speaker)}
            </>
          )}
        </span>
      );
    });
  // The words a phrase from the picked one can run through: the rest of its line and the next two.
  const followingOf = (word: Word) => {
    const at = lines.findIndex((line) => line.part === word.part && line.words.some((item) => item === word));
    return lines
      .slice(at, at + 3)
      .filter((line) => line.part === word.part)
      .flatMap((line) => line.words)
      .filter((item) => item.line > word.line || (item.line === word.line && item.index >= word.index))
      .slice(0, 40);
  };

  return (
    <section className="panel transcript" ref={area}>
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
            const opening = openings[lineIndex];
            const heads = headings.has(lineIndex);
            let last = opening.join();
            const key = lineKey(line);
            return (
              <Fragment key={key}>
                {heads && <li className="speaker-block">{speakerNames(opening, 32)}</li>}
                <li data-line={key} className={nowLine === key ? 'now' : undefined}>
                  <TimeLink
                    seconds={line.start}
                    onPlay={canPlay(line.part) ? () => playAt(line.part, line.start) : null}
                  />
                  <span className="words">
                    {line.words.map((word) => {
                      const speakers = speakersAt(line.part, word.at);
                      const changed = speakers.join() !== last;
                      last = speakers.join();
                      const by = word.edit ? correctedBy(word) : '';
                      const partLinks = linksFor(line.part);
                      const place = { line: word.line, index: word.index };
                      const linked = partLinks.find((link) => covers(link, place)) || null;
                      const ending = partLinks.filter((link) => endsAt(link, place));
                      return (
                        <span key={word.index}>
                          {changed && speakers.length > 0 && (
                            <strong className="speaker-label inline">{speakerNames(speakers, 18)}: </strong>
                          )}
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
                            // Selectable text (a button's isn't), acting as a button: a click (not ending a selection),
                            // Enter, or Space opens the word's editor.
                            // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
                            <span
                              className={`word${word.edit ? ' edited' : ''}${linked ? ' linked' : ''}${editable ? '' : ' readonly'}`}
                              data-at={word.at}
                              data-word={wordKey(word)}
                              title={word.edit ? `Was “${word.text}”${by ? ` · corrected by ${by}` : ''}` : undefined}
                              {...(editable
                                ? {
                                    role: 'button',
                                    tabIndex: 0,
                                    onClick: () => {
                                      if (window.getSelection()?.isCollapsed !== false) onPick(word);
                                    },
                                    onKeyDown: (event: React.KeyboardEvent) => {
                                      if (event.key === 'Enter' || event.key === ' ') {
                                        event.preventDefault();
                                        onPick(word);
                                      }
                                    }
                                  }
                                : {})}
                            >
                              {word.shown}
                            </span>
                          )}
                          {ending.map((link) => (
                            <a
                              key={link.id}
                              className="transcript-link"
                              href={linkHref(link, scriptureSite)}
                              target="_blank"
                              rel="noreferrer"
                            >
                              ↗ {linkLabel(link)}
                            </a>
                          ))}
                          {editable &&
                            ending.map((link) => (
                              <button
                                key={`change-${link.id}`}
                                type="button"
                                className="link-button link-change"
                                onClick={() => change(line.part, link)}
                                aria-label={`Change or remove the link to ${linkLabel(link)}`}
                                title="Change or remove"
                              >
                                ✎
                              </button>
                            ))}{' '}
                        </span>
                      );
                    })}
                  </span>
                </li>
              </Fragment>
            );
          })}
        </ol>
      )}
      {picked && (
        <Dialog title={`“${picked.shown || picked.text}” at ${clock(picked.at)}`} onClose={() => onPick(null)}>
          <WordEditor
            word={picked}
            people={people}
            speakers={speakersAt(picked.part, picked.at)}
            onWord={edits.saveWord}
            onSpeakers={edits.saveSpeakers}
            onAdd={edits.addPerson}
            following={followingOf(picked)}
            link={
              linksFor(picked.part).find((link) => covers(link, { line: picked.line, index: picked.index })) || null
            }
            onLink={(link) => {
              onLink(picked.part, link);
              onPick(null);
            }}
            onUnlink={(link) => {
              onUnlink(picked.part, link);
              onPick(null);
            }}
            onClose={() => onPick(null)}
          />
        </Dialog>
      )}
      {menu && (
        // Pressing a choice keeps the selection (it's what the choice is for).
        <div
          className="selection-menu"
          role="menu"
          tabIndex={-1}
          aria-label="The selected words"
          style={{ top: menu.top, left: menu.left }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {linksOn(menu.part, menu.words).map((link) => (
            <Fragment key={link.id}>
              <button type="button" role="menuitem" onClick={() => change(menu.part, link, menu.words)}>
                Change {linkLabel(link)}…
              </button>
              <button type="button" role="menuitem" onClick={() => unlink(menu.part, link)}>
                Remove {linkLabel(link)}
              </button>
            </Fragment>
          ))}
          {/* Words already linked are changed or unlinked, not linked twice. */}
          {linksOn(menu.part, menu.words).length === 0 && (
            <>
              <button type="button" role="menuitem" onClick={() => mark('passage')}>
                Mark Bible passage…
              </button>
              <button type="button" role="menuitem" onClick={() => mark('web')}>
                Link to a web page…
              </button>
            </>
          )}
        </div>
      )}
      {marking && (
        <Dialog
          title={
            marking.link
              ? `Change ${linkLabel(marking.link)}`
              : marking.kind === 'passage'
                ? 'Mark a Bible passage'
                : 'Link to a web page'
          }
          onClose={() => setMarking(null)}
        >
          <LinkForm
            word={marking.words[0]}
            following={marking.words}
            link={marking.link}
            fixed
            startWith={marking.kind}
            onSave={(link) => {
              onLink(marking.part, link);
              setMarking(null);
            }}
            onRemove={(link) => {
              onUnlink(marking.part, link);
              setMarking(null);
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
