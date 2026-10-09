import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { hubCall, mediaUrl } from '../data/hub.ts';
import { useRecords } from '../data/useRecords.ts';
import { syncNow } from '../data/sync.ts';
import { clock, duration } from '../format.ts';
import OfficialSources from './OfficialSources.tsx';
import { KIND_LABEL, day, type Line, type Publication } from './types.ts';
import { listedPerson, useDirectory } from '../people/directory.ts';

// One publication's page: its player (with captions) and downloads, its text, the official sources, chapters, and
// a transcript that follows the player. Those who may publish can unpublish it.
const megabytes = (bytes: number) => `${(bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)} MB`;

// Text with its paragraphs and web addresses as links.
function Body({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p key={index}>
          {paragraph.split(/(https?:\/\/[^\s)]+)/g).map((piece, at) =>
            /^https?:\/\//.test(piece) ? (
              <a key={at} href={piece} rel="noopener noreferrer">
                {piece}
              </a>
            ) : (
              piece.split('\n').map((line, row) => (
                <span key={row}>
                  {row > 0 && <br />}
                  {line}
                </span>
              ))
            )
          )}
        </p>
      ))}
    </>
  );
}

export function PublicationPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const account = useAccount();
  const { records } = useRecords<Publication>('publications');
  const directories = useDirectory();
  const record = records?.find((item) => item.id === id);
  const item = record?.data;
  // The transcript's lines, with the path they came from: a different publication's lines aren't shown while its
  // own are fetched.
  const [loaded, setLoaded] = useState<{ path: string; lines: Line[] } | null>(null);
  const [time, setTime] = useState(-1);
  const [message, setMessage] = useState('');
  const player = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const transcriptPath = item?.transcript?.path;
  const lines = transcriptPath && loaded?.path === transcriptPath ? loaded.lines : null;
  useEffect(() => {
    if (!transcriptPath) return;
    fetch(mediaUrl(transcriptPath))
      .then((response) => response.json())
      .then((value) => setLoaded({ path: transcriptPath, lines: value.lines || [] }))
      .catch(() => setLoaded({ path: transcriptPath, lines: [] }));
  }, [transcriptPath]);
  // The line being played (marked "now") is scrolled into view as playing moves on.
  const nowIndex = lines ? lines.findLastIndex((line) => line.start <= time + 0.2) : -1;
  useEffect(() => {
    const line = list.current?.children[nowIndex] as HTMLElement | undefined;
    if (line && list.current) list.current.scrollTo({ top: Math.max(0, line.offsetTop - 12), behavior: 'smooth' });
  }, [nowIndex]);

  if (!records) return <p className="empty">Loading…</p>;
  if (!item)
    return (
      <p>
        Nothing published here. <Link to="/">Everything published</Link>
      </p>
    );
  const ready = item.clip?.status === 'ready';
  // Captions for the player, from the WebVTT copy of the transcript (browsers don't read .srt); older publications
  // have none. The media is fetched without credentials (crossOrigin) so a track from the hub's address loads.
  const vtt = item.transcript?.vtt;
  const playFrom = (seconds: number) => {
    const media = player.current;
    if (!media) return;
    media.currentTime = seconds;
    media.play().catch(() => {
      /* a click on the player first */
    });
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
      <div className="card-kind">
        {KIND_LABEL[item.kind]} · published {day(item.publishedAt)}
      </div>
      <h1>{item.title}</h1>
      <p className="meta">
        {item.meeting && (
          <>
            From {item.meeting}
            {item.recordedAt ? `, ${day(item.recordedAt)}` : ''}
          </>
        )}
        {item.kind !== 'note' && item.to > 0 && (
          <>
            {' '}
            · {clock(item.from)} to {clock(item.to)} ({duration(item.seconds)})
          </>
        )}
        {item.recordingId && can('view.meetings', account) && (
          <>
            {' '}
            · <Link to={`/meetings/${item.recordingId}`}>the whole meeting</Link>
          </>
        )}
      </p>
      {item.kind === 'video' && (item.parts || []).length > 0 && (
        <details className="video-parts">
          <summary>
            Made of {item.parts!.length} clip{item.parts!.length === 1 ? '' : 's'} ({duration(item.seconds)})
          </summary>
          <ol>
            {item.parts!.map((part, index) => (
              <li key={index}>
                {part.title}{' '}
                <span className="muted small">
                  · {part.meeting}
                  {part.recordedAt ? `, ${day(part.recordedAt)}` : ''} · {duration(part.seconds)}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
      {!item.official && item.officialUrl && (
        <p>
          <a href={item.officialUrl} rel="noopener noreferrer">
            Official recording ↗
          </a>{' '}
          <span className="muted">(from the official source)</span>
        </p>
      )}
      {item.clip &&
        (ready ? (
          <section className="panel player">
            {item.clip.video ? (
              // oxlint-disable-next-line jsx-a11y/media-has-caption -- its <track> is there when there are WebVTT captions
              <video
                ref={player}
                src={mediaUrl(item.clip.video.path)}
                controls
                playsInline
                preload="metadata"
                poster={item.poster ? mediaUrl(item.poster) : undefined}
                crossOrigin={vtt ? 'anonymous' : undefined}
                onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
              >
                {vtt && <track kind="captions" srcLang="en" label="Transcript" src={mediaUrl(vtt)} default />}
              </video>
            ) : (
              // oxlint-disable-next-line jsx-a11y/media-has-caption -- its <track> is there when there are WebVTT captions
              <audio
                ref={player}
                src={mediaUrl(item.clip.audio?.path || '')}
                controls
                preload="metadata"
                crossOrigin={vtt ? 'anonymous' : undefined}
                onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
              >
                {vtt && <track kind="captions" srcLang="en" label="Transcript" src={mediaUrl(vtt)} default />}
              </audio>
            )}
            <div className="player-bar">
              {item.clip.video && (
                <a href={mediaUrl(item.clip.video.path)} download>
                  ⬇ Video ({megabytes(item.clip.video.bytes)})
                </a>
              )}
              {item.clip.audio && (
                <a href={mediaUrl(item.clip.audio.path)} download>
                  ⬇ Audio ({megabytes(item.clip.audio.bytes)})
                </a>
              )}
            </div>
          </section>
        ) : (
          <p className="note">
            {item.clip.status === 'failed'
              ? `The clip couldn't be made: ${item.clip.error || 'unknown error'}`
              : "The clip is being prepared by an agent; it appears here when it's ready."}
          </p>
        ))}
      {item.body && (
        <section className="body">
          <Body text={item.body} />
        </section>
      )}
      {item.official && (item.official.swagit || item.official.links.length > 0) && <OfficialSources item={item} />}
      {item.chapters.length > 0 && (
        <section className="panel">
          <h2>Chapters</h2>
          <ol className="chapters">
            {item.chapters.map((chapter) => (
              <li key={chapter.at}>
                {ready ? (
                  <button type="button" className="time time-link" onClick={() => playFrom(chapter.at)}>
                    {clock(chapter.at)}
                  </button>
                ) : (
                  <span className="time">{clock(chapter.at)}</span>
                )}{' '}
                {chapter.title}
                {chapter.official && (
                  <a
                    className="official-at"
                    href={chapter.official}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="On the official video, at this moment"
                  >
                    ↗
                  </a>
                )}
                {chapter.links?.length ? (
                  <span className="chapter-files small">
                    {chapter.links.map((link) => (
                      <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">
                        {link.label} ↗
                      </a>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      )}
      {item.transcript && (
        <section className="panel transcript">
          <div className="panel-head">
            <h2>Transcript</h2>
            <span className="card-actions">
              <a href={mediaUrl(item.transcript.text)} download>
                ⬇ Text
              </a>
              <a href={mediaUrl(item.transcript.captions)} download>
                ⬇ Captions (.srt)
              </a>
            </span>
          </div>
          {!lines ? (
            <p className="muted">Loading…</p>
          ) : (
            <ol className="lines" ref={list}>
              {lines.map((line, index) => (
                <li key={index} className={index === nowIndex ? 'now' : undefined}>
                  {ready ? (
                    <button type="button" className="time time-link" onClick={() => playFrom(line.start)}>
                      {clock(line.start)}
                    </button>
                  ) : (
                    <span className="time">{clock(line.start)}</span>
                  )}
                  <span>
                    {(index === 0 || lines[index - 1].speaker !== line.speaker) && line.speaker && (
                      <strong className="speaker-label">
                        {(line.speakers || []).map((speakerId) => {
                          // A listed person's public photo, linking to their public page.
                          const listed = listedPerson(directories, item.sourceKey, speakerId);
                          return listed?.photo ? (
                            <Link
                              key={speakerId}
                              to={`/people/${encodeURIComponent(item.sourceKey)}/${encodeURIComponent(speakerId)}`}
                              title={listed.name}
                            >
                              <img className="avatar speaker-photo" src={mediaUrl(listed.photo)} alt="" />
                            </Link>
                          ) : null;
                        })}
                        {line.speaker}:{' '}
                      </strong>
                    )}
                    <LinkedText text={line.text} links={line.links || []} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      {can('publish', account) && (
        <p className="toolbar">
          <button type="button" className="button" onClick={unpublish}>
            Unpublish
          </button>
          {message && <span className="error">{message}</span>}
        </p>
      )}
    </article>
  );
}

// A line's text with its linked phrases (a web page, a Bible passage) as links.
function LinkedText({
  text,
  links
}: {
  text: string;
  links: { from: number; to: number; url: string; label: string }[];
}) {
  const sorted = [...links]
    .sort((a, b) => a.from - b.from)
    .filter((link, index, list) => index === 0 || link.from >= list[index - 1].to);
  const pieces: ReactNode[] = [];
  let at = 0;
  for (const link of sorted) {
    if (link.from > at) pieces.push(text.slice(at, link.from));
    pieces.push(
      <a key={link.from} href={link.url} target="_blank" rel="noreferrer" title={link.label}>
        {text.slice(link.from, link.to)}
      </a>
    );
    at = link.to;
  }
  pieces.push(text.slice(at));
  return <>{pieces}</>;
}
