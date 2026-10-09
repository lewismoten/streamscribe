import TimeLink from './TimeLink.tsx';
import { byNumber, type ConsentItem } from './documents.ts';

// The meeting's consent agenda: its items in order, each with its files, approved together unless one is pulled to be
// discussed on its own (then when, a click on it plays from there). People allowed to add documents (several at a
// time, in a dialog), mark items pulled, set when one was discussed (the player's moment), and remove files or items.
export default function ConsentPanel({
  items,
  canEdit,
  playerTime,
  playAt,
  onSave,
  onAdd
}: {
  items: ConsentItem[];
  canEdit: boolean;
  playerTime: () => number;
  playAt: ((seconds: number) => void) | null;
  onSave: (items: ConsentItem[], done: string) => void;
  onAdd: (item: ConsentItem | null) => void;
}) {
  if (!items.length && !canEdit) return null;
  const sorted = [...items].sort(byNumber);
  const change = (item: ConsentItem, patch: Partial<ConsentItem>, done: string) =>
    onSave(
      items.map((other) => (other.id === item.id ? { ...other, ...patch } : other)),
      done
    );

  return (
    <section className="panel consent">
      <div className="toolbar">
        <h2 className="grow">Consent agenda</h2>
        {canEdit && (
          <button type="button" className="button" onClick={() => onAdd(null)}>
            ＋ Documents
          </button>
        )}
      </div>
      {sorted.length === 0 && (
        <p className="muted small">None yet: add its documents, pasting each one&apos;s name from the agenda.</p>
      )}
      <ol className="consent-items">
        {sorted.map((item) => (
          <li key={item.id} className={item.pulled ? 'pulled' : ''}>
            <div>
              <strong>{item.number}</strong> {item.title}
              {item.pulled && (
                <span className="tag">
                  Pulled
                  {item.at !== undefined && (
                    <>
                      {' '}
                      <TimeLink seconds={item.at} onPlay={playAt ? () => playAt(item.at!) : null} />
                    </>
                  )}
                </span>
              )}
            </div>
            <div className="chapter-files small">
              {item.links.map((link) => (
                <span key={link.url}>
                  <a href={link.url} target="_blank" rel="noopener noreferrer">
                    {link.label} ↗
                  </a>
                  {canEdit && (
                    <button
                      type="button"
                      className="link-button"
                      aria-label={`Remove ${link.label} from ${item.number}`}
                      onClick={() =>
                        change(
                          item,
                          { links: item.links.filter((other) => other.url !== link.url) },
                          `Removed ${link.label}`
                        )
                      }
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
            </div>
            {canEdit && (
              <div className="toolbar small">
                <button type="button" className="link-button" onClick={() => onAdd(item)}>
                  ＋ File
                </button>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={Boolean(item.pulled)}
                    onChange={(event) =>
                      change(
                        item,
                        { pulled: event.target.checked },
                        event.target.checked ? `Pulled ${item.number}` : `${item.number} back on the consent agenda`
                      )
                    }
                  />{' '}
                  Pulled for discussion
                </label>
                {item.pulled && (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => change(item, { at: Math.floor(playerTime()) }, `${item.number} discussed from here`)}
                  >
                    Discussed from the player&apos;s moment
                  </button>
                )}
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    confirm(`Remove ${item.number} and its files?`) &&
                    onSave(
                      items.filter((other) => other.id !== item.id),
                      `Removed ${item.number}`
                    )
                  }
                >
                  Remove
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
