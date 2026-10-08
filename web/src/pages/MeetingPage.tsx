import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useRecords } from '../data/useRecords.ts';
import { clock, duration } from '../format.ts';
import { dateTime, mediaUrlOf, STATUS_LABEL, type RecordingData } from './MeetingsPage.tsx';

// One meeting from the hub: its stills, chapters, votes, and transcript (the final one when it's ready, the quick
// one while recording). The video stays on the recorder; its review page is where marks are edited.
interface Chunk { recordingId: string; kind: 'quick' | 'final'; part: string; partIndex: number; from: number; lines: { start: number; end: number; text: string; clockTime?: string }[] }
interface Still { recordingId: string; part: string; partIndex: number; position: number; clockTime: string; path: string }

export default function MeetingPage() {
  const { id = '' } = useParams();
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: chunks } = useRecords<Chunk>('transcript_chunks');
  const { records: stills } = useRecords<Still>('stills');
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const [filter, setFilter] = useState('');
  const recording = recordings?.find((record) => record.id === id);
  const mine = useMemo(() => (chunks || []).filter((chunk) => chunk.data.recordingId === id), [chunks, id]);
  // The final transcript replaces the quick one wherever it exists.
  const lines = useMemo(() => {
    const kind = mine.some((chunk) => chunk.data.kind === 'final') ? 'final' : 'quick';
    return mine.filter((chunk) => chunk.data.kind === kind)
      .sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.from - b.data.from)
      .flatMap((chunk) => chunk.data.lines.map((line) => ({ ...line, partIndex: chunk.data.partIndex, kind })));
  }, [mine]);
  const shown = filter.trim() ? lines.filter((line) => line.text.toLowerCase().includes(filter.trim().toLowerCase())) : lines;
  const pictures = (stills || []).filter((still) => still.data.recordingId === id).sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.position - b.data.position);
  const markOf = (kind: string) => (marks || []).filter((mark) => mark.id.startsWith(`${id}:`) && mark.id.endsWith(`:${kind}`));
  const chapters = markOf('agenda').flatMap((mark) => ((mark.data.items as { id: string; at: number; title: string }[]) || []));
  const votes = markOf('votes').flatMap((mark) => ((mark.data.votes as { id: string; at: number; motion?: string }[]) || []));

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
          <p className="muted">The video is on {data.recorderId}; open its review page there to edit speakers, chapters, and votes.</p>
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
            <h2>Transcript{lines[0]?.kind === 'quick' ? ' (quick, while recording)' : ''}</h2>
            <input type="search" placeholder="Find in this transcript" value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Find in this transcript" />
          </div>
          {lines.length === 0 ? <p className="muted">No transcript yet.</p> : (
            <ol className="lines">{shown.map((line, index) => <li key={index}><span className="time">{clock(line.start)}</span><span>{line.text}</span></li>)}</ol>
          )}
        </section>
      </div>
    </article>
  );
}
