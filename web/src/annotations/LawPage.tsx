import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { clock, date } from '../format.ts';
import { LAW_KINDS, LAW_LEVELS, lawTitle, type Law, type LawKind, type LawLevel } from './types.ts';
import { atHref, useAnnotations } from './useAnnotations.ts';

// A law or document: what it is, where to read it, and every meeting moment that cited it (and the section meant).
export default function LawPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const navigate = useNavigate();
  const { records: laws } = useRecords<Law>('laws');
  const annotations = useAnnotations();
  const [draft, setDraft] = useState<Law | null>(null);
  const law = laws?.find((item) => item.id === id);
  if (!laws) return <p className="empty">Loading…</p>;
  if (!law)
    return (
      <p>
        Not found. <Link to="/laws">All laws and documents</Link>
      </p>
    );
  const editor = can('contribute.chapters', account);
  const cited = (annotations || []).filter((item) => item.link.law?.id === id);
  const set = (patch: Partial<Law>) => draft && setDraft({ ...draft, ...patch });
  return (
    <article>
      <div className="card-kind">
        <Link to="/laws">Laws and documents</Link> · {LAW_LEVELS[law.data.level]} · {LAW_KINDS[law.data.kind]}
      </div>
      <div className="toolbar">
        <h1 className="grow">{law.data.name}</h1>
        {editor && !draft && (
          <button type="button" className="button" onClick={() => setDraft(law.data)}>
            Change
          </button>
        )}
      </div>
      {draft ? (
        <form
          className="schedule-form panel"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!draft.name.trim()) return;
            await putRecord('laws', id, draft);
            setDraft(null);
          }}
        >
          <div className="form-grid">
            <label>
              Level
              <select value={draft.level} onChange={(event) => set({ level: event.target.value as LawLevel })}>
                {(Object.keys(LAW_LEVELS) as LawLevel[]).map((key) => (
                  <option key={key} value={key}>
                    {LAW_LEVELS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Kind
              <select value={draft.kind} onChange={(event) => set({ kind: event.target.value as LawKind })}>
                {(Object.keys(LAW_KINDS) as LawKind[]).map((key) => (
                  <option key={key} value={key}>
                    {LAW_KINDS[key]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Name
              <input value={draft.name} onChange={(event) => set({ name: event.target.value })} />
            </label>
            <label>
              Citation
              <input value={draft.citation || ''} onChange={(event) => set({ citation: event.target.value })} />
            </label>
            <label>
              Whose
              <input value={draft.jurisdiction || ''} onChange={(event) => set({ jurisdiction: event.target.value })} />
            </label>
            <label>
              Where to read it
              <input type="url" value={draft.url || ''} onChange={(event) => set({ url: event.target.value })} />
            </label>
          </div>
          <label className="block">
            Note
            <textarea rows={2} value={draft.note || ''} onChange={(event) => set({ note: event.target.value })} />
          </label>
          <div className="toolbar">
            <button type="submit" className="button primary">
              Save
            </button>
            <button type="button" className="button" onClick={() => setDraft(null)}>
              Cancel
            </button>
            {cited.length === 0 && (
              <button
                type="button"
                className="link-button danger"
                onClick={async () => {
                  await removeRecord('laws', id);
                  navigate('/laws');
                }}
              >
                Delete
              </button>
            )}
          </div>
        </form>
      ) : (
        <>
          <p>
            {lawTitle(law.data)}
            {law.data.jurisdiction && <> · {law.data.jurisdiction}</>}
            {law.data.url && (
              <>
                {' '}
                <a href={law.data.url} target="_blank" rel="noreferrer">
                  Read it ↗
                </a>
              </>
            )}
          </p>
          {law.data.note && <p className="muted">{law.data.note}</p>}
        </>
      )}
      {can('view.meetings', account) && (
        <section className="panel">
          <h2>Cited in meetings</h2>
          {cited.length === 0 ? (
            <p className="muted small">Not cited in a meeting yet.</p>
          ) : (
            <ul>
              {cited.map((item) => (
                <li key={item.link.id}>
                  <Link to={atHref(item)}>
                    {item.meeting}, {date(item.startedAt)} at {clock(item.at)}
                  </Link>
                  : “{item.link.text}”{item.link.law?.section && <> · {item.link.law.section}</>}
                  {item.chapter && <span className="muted small"> · {item.chapter}</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </article>
  );
}
