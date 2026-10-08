import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { api, type Config, type SearchResponse } from '../api.ts';
import { clock, date, pageAt, recordingTitle } from '../format.ts';

// The server marks matched words with [[ ]].
function Snippet({ text }: { text: string }) {
  return <>{text.split(/(\[\[.*?\]\])/).map((part, index) => (part.startsWith('[[') ? <mark key={index}>{part.slice(2, -2)}</mark> : <Fragment key={index}>{part}</Fragment>))}</>;
}

// Searches every transcript at once, grouped by recording, newest first.
export default function SearchPage({ config }: { config: Config }) {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const query = params.get('q') || '';
  const source = params.get('source') || '';
  const parts = params.get('parts') === '1';
  // Keeps the other search settings when one changes.
  const searchUrl = (changes: Record<string, string>) => {
    const next = new URLSearchParams({ q: query, ...(source ? { source } : {}), ...(parts ? { parts: '1' } : {}), ...changes });
    for (const [key, value] of [...next]) if (!value) next.delete(key);
    return `/search?${next}`;
  };
  const [text, setText] = useState(query);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setText(query);
    if (!query) { setResponse(null); return; }
    setError('');
    api.search(query, source, parts).then(setResponse).catch((reason: Error) => setError(reason.message));
  }, [query, source, parts]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    navigate(searchUrl({ q: text.trim() }));
  };

  return (
    <section>
      <form className="toolbar" onSubmit={submit} role="search">
        <input type="search" className="wide" value={text} onChange={(event) => setText(event.target.value)} placeholder='Words to find (use "quotes" for a phrase)' autoFocus aria-label="Search all transcripts" />
        {config.sources.length > 1 && (
          <select value={source} onChange={(event) => navigate(searchUrl({ source: event.target.value }))} aria-label="Source">
            <option value="">All sources</option>
            {config.sources.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}
          </select>
        )}
        <label className="check" title="Live captures and official recordings that build-meeting joined into a full meeting repeat its lines">
          <input type="checkbox" checked={parts} onChange={(event) => navigate(searchUrl({ parts: event.target.checked ? '1' : '' }))} />
          Include captures already in a full meeting
        </label>
        <button type="submit" className="button primary">Search</button>
      </form>
      {error && <p className="error">{error}</p>}
      {response && (
        <p className="muted">
          {response.results.length === 0 ? `Nothing found for “${response.query}”.`
            : `${response.results.length === 500 ? 'The first 500' : response.results.length} ${response.results.length === 1 ? 'line' : 'lines'} in ${response.recordings.length} ${response.recordings.length === 1 ? 'recording' : 'recordings'}`}
        </p>
      )}
      {response?.recordings.map((recording) => {
        const hits = response.results.filter((hit) => hit.recordingId === recording.id);
        return (
          <section key={recording.id} className="panel result">
            <div className="panel-head">
              <h2><Link to={`/recordings/${recording.id}`}>{recordingTitle(recording)}</Link></h2>
              <span className="muted">{date(recording.startedAt)} · {hits.length} {hits.length === 1 ? 'match' : 'matches'}</span>
            </div>
            <ol className="lines">
              {hits.map((hit, index) => (
                <li key={index}>
                  <a href={pageAt(recording, hit.start)} className="time">{clock(hit.start)}</a>
                  <span><Snippet text={hit.snippet} /></span>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </section>
  );
}
