import { clock } from '../format.ts';
import type { Publication } from './types.ts';

// The official sources: the official video (embedded with its own player, and linked at this stretch), documents,
// calendar entry. This archive is independent; these are the originals.
export default function OfficialSources({ item }: { item: Publication }) {
  const official = item.official!;
  const groups = [...new Set(official.links.map((link) => link.group))];
  return (
    <section className="panel official">
      <h2>From the official source</h2>
      {official.swagit && (
        <>
          <div className="official-embed">
            {/* The official player is another site's page, sandboxed to running its player, full screen, and opening
                links in a new window. It keeps its own origin (its player loads from its own server); scripts with
                same-origin only matter for a frame from this site's own origin, which this never is. */}
            <iframe
              title="Official video (Swagit)"
              src={`${official.swagit.base}/videos/${official.swagit.videoId}/embed?autoplay=0`}
              // oxlint-disable-next-line react/iframe-missing-sandbox -- cross-site, as said above
              sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
              allow="fullscreen"
              loading="lazy"
            />
          </div>
          {official.page && item.kind !== 'note' && item.to > 0 && (
            <p>
              <a href={official.page} target="_blank" rel="noopener noreferrer">
                Watch this part on the official site ↗
              </a>
              {official.at !== null && (
                <span className="muted">
                  {' '}
                  (from {clock(official.at)}
                  {official.to !== null ? ` to ${clock(official.to)}` : ''} of the official video)
                </span>
              )}
            </p>
          )}
        </>
      )}
      {groups.map((group) => (
        <div key={group} className="official-group">
          <h3>{group}</h3>
          <ul className="small">
            {official.links
              .filter((link) => link.group === group)
              .map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label} ↗
                  </a>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
