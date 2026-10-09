import { Link } from 'react-router';
import Dialog from '../Dialog.tsx';
import { clock } from '../format.ts';
import { useRecords } from '../data/useRecords.ts';
import type { AnnotationKind, TranscriptLink } from '../meeting/links.ts';
import type { Word } from '../meeting/words.ts';
import LawForm from './LawForm.tsx';
import NoteForm from './NoteForm.tsx';
import QuoteForm from './QuoteForm.tsx';
import TopicForm from './TopicForm.tsx';
import { lawTitle, momentHref, STANCES, type Law, type MomentRef, type Topic } from './types.ts';

// The transcript's notes, topics, quotes, and laws cited: the marker after the words (a click shows it), what it shows,
// and the dialog that adds or changes one. Words can carry several (a note and a topic, say), and links as well.
export const ANNOTATIONS: Record<AnnotationKind, { icon: string; add: string; title: string }> = {
  note: { icon: '📝', add: 'Add a note…', title: 'Note' },
  topic: { icon: '🏷', add: 'Tag a topic…', title: 'Topic' },
  quote: { icon: '❝', add: 'Mark as a quote…', title: 'Quote' },
  law: { icon: '⚖', add: 'Cite a law or document…', title: 'Law or document cited' }
};
type Saved = Omit<TranscriptLink, 'id'> & { id?: string };
const phraseOf = (words: Word[]) =>
  words
    .map((word) => word.shown)
    .filter(Boolean)
    .join(' ');

// A short label for an annotation (the topic's name and stance, the law's name, …).
export function useAnnotationLabel() {
  const { records: topics } = useRecords<Topic>('topics');
  const { records: laws } = useRecords<Law>('laws');
  return (link: TranscriptLink) => {
    if (link.topic) {
      const name = topics?.find((topic) => topic.id === link.topic!.id)?.data.name || 'Topic';
      const stance = link.topic.stance && link.topic.stance !== 'neutral' ? ` (${link.topic.stance})` : '';
      return `${name}${stance}`;
    }
    if (link.law) {
      const law = laws?.find((item) => item.id === link.law!.id)?.data;
      return law ? law.citation || law.name : 'Law';
    }
    if (link.quote) return link.quote.attributedTo ? `Quote: ${link.quote.attributedTo}` : 'Quote';
    return link.note?.text ? link.note.text.slice(0, 40) + (link.note.text.length > 40 ? '…' : '') : 'Note';
  };
}

// Adding or changing one: the words it's on, and its form.
export function AnnotationEditor({
  kind,
  words,
  link,
  recordingId,
  part,
  onSave,
  onRemove,
  onClose
}: {
  kind: AnnotationKind;
  words: Word[];
  link: TranscriptLink | null;
  recordingId: string;
  part: string;
  onSave: (link: Saved) => void;
  onRemove: (link: TranscriptLink) => void;
  onClose: () => void;
}) {
  const [first, last] = [words[0], words.at(-1)!];
  const phrase = phraseOf(words);
  const base = {
    ...(link ? { id: link.id } : {}),
    from: link?.from || { line: first.line, index: first.index },
    to: link?.to || { line: last.line, index: last.index },
    at: link?.at ?? first.at,
    text: link?.text || phrase
  };
  const remove = link ? () => onRemove(link) : undefined;
  return (
    <Dialog title={`${link ? 'Change' : 'Add'}: ${ANNOTATIONS[kind].title.toLowerCase()}`} onClose={onClose}>
      <p className="muted small">“{base.text}”</p>
      {kind === 'note' && (
        <NoteForm
          value={link?.note || null}
          recordingId={recordingId}
          part={part}
          onSave={(note) => onSave({ ...base, note })}
          onRemove={remove}
        />
      )}
      {kind === 'topic' && (
        <TopicForm value={link?.topic || null} onSave={(topic) => onSave({ ...base, topic })} onRemove={remove} />
      )}
      {kind === 'quote' && (
        <QuoteForm
          value={link?.quote || null}
          words={base.text}
          onSave={(quote) => onSave({ ...base, quote })}
          onRemove={remove}
        />
      )}
      {kind === 'law' && (
        <LawForm
          value={link?.law || null}
          words={base.text}
          onSave={(law) => onSave({ ...base, law })}
          onRemove={remove}
        />
      )}
    </Dialog>
  );
}

