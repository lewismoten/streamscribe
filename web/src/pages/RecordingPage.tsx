import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, type Choice, type Person, type RecordingDetail, type Vote, type Votes } from '../api.ts';
import { clock, date, duration, KIND_LABEL, pageAt, recordingTitle, time } from '../format.ts';
import RecordingCard from '../RecordingCard.tsx';

// One recording: what it is, its chapters and votes, the captures it was built from, and its transcript. Every time
// links to that moment on the review page.
export default function RecordingPage() {
  const { id } = useParams();
  const [recording, setRecording] = useState<RecordingDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setRecording(null);
    api.recording(Number(id)).then(setRecording).catch((reason: Error) => setError(reason.message));
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!recording) return <p className="empty">Loading…</p>;
  const people = new Map(recording.people.map((person) => [person.id, person]));
  const votes = recording.voteData?.votes || [];

  return (
    <article className="recording">
      <header className="recording-head">
        {recording.thumbnailUrl && <img src={recording.thumbnailUrl} alt="" className="recording-picture" />}
        <div>
          <div className="card-kind">{KIND_LABEL[recording.kind]} · {recording.sourceName}{recording.live ? ' · ' : ''}{recording.live && <span className="live-text">● Live</span>}</div>
          <h1>{recordingTitle(recording)}</h1>
          <p className="meta">
            {recording.startedAt && <>{date(recording.startedAt)}, {time(recording.startedAt)}{recording.endedAt ? `–${time(recording.endedAt)}` : ''} · </>}
            {duration(recording.durationSeconds)}
            {recording.transcriptLines > 0 && <> · {recording.transcriptLines.toLocaleString()} transcript lines</>}
          </p>
          <div className="card-actions">
            {recording.pageUrl ? <a href={recording.pageUrl} className="button primary">▶ Open the review page</a>
              : <span className="muted">No review page yet: run <code>npm run extract-thumbnails -- --session "{recording.dir}"</code></span>}
            {recording.videoUrl && <a href={recording.videoUrl} className="button" download>⬇ Video file</a>}
            <a href={recording.folderUrl} className="button" title="The recording's folder">📁 Files</a>
            {recording.partOf && <Link to={`/recordings/${recording.partOf}`} className="button">🧩 Full meeting</Link>}
          </div>
        </div>
      </header>

      <div className="recording-columns">
        <div className="side">
          {recording.agenda.length > 0 && (
            <section className="panel">
              <h2>Chapters</h2>
              <ol className="chapters">
                {recording.agenda.map((chapter, index) => {
                  const next = recording.agenda[index + 1];
                  return (
                    <li key={index}>
                      <a href={pageAt(recording, chapter.at)}><span className="time">{clock(chapter.at)}</span> {chapter.title}</a>
                      <span className="muted"> {duration((next ? next.at : recording.durationSeconds) - chapter.at)}</span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
          {votes.length > 0 && (
            <section className="panel">
              <h2>Votes</h2>
              <ul className="votes">
                {votes.map((vote) => <VoteRow key={vote.id} vote={vote} votes={recording.voteData!} people={people} href={pageAt(recording, vote.at)} />)}
              </ul>
            </section>
          )}
          {recording.parts.length > 0 && (
            <section className="panel">
              <h2>Built from</h2>
              <div className="grid compact">{recording.parts.map((part) => <RecordingCard key={part.id} recording={part} />)}</div>
            </section>
          )}
        </div>
        <Transcript recording={recording} />
      </div>
    </article>
  );
}

const nameOf = (people: Map<string, Person>, id: string) => people.get(id)?.name || id;

function outcomeOf(vote: Vote, votes: Votes): { label: string; passed: boolean | null } {
  const results = Object.values(vote.results || {}) as Choice[];
  const count = (choice: Choice) => results.filter((value) => value === choice).length;
  const seats = votes.seats || votes.members?.length || results.length;
  const needed = votes.needed || Math.floor(seats / 2) + 1;
  const tally = `${count('for')}–${count('against')}${count('abstain') ? `, ${count('abstain')} abstaining` : ''}${count('absent') ? `, ${count('absent')} absent` : ''}`;
  const passed = vote.outcome === 'passed' ? true : vote.outcome === 'failed' ? false
    : count('for') >= needed ? true
      : count('against') + count('absent') > seats - needed || (results.length >= seats && !results.includes('pending')) ? false : null;
  return { label: `${passed === null ? 'Undecided' : passed ? 'Passed' : 'Failed'} ${tally}`, passed };
}

function VoteRow({ vote, votes, people, href }: { vote: Vote; votes: Votes; people: Map<string, Person>; href?: string }) {
  const outcome = outcomeOf(vote, votes);
  return (
    <li className={outcome.passed === null ? '' : outcome.passed ? 'passed' : 'failed'}>
      <a href={href}><span className="time">{clock(vote.at)}</span> {vote.motion || 'Motion'}</a>
      <div className="muted">
        {outcome.label}
        {vote.movedBy && <> · moved by {nameOf(people, vote.movedBy.id)}</>}
        {vote.secondedBy && <> · seconded by {nameOf(people, vote.secondedBy.id)}</>}
      </div>
    </li>
  );
}

function Transcript({ recording }: { recording: RecordingDetail }) {
  const [filter, setFilter] = useState('');
  const lines = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? recording.transcript.filter((line) => line.text.toLowerCase().includes(needle)) : recording.transcript;
  }, [recording, filter]);
  if (recording.transcript.length === 0) {
    return <section className="panel transcript"><h2>Transcript</h2><p className="muted">No transcript yet. Run <code>npm run transcribe</code>.</p></section>;
  }
  return (
    <section className="panel transcript">
      <div className="panel-head">
        <h2>Transcript</h2>
        <input type="search" placeholder="Find in this transcript" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Find in this transcript" />
        {filter && <span className="muted">{lines.length} lines</span>}
      </div>
      <ol className="lines">
        {lines.map((line, index) => (
          <li key={index}>
            <a href={pageAt(recording, line.start)} className="time">{clock(line.start)}</a>
            <span>{line.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
