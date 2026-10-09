import { useState } from 'react';
import { Link } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { clock, date } from '../format.ts';
import { useSpeakerInfo } from './speakers.ts';
import { atHref, useAnnotations } from './useAnnotations.ts';

// Quotes used in meetings: the actual words, who they were attributed to (and who really said them, when that's
// different), who quoted them, and where; found by any of that.
export default function QuotesPage() {
  const account = useAccount();
  const annotations = useAnnotations();
  const speakerInfo = useSpeakerInfo();
  const [find, setFind] = useState('');
  if (!can('view.meetings', account)) return <p className="empty">Quotes come from meetings, which are private.</p>;
  if (!annotations) return <p className="empty">Loading…</p>;
  const needle = find.trim().toLowerCase();
  const quotes = annotations
    .filter((item) => item.kind === 'quote')
    .map((item) => ({
      item,
      quote: item.link.quote!,
      by: item.speakers.map((speaker) => ({ ...speakerInfo(item.sourceKey, speaker), speaker }))
    }))
    .filter(
      ({ item, quote, by }) =>
        !needle ||
        [quote.quote, quote.attributedTo, quote.saidBy, quote.source, item.meeting, ...by.map((who) => who.name)]
          .join(' ')
          .toLowerCase()
          .includes(needle)
    );
  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Quotes</h1>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="Find a quote, an author, a speaker"
          aria-label="Find a quote"
        />
      </div>
      <p className="muted small">
        Select words in a meeting&apos;s transcript and choose <strong>Mark as a quote…</strong> to add one.
      </p>
      {quotes.length === 0 && <p className="empty">No quotes yet.</p>}
      <ul className="quote-list">
        {quotes.map(({ item, quote, by }) => (
          <li key={item.link.id} className="panel">
            <blockquote className="quote">{quote.quote}</blockquote>
            <p className="small">
              {quote.attributedTo && <>Attributed to {quote.attributedTo}</>}
              {quote.saidBy && quote.saidBy !== quote.attributedTo && (
                <>
                  {quote.attributedTo ? '; actually ' : 'Said by '}
                  {quote.saidBy}
                </>
              )}
              {quote.source && <> · {quote.source}</>}
              {quote.url && (
                <>
                  {' '}
                  <a href={quote.url} target="_blank" rel="noreferrer">
                    More ↗
                  </a>
                </>
              )}
            </p>
            <p className="small muted">
              Quoted
              {by.length > 0 && (
                <>
                  {' by '}
                  {by.map((who, index) => (
                    <span key={who.speaker}>
                      {index > 0 && ', '}
                      {who.href ? <Link to={who.href}>{who.name}</Link> : who.name}
                    </span>
                  ))}
                </>
              )}{' '}
              in <Link to={atHref(item)}>{item.meeting}</Link>, {date(item.startedAt)} at {clock(item.at)}: “
              {item.link.text}”
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