// A moment linked from a note: in this meeting it plays there; another meeting's page opens at it; a page elsewhere
// opens in a new tab.
function Moment({
  moment,
  recordingId,
  onPlay
}: {
  moment: MomentRef;
  recordingId: string;
  onPlay: (part: string | undefined, seconds: number) => void;
}) {
  const label = moment.label || (moment.url ? moment.url : `at ${clock(moment.at || 0)}`);
  if (moment.recordingId === recordingId)
    return (
      <button type="button" className="link-button" onClick={() => onPlay(moment.part, moment.at || 0)}>
        ▶ {label}
        {moment.label ? ` (${clock(moment.at || 0)})` : ''}
      </button>
    );
  if (moment.recordingId)
    return (
      <Link to={momentHref(moment)}>
        {label}
        {moment.label ? ` (${clock(moment.at || 0)})` : ''}
      </Link>
    );
  return (
    <a href={moment.url} target="_blank" rel="noreferrer">
      ↗ {label}
    </a>
  );
}

// What one says, with Change and Remove for editors.
export function AnnotationView({
  link,
  recordingId,
  editable,
  onPlay,
  onChange,
  onRemove,
  onClose
}: {
  link: TranscriptLink;
  recordingId: string;
  editable: boolean;
  onPlay: (part: string | undefined, seconds: number) => void;
  onChange: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const { records: topics } = useRecords<Topic>('topics');
  const { records: laws } = useRecords<Law>('laws');
  const kind = link.note ? 'note' : link.topic ? 'topic' : link.quote ? 'quote' : 'law';
  const topic = link.topic && topics?.find((item) => item.id === link.topic!.id);
  const law = link.law && laws?.find((item) => item.id === link.law!.id);
  return (
    <Dialog title={ANNOTATIONS[kind].title} onClose={onClose}>
      <p className="muted small">“{link.text}”</p>
      {link.note && (
        <>
          {link.note.text && <p className="note-text">{link.note.text}</p>}
          {(link.note.refs || []).length > 0 && (
            <ul>
              {link.note.refs!.map((moment, index) => (
                <li key={index}>
                  <Moment
                    moment={moment}
                    recordingId={recordingId}
                    onPlay={(part, seconds) => {
                      onPlay(part, seconds);
                      onClose();
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {link.topic && (
        <p>
          {topic ? <Link to={`/topics/${encodeURIComponent(topic.id)}`}>{topic.data.name}</Link> : 'A topic'}
          {link.topic.stance && <> · {STANCES[link.topic.stance]}</>}
        </p>
      )}
      {link.quote && (
        <>
          <blockquote className="quote">{link.quote.quote}</blockquote>
          <p className="small">
            {link.quote.attributedTo && <>Attributed to {link.quote.attributedTo}. </>}
            {link.quote.saidBy && link.quote.saidBy !== link.quote.attributedTo && (
              <>Actually said by {link.quote.saidBy}. </>
            )}
            {link.quote.source && <>From {link.quote.source}. </>}
            {link.quote.url && (
              <a href={link.quote.url} target="_blank" rel="noreferrer">
                More ↗
              </a>
            )}
          </p>
          <p className="small">
            <Link to="/quotes">All quotes</Link>
          </p>
        </>
      )}
      {link.law && (
        <p>
          {law ? (
            <>
              <Link to={`/laws/${encodeURIComponent(law.id)}`}>{lawTitle(law.data)}</Link>
              {link.law.section && <> · {link.law.section}</>}
              {law.data.url && (
                <>
                  {' '}
                  <a href={law.data.url} target="_blank" rel="noreferrer">
                    Read it ↗
                  </a>
                </>
              )}
            </>
          ) : (
            'A law or document'
          )}
        </p>
      )}
      {editable && (
        <div className="toolbar">
          <button type="button" className="button" onClick={onChange}>
            Change
          </button>
          <button type="button" className="link-button danger" onClick={onRemove}>
            Remove
          </button>
        </div>
      )}
    </Dialog>
  );
}
