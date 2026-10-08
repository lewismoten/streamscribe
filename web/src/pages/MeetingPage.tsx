import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { layerData, layerId, stackMarks } from '../../../src/sync/layers.js';
import { MARK_PERMISSIONS } from '../../../src/sync/permissions.js';
import { can, useAccount } from '../data/account.ts';
import { putRecord, useRecords, type HubRecord } from '../data/useRecords.ts';
import { syncNow } from '../data/sync.ts';
import { clock, duration } from '../format.ts';
import { dateTime, mediaUrlOf, STATUS_LABEL, type RecordingData } from './MeetingsPage.tsx';

// One meeting from the hub: its stills, chapters, votes, and transcript (the final one when it's ready, the quick
// one while recording), with the word corrections and speakers everyone may see. Signed in, a click on a word of the
// final transcript corrects it or says who is speaking from there; each person's changes are their own layer (see
// src/sync/layers.js), public if their group allows that kind of change and they're trusted, else theirs alone.
interface Line { start: number; end: number; text: string; clockTime?: string; words?: [number, number, string][] }
interface Chunk { recordingId: string; kind: 'quick' | 'final'; part: string; partIndex: number; from: number; lines: Line[] }
interface Still { recordingId: string; part: string; partIndex: number; position: number; clockTime: string; path: string }
interface WordEdit { transcript: string; line: number; index: number; at: number; original: string; text: string; updatedAt?: string }
interface Turn { at: number; speakers: string[] }
interface Person { id: string; name: string; role?: string; nameUnknown?: boolean }
interface Word { text: string; shown: string; at: number; line: number; index: number; edit: WordEdit | null; part: string }
type Stack = { data: Record<string, unknown> | null; layers: (HubRecord & { owner: number; owner_name?: string })[]; mine: (HubRecord & { layer?: string }) | null; withoutMine: unknown };

const round = (seconds: number, places = 100) => Math.round(seconds * places) / places;

// A line's words: from the transcript's word times where it has them, else spread over the line by length (as the
// review page does, so corrections made in either place match the same words).
function wordsOf(line: Line) {
  if (line.words?.length) return line.words.map(([at, , text]) => ({ text, at: round(at) }));
  const parts = String(line.text).split(' ').filter(Boolean);
  const total = parts.reduce((sum, word) => sum + word.length + 1, 0) || 1;
  const span = Math.max(0.01, line.end - line.start);
  let used = 0;
  return parts.map((text) => {
    const at = round(line.start + (span * used) / total);
    used += text.length + 1;
    return { text, at };
  });
}

const personName = (person: Person | undefined, id: string) => (!person ? id : person.nameUnknown || !person.name?.trim() ? person.role || 'Unknown' : person.name);

