import { Link } from 'react-router';
import { hubSettings, mediaUrl } from '../data/hub.ts';
import { useRecords } from '../data/useRecords.ts';
import { duration } from '../format.ts';
import { KIND_LABEL, day, type Publication } from './types.ts';

// What's published from the archive, for everyone (the meetings themselves are private): a card for each, newest
// first, and a podcast feed for each source with clips.
export function PublishedList() {
  const { records } = useRecords<Publication>('publications');
  if (!records) return <p className="empty">Loading…</p>;
  const sorted = [...records].sort((a, b) => String(b.data.publishedAt).localeCompare(String(a.data.publishedAt)));
  const feeds = [
    ...new Map(
      sorted
        .filter((record) => record.data.clip?.status === 'ready')
        .map((record) => [record.data.sourceKey, record.data.sourceName])
    ).entries()
  ];
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Published</h1>
        {feeds.map(([key, name]) => (
          <a
            key={key}
            className="button"
            href={`${hubSettings().url}/podcast/${encodeURIComponent(key)}.xml`}
            title={`Podcast of ${name} clips: add this address to a podcast app`}
          >
            🎧 {feeds.length > 1 ? name : 'Podcast'}
          </a>
        ))}
      </div>
      <p className="muted">
        Notes, transcripts, and clips from an independent archive of public meetings. Each links to the official
        recording where there is one.
      </p>
      {sorted.length === 0 ? (
        <p className="empty">Nothing published yet.</p>
      ) : (
        <div className="grid">
          {sorted.map((record) => {
            const item = record.data;
            return (
              <article key={record.id} className="card">
                <Link to={`/published/${record.id}`} className="card-picture" aria-label={item.title}>
                  {item.poster ? (
                    <img src={mediaUrl(item.poster)} alt="" loading="lazy" />
                  ) : (
                    <div className="no-picture">
                      {item.kind === 'clip' ? '🎬' : item.kind === 'transcript' ? '📝' : '🗒'}
                    </div>
                  )}
                  {item.kind !== 'note' && item.seconds > 0 && (
                    <span className="badge duration">{duration(item.seconds)}</span>
                  )}
                </Link>
                <div className="card-body">
                  <div className="card-kind">
                    {KIND_LABEL[item.kind]}
                    {item.clip && item.clip.status !== 'ready' ? ' · being prepared' : ''}
                  </div>
                  <h3>
                    <Link to={`/published/${record.id}`}>{item.title}</Link>
                  </h3>
                  <p className="meta">
                    {item.meeting || item.sourceName}
                    {item.recordedAt ? ` · ${day(item.recordedAt)}` : ''}
                  </p>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
