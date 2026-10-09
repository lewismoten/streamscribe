import { Fragment } from 'react';
import { ANNOTATIONS } from '../annotations/Annotations.tsx';
import type { AnnotationKind, TranscriptLink } from './links.ts';

// The menu under words selected in the transcript: change or remove what's on them already, save them as a clip,
// annotate them (a note, a topic, a quote, a law), and, when they aren't linked yet, link them (a place, a meeting
// document, a Bible passage, a web page). Pressing a choice keeps the selection (it's what the choice is for).
export type SelectionChoice = 'clip' | 'place' | 'document' | 'passage' | 'web' | AnnotationKind;

export default function SelectionMenu({
  top,
  left,
  links,
  labelOf,
  canClip,
  hasDocuments,
  onChange,
  onRemove,
  onChoose
}: {
  top: number;
  left: number;
  // Links and annotations already on the words.
  links: TranscriptLink[];
  labelOf: (link: TranscriptLink) => string;
  canClip: boolean;
  hasDocuments: boolean;
  onChange: (link: TranscriptLink) => void;
  onRemove: (link: TranscriptLink) => void;
  onChoose: (choice: SelectionChoice) => void;
}) {
  const linked = links.some((link) => !link.note && !link.topic && !link.quote && !link.law);
  const item = (choice: SelectionChoice, label: string) => (
    <button key={choice} type="button" role="menuitem" onClick={() => onChoose(choice)}>
      {label}
    </button>
  );
  return (
    <div
      className="selection-menu"
      role="menu"
      tabIndex={-1}
      aria-label="The selected words"
      style={{ top, left }}
      onMouseDown={(event) => event.preventDefault()}
    >
      {links.map((link) => (
        <Fragment key={link.id}>
          <button type="button" role="menuitem" onClick={() => onChange(link)}>
            Change {labelOf(link)}…
          </button>
          <button type="button" role="menuitem" onClick={() => onRemove(link)}>
            Remove {labelOf(link)}
          </button>
        </Fragment>
      ))}
      {canClip && item('clip', 'Save as a clip…')}
      {(Object.keys(ANNOTATIONS) as AnnotationKind[]).map((choice) => item(choice, ANNOTATIONS[choice].add))}
      {/* Words already linked are changed or unlinked, not linked twice. */}
      {!linked && (
        <>
          {item('place', 'Mark as a place…')}
          {hasDocuments && item('document', 'Link to a meeting document…')}
          {item('passage', 'Mark Bible passage…')}
          {item('web', 'Link to a web page…')}
        </>
      )}
    </div>
  );
}