export default function MeetingPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const viewerId = account.user?.id || 0;
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: chunks } = useRecords<Chunk>('transcript_chunks');
  const { records: stills } = useRecords<Still>('stills');
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<Word | null>(null);
  const [status, setStatus] = useState('');
  const recording = recordings?.find((record) => record.id === id);
  const stacks = useMemo(() => stackMarks((marks || []).filter((mark) => mark.id.startsWith(`${id}:`) || (recording && mark.id.startsWith(`${recording.data.sourceKey}:people`))), viewerId) as Map<string, Stack>, [marks, id, recording, viewerId]);
  const markData = <T,>(markId: string) => (stacks.get(markId)?.data || null) as T | null;
  const mine = useMemo(() => (chunks || []).filter((chunk) => chunk.data.recordingId === id), [chunks, id]);
  const kind = mine.some((chunk) => chunk.data.kind === 'final') ? 'final' : 'quick';
  const editable = Boolean(account.user) && kind === 'final';

  const peopleId = recording ? `${recording.data.sourceKey}:people` : '';
  const people = markData<{ people?: Person[] }>(peopleId)?.people || [];
  const peopleMap = new Map(people.map((person) => [person.id, person]));

  // Lines with their words (corrections applied) and who is speaking at each word.
  const lines = useMemo(() => mine.filter((chunk) => chunk.data.kind === kind)
    .sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.from - b.data.from)
    .flatMap((chunk) => {
      const part = chunk.data.part;
      const edits = (markData<{ edits?: WordEdit[] }>(`${id}:${part}:word-edits`)?.edits || []).filter((edit) => edit.transcript === 'latest');
      return chunk.data.lines.map((line) => {
        const lineKey = round(line.start);
        const words: Word[] = wordsOf(line).map((word, index) => {
          const edit = kind === 'final' ? edits.find((item) => item.line === lineKey && item.index === index && item.original === word.text) || null : null;
          return { text: word.text, shown: edit ? edit.text : word.text, at: word.at, line: lineKey, index, edit, part };
        });
        return { ...line, part, partIndex: chunk.data.partIndex, words };
      });
    }), [mine, kind, stacks, id]);
  const turnsOf = (part: string) => (markData<{ turns?: Turn[] }>(`${id}:${part}:speakers`)?.turns || []).slice().sort((a, b) => a.at - b.at);
  const speakersAt = (part: string, seconds: number) => {
    let found: string[] = [];
    for (const turn of turnsOf(part)) if (turn.at <= seconds + 0.15) found = turn.speakers;
    return found;
  };

  const needle = filter.trim().toLowerCase();
  const shown = needle ? lines.filter((line) => line.words.map((word) => word.shown).join(' ').toLowerCase().includes(needle)) : lines;
  const pictures = (stills || []).filter((still) => still.data.recordingId === id).sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.position - b.data.position);
  const markList = <T,>(kindName: string, field: string) => [...stacks.entries()]
    .filter(([markId]) => markId.startsWith(`${id}:`) && markId.endsWith(`:${kindName}`))
    .flatMap(([, stack]) => ((stack.data?.[field] as T[]) || []));
  const chapters = markList<{ id: string; at: number; title: string }>('agenda', 'items');
  const votes = markList<{ id: string; at: number; motion?: string }>('votes', 'votes');

  // Saving: this person's layer of the mark, measured against what they see without it.
  const save = async (markId: string, value: Record<string, unknown>, done: string) => {
    const stack = stacks.get(markId);
    await putRecord('marks', layerId(markId, viewerId), layerData(stack, { ...value, updatedAt: new Date().toISOString() }));
    const permission = MARK_PERMISSIONS[markId.split(':').at(-1) as keyof typeof MARK_PERMISSIONS];
    const publicChange = can(permission, account) && account.user?.trusted;
    setStatus(`${done}${publicChange ? '' : ' (only you see this)'}`);
    syncNow();
  };
  const saveWord = (word: Word, text: string) => {
    const markId = `${id}:${word.part}:word-edits`;
    const current = markData<{ edits?: WordEdit[] }>(markId) || {};
    const original = word.text;
    const edits = (current.edits || []).filter((edit) => !(edit.transcript === 'latest' && edit.line === word.line && edit.index === word.index));
    if (text !== original) edits.push({ transcript: 'latest', line: word.line, index: word.index, at: word.at, original, text, updatedAt: new Date().toISOString() });
    setPicked(null);
    return save(markId, { ...current, edits }, text === original ? `Restored “${original}”` : text ? `Corrected “${original}” to “${text}”` : `Deleted “${original}”`);
  };
  // Who is speaking from a word on: a change within a second of another edits it; one repeating the turn before goes.
  const saveSpeakers = (word: Word, speakers: string[], names: Record<string, string> = {}) => {
    const markId = `${id}:${word.part}:speakers`;
    const current = markData<{ turns?: Turn[] }>(markId) || {};
    const at = round(word.at, 10);
    let turns = (current.turns || []).filter((turn) => Math.abs(turn.at - at) >= 1);
    turns.push({ at, speakers });
    turns.sort((a, b) => a.at - b.at);
    turns = turns.filter((turn, index) => index === 0 || JSON.stringify(turn.speakers) !== JSON.stringify(turns[index - 1].speakers));
    setPicked(null);
    return save(markId, { ...current, turns }, `${speakers.map((speaker) => names[speaker] || personName(peopleMap.get(speaker), speaker)).join(' and ') || 'Nobody'} speaking from ${clock(at)}`);
  };
  const addPerson = async (word: Word, name: string, role: string) => {
    const current = markData<{ people?: Person[]; groups?: unknown[] }>(peopleId) || {};
    const person = { id: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person'}-${Math.random().toString(36).slice(2, 6)}`, name, role };
    await save(peopleId, { ...current, people: [...(current.people || []), person] }, `Added ${name}`);
    await saveSpeakers(word, [person.id], { [person.id]: name });
  };
  // Who made a word's correction (when it wasn't the recorder's own).
  const correctedBy = (word: Word) => {
    const stack = stacks.get(`${id}:${word.part}:word-edits`);
    if (!stack || !word.edit) return '';
    const key = (edit: WordEdit) => edit.line === word.line && edit.index === word.index;
    const changed = (layer: { data: unknown }) => {
      const { base, value } = (layer.data || {}) as { base?: { edits?: WordEdit[] }; value?: { edits?: WordEdit[] } };
      return JSON.stringify(value?.edits?.find(key)) !== JSON.stringify(base?.edits?.find(key));
    };
    if (stack.mine && changed(stack.mine)) return 'you';
    const layer = [...stack.layers].reverse().find((item) => (item as { trusted?: boolean }).trusted !== false && changed(item));
    return layer ? layer.owner_name || 'someone' : '';
  };

  if (!recordings) return <p className="empty">Loading…</p>;
  if (!recording) return <p>No such meeting on the hub. <Link to="/meetings">All meetings</Link></p>;
  const data = recording.data;
  return (
    <article className="recording">
      <header className="recording-head">
        {pictures[0] && <img src={mediaUrlOf(pictures[0].data.path)} alt="" className="recording-picture" />}
        <div>
          <div className="card-kind">{STATUS_LABEL[data.status] || data.status} · {data.sourceKey} · recorded by {data.recorderId}</div>
          <h1>{data.title}</h1>
          <p className="meta">
            {dateTime(data.startedAt)}{data.stoppedAt ? ` – ${new Date(data.stoppedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : ''}
            {data.durationSeconds > 0 && <> · {duration(data.durationSeconds)}</>}
            {data.stopReason && <> · stopped after {data.stopReason === 'standby' ? 'the standby slide' : data.stopReason === 'idle' ? 'no new video' : data.stopReason === 'cap' ? 'the time limit' : data.stopReason}</>}
          </p>
          {data.error && <p className="error">{data.error}</p>}
          <p className="muted">
            {account.user
              ? <>Click a word to correct it or to say who is speaking from there.{account.user.trusted ? '' : ' Your changes are visible only to you.'}</>
              : <><Link to="/account">Sign in</Link> to correct the transcript or say who is speaking.</>}
            {' '}The video is on {data.recorderId}.
          </p>
        </div>
      </header>
      {pictures.length > 0 && (
        <div className="stills">{pictures.map((still) => <img key={still.id} src={mediaUrlOf(still.data.path)} alt="" loading="lazy" title={clock(still.data.position)} />)}</div>
      )}
      <div className="recording-columns">
        <div className="side">
          {chapters.length > 0 && (
            <section className="panel"><h2>Chapters</h2>
              <ol className="chapters">{chapters.sort((a, b) => a.at - b.at).map((chapter) => <li key={chapter.id}><span className="time">{clock(chapter.at)}</span> {chapter.title}</li>)}</ol>
            </section>
          )}
          {votes.length > 0 && (
            <section className="panel"><h2>Votes</h2>
              <ul className="votes">{votes.sort((a, b) => a.at - b.at).map((vote) => <li key={vote.id}><span className="time">{clock(vote.at)}</span> {vote.motion || 'Motion'}</li>)}</ul>
            </section>
          )}
        </div>
        <section className="panel transcript">
          <div className="panel-head">
            <h2>Transcript{kind === 'quick' ? ' (quick, while recording)' : ''}</h2>
            <input type="search" placeholder="Find in this transcript" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Find in this transcript" />
          </div>
          {status && <p className="note" role="status">{status}</p>}
          {lines.length === 0 ? <p className="muted">No transcript yet.</p> : (
            <ol className="lines">{shown.map((line, lineIndex) => {
              let last = lineIndex > 0 ? speakersAt(shown[lineIndex - 1].part, shown[lineIndex - 1].end - 0.01).join() : '';
              return (
                <li key={`${line.part}-${line.start}`}>
                  <span className="time">{clock(line.start)}</span>
                  <span className="words">{line.words.map((word) => {
                    const speakers = speakersAt(line.part, word.at);
                    const label = speakers.join() !== last ? speakers.map((speaker) => personName(peopleMap.get(speaker), speaker)).join(', ') : '';
                    last = speakers.join();
                    const by = word.edit ? correctedBy(word) : '';
                    return (
                      <span key={word.index}>
                        {label && <strong className="speaker-label">{label}: </strong>}
                        {word.edit && word.shown === '' ? (editable && <button type="button" className="word deleted" title={`Deleted “${word.text}”${by ? ` by ${by}` : ''}`} onClick={() => setPicked(word)}>×</button>) : (
                          <button type="button" className={`word${word.edit ? ' edited' : ''}`} disabled={!editable}
                            title={word.edit ? `Was “${word.text}”${by ? ` · corrected by ${by}` : ''}` : undefined} onClick={() => setPicked(word)}>{word.shown}</button>
                        )}{' '}
                        {picked && picked.part === word.part && picked.line === word.line && picked.index === word.index && (
                          <WordEditor word={word} people={people} speakers={speakers} onWord={saveWord} onSpeakers={saveSpeakers} onAdd={addPerson} onClose={() => setPicked(null)} />
                        )}
                      </span>
                    );
                  })}</span>
                </li>
              );
            })}</ol>
          )}
        </section>
      </div>
    </article>
  );
}

function WordEditor({ word, people, speakers, onWord, onSpeakers, onAdd, onClose }: {
  word: Word; people: Person[]; speakers: string[];
  onWord: (word: Word, text: string) => void; onSpeakers: (word: Word, speakers: string[]) => void;
  onAdd: (word: Word, name: string, role: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState(word.shown);
  const [newPerson, setNewPerson] = useState({ name: '', role: '' });
  const submit = (event: FormEvent) => { event.preventDefault(); onWord(word, text.trim()); };
  return (
    <span className="word-editor panel" role="dialog" aria-label={`Change “${word.shown}”`} onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}>
      <form onSubmit={submit}>
        <label>Word at {clock(word.at)} <input autoFocus value={text} onChange={(event) => setText(event.target.value)} /></label>
        <span className="toolbar">
          <button type="submit" className="button primary">Correct</button>
          <button type="button" className="button" onClick={() => onWord(word, '')}>Delete word</button>
          {word.edit && <button type="button" className="button" onClick={() => onWord(word, word.text)}>Restore “{word.text}”</button>}
        </span>
      </form>
      <label>Speaking from here <select value={speakers.join()} onChange={(event) => onSpeakers(word, event.target.value ? event.target.value.split(',') : [])}>
        <option value="">Nobody / unknown</option>
        {!people.some((person) => person.id === speakers.join()) && speakers.length > 0 && <option value={speakers.join()}>{speakers.join(', ')}</option>}
        {people.map((person) => <option key={person.id} value={person.id}>{personName(person, person.id)}{person.role && !person.nameUnknown ? `, ${person.role}` : ''}</option>)}
      </select></label>
      <form className="toolbar" onSubmit={(event) => { event.preventDefault(); if (newPerson.name.trim()) onAdd(word, newPerson.name.trim(), newPerson.role.trim()); }}>
        <input placeholder="Someone new: name" value={newPerson.name} onChange={(event) => setNewPerson({ ...newPerson, name: event.target.value })} aria-label="New person's name" />
        <input placeholder="role" value={newPerson.role} onChange={(event) => setNewPerson({ ...newPerson, role: event.target.value })} aria-label="New person's role" />
        <button type="submit" className="button">Add, speaking from here</button>
      </form>
      <button type="button" className="link-button" onClick={onClose}>Close</button>
    </span>
  );
}
