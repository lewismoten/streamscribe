import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { hubCall, hubSettings, mediaUrl } from '../data/hub.ts';
import { useRecords } from '../data/useRecords.ts';
import { syncNow } from '../data/sync.ts';
import { clock, duration } from '../format.ts';

// What's published from the archive, for everyone (the meetings themselves are private): notes and summaries,
// transcript excerpts, and clips, each with a link to the official recording when known.
export interface Publication {
  kind: 'note' | 'transcript' | 'clip';
  title: string;
  body: string;
  recordingId: string;
  part: string;
  meeting: string;
  sourceKey: string;
  sourceName: string;
  recordedAt: string | null;
  from: number;
  to: number;
  seconds: number;
  officialUrl: string | null;
  transcript: { path: string; text: string; captions: string; lines: number } | null;
  chapters: { at: number; title: string }[];
  poster: string | null;
  clip: { status: 'queued' | 'ready' | 'failed'; error?: string; hasVideo?: boolean; video?: { path: string; bytes: number }; audio?: { path: string; bytes: number } } | null;
  publishedAt: string;
  publishedBy: string;
}

const KIND_LABEL = { note: 'Notes', transcript: 'Transcript', clip: 'Clip' };
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '');
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

// Text with its paragraphs and web addresses as links.
function Body({ text }: { text: string }) {
  return <>{text.split(/\n{2,}/).map((paragraph, index) => (
    <p key={index}>{paragraph.split(/(https?:\/\/[^\s)]+)/g).map((piece, at) => (/^https?:\/\//.test(piece)
      ? <a key={at} href={piece} rel="noopener noreferrer">{piece}</a>
      : piece.split('\n').map((line, row) => <span key={row}>{row > 0 && <br />}{line}</span>)))}</p>
  ))}</>;
}

export function PublishedList() {
  const { records } = useRecords<Publication>('publications');
  if (!records) return <p className="empty">Loading…</p>;
  const sorted = [...records].sort((a, b) => String(b.data.publishedAt).localeCompare(String(a.data.publishedAt)));
  const feeds = [...new Map(sorted.filter((record) => record.data.clip?.status === 'ready').map((record) => [record.data.sourceKey, record.data.sourceName])).entries()];
  return (
    <section>
      <div className="toolbar"><h1 className="grow">Published</h1>
        {feeds.map(([key, name]) => <a key={key} className="button" href={`${hubSettings().url}/podcast/${encodeURIComponent(key)}.xml`} title={`Podcast of ${name} clips: add this address to a podcast app`}>🎧 {feeds.length > 1 ? name : 'Podcast'}</a>)}
      </div>
      <p className="muted">Notes, transcripts, and clips from an independent archive of public meetings. Each links to the official recording where there is one.</p>
      {sorted.length === 0 ? <p className="empty">Nothing published yet.</p> : (
        <div className="grid">{sorted.map((record) => {
          const item = record.data;
          return (
            <article key={record.id} className="card">
              <Link to={`/published/${record.id}`} className="card-picture" aria-label={item.title}>
                {item.poster ? <img src={mediaUrl(item.poster)} alt="" loading="lazy" /> : <div className="no-picture">{item.kind === 'clip' ? '🎬' : item.kind === 'transcript' ? '📝' : '🗒'}</div>}
                {item.kind !== 'note' && item.seconds > 0 && <span className="badge duration">{duration(item.seconds)}</span>}
              </Link>
              <div className="card-body">
                <div className="card-kind">{KIND_LABEL[item.kind]}{item.clip && item.clip.status !== 'ready' ? ' · being prepared' : ''}</div>
                <h3><Link to={`/published/${record.id}`}>{item.title}</Link></h3>
                <p className="meta">{item.meeting || item.sourceName}{item.recordedAt ? ` · ${day(item.recordedAt)}` : ''}</p>
              </div>
            </article>
          );
        })}</div>
      )}
    </section>
  );
}

interface Line { start: number; end: number; speaker: string; text: string }

