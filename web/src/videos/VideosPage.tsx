import { Link, useNavigate } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { date, duration } from '../format.ts';
import type { Publication } from '../published/types.ts';
import { seconds, type Clip, type Video } from './types.ts';

// Videos put together from clips of any meetings (private, like the meetings, until one is published): each with
// how many clips, how long, and whether it's published. A new one opens in the editor.
export default function VideosPage() {
  const account = useAccount();
  const navigate = useNavigate();
  const { records: videos } = useRecords<Video>('videos');
  const { records: clips } = useRecords<Clip>('clips');
  const { records: publications } = useRecords<Publication>('publications');
  if (!can('view.meetings', account)) return <p className="empty">Videos are made from meetings, which are private.</p>;
  const make = async () => {
    const now = new Date().toISOString();
    const id = await putRecord('videos', null, {
      title: 'A new video',
      description: '',
      items: [],
      createdAt: now,
      updatedAt: now
    } satisfies Video);
    navigate(`/videos/${id}`);
  };
  const sorted = [...(videos || [])].sort((a, b) => String(b.data.updatedAt).localeCompare(String(a.data.updatedAt)));

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Videos</h1>
        {account.user && (
          <button type="button" className="button primary" onClick={make}>
            ＋ Video
          </button>
        )}
      </div>
      <p className="muted small">
        Put clips of any meetings together into one video. Clips are saved on a meeting&apos;s page (select words in its
        transcript, then “Save as a clip…”); there are {(clips || []).length} so far.
      </p>
      {sorted.length === 0 && <p className="empty">No videos yet.</p>}
      <ul className="video-rows">
        {sorted.map((record) => {
          const publication = record.data.publicationId
            ? publications?.find((item) => item.id === record.data.publicationId)
            : undefined;
          return (
            <li key={record.id}>
              <Link to={`/videos/${encodeURIComponent(record.id)}`}>
                <strong>{record.data.title}</strong>
              </Link>
              <span className="muted small">
                {' '}
                · {record.data.items.length} clip{record.data.items.length === 1 ? '' : 's'} ·{' '}
                {duration(seconds(record.data.items))} · changed {date(record.data.updatedAt)}
              </span>
              {publication && (
                <span className="small">
                  {' '}
                  · <Link to={`/published/${publication.id}`}>Published</Link>
                  {publication.data.clip?.status !== 'ready' && ` (${publication.data.clip?.status || 'queued'})`}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