export function PublicationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const account = useAccount();
  const { records } = useRecords<Publication>('publications');
  const record = records?.find((item) => item.id === id);
  const item = record?.data;
  const [lines, setLines] = useState<Line[] | null>(null);
  const [time, setTime] = useState(-1);
  const [message, setMessage] = useState('');
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const transcriptPath = item?.transcript?.path;
  useEffect(() => {
    if (!transcriptPath) { setLines(null); return; }
    fetch(mediaUrl(transcriptPath)).then((response) => response.json()).then((value) => setLines(value.lines || [])).catch(() => setLines([]));
  }, [transcriptPath]);
  const nowIndex = lines ? lines.findLastIndex((line) => line.start <= time + 0.2) : -1;
  useEffect(() => {
    const line = list.current?.querySelector('li.now') as HTMLElement | null;
    if (line && list.current) list.current.scrollTo({ top: Math.max(0, line.offsetTop - 12), behavior: 'smooth' });
  }, [nowIndex]);

  if (!records) return <p className="empty">Loading…</p>;
  if (!item) return <p>Nothing published here. <Link to="/">Everything published</Link></p>;
  const ready = item.clip?.status === 'ready';
  const playFrom = (seconds: number) => {
    const media = player.current;
    if (!media) return;
    media.currentTime = seconds;
    media.play().catch(() => { /* a click on the player first */ });
  };
  const unpublish = async () => {
    if (!confirm(`Unpublish “${item.title}”? Its page and files are removed.`)) return;
    try {
      await hubCall('unpublish', { id });
      syncNow();
      navigate('/');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  return (
    <article className="publication">
      <div className="card-kind">{KIND_LABEL[item.kind]} · published {day(item.publishedAt)}</div>
      <h1>{item.title}</h1>
      <p className="meta">
        {item.meeting && <>From {item.meeting}{item.recordedAt ? `, ${day(item.recordedAt)}` : ''}</>}
        {item.kind !== 'note' && item.to > 0 && <> · {clock(item.from)} to {clock(item.to)} ({duration(item.seconds)})</>}
        {item.recordingId && can('view.meetings', account) && <> · <Link to={`/meetings/${item.recordingId}`}>the whole meeting</Link></>}
      </p>
      {item.officialUrl && <p><a href={item.officialUrl} rel="noopener noreferrer">Official recording ↗</a> <span className="muted">(from the official source)</span></p>}
      {item.clip && (ready ? (
        <section className="panel player">
          {item.clip.video
            ? <video ref={player} src={mediaUrl(item.clip.video.path)} controls playsInline preload="metadata" poster={item.poster ? mediaUrl(item.poster) : undefined} onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} />
            : <audio ref={player} src={mediaUrl(item.clip.audio?.path || '')} controls preload="metadata" onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)} />}
          <div className="player-bar">
            {item.clip.video && <a href={mediaUrl(item.clip.video.path)} download>⬇ Video ({megabytes(item.clip.video.bytes)})</a>}
            {item.clip.audio && <a href={mediaUrl(item.clip.audio.path)} download>⬇ Audio ({megabytes(item.clip.audio.bytes)})</a>}
          </div>
        </section>
      ) : (
        <p className="note">{item.clip.status === 'failed' ? `The clip couldn't be made: ${item.clip.error || 'unknown error'}` : 'The clip is being prepared by an agent; it appears here when it\'s ready.'}</p>
      ))}
      {item.body && <section className="body"><Body text={item.body} /></section>}
      {item.chapters.length > 0 && (
        <section className="panel"><h2>Chapters</h2>
          <ol className="chapters">{item.chapters.map((chapter) => <li key={chapter.at}>{ready
            ? <button type="button" className="time time-link" onClick={() => playFrom(chapter.at)}>{clock(chapter.at)}</button>
            : <span className="time">{clock(chapter.at)}</span>} {chapter.title}</li>)}</ol>
        </section>
      )}
      {item.transcript && (
        <section className="panel transcript">
          <div className="panel-head"><h2>Transcript</h2>
            <span className="card-actions">
              <a href={mediaUrl(item.transcript.text)} download>⬇ Text</a>
              <a href={mediaUrl(item.transcript.captions)} download>⬇ Captions (.srt)</a>
            </span>
          </div>
          {!lines ? <p className="muted">Loading…</p> : (
            <ol className="lines" ref={list}>{lines.map((line, index) => (
              <li key={index} className={index === nowIndex ? 'now' : undefined}>
                {ready ? <button type="button" className="time time-link" onClick={() => playFrom(line.start)}>{clock(line.start)}</button> : <span className="time">{clock(line.start)}</span>}
                <span>{(index === 0 || lines[index - 1].speaker !== line.speaker) && line.speaker && <strong className="speaker-label">{line.speaker}: </strong>}{line.text}</span>
              </li>
            ))}</ol>
          )}
        </section>
      )}
      {can('publish', account) && (
        <p className="toolbar"><button type="button" className="button" onClick={unpublish}>Unpublish</button>{message && <span className="error">{message}</span>}</p>
      )}
    </article>
  );
}
