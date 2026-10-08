import { Link } from 'react-router';
import type { Recording } from './api.ts';
import { duration, KIND_LABEL, recordingTitle, time } from './format.ts';

// A recording in a list: its picture, name, when, how long, and what's been done with it.
export default function RecordingCard({ recording, partCount = 0 }: { recording: Recording; partCount?: number }) {
  return (
    <article className={`card kind-${recording.kind}${recording.partOf ? ' is-part' : ''}`}>
      <Link to={`/recordings/${recording.id}`} className="card-picture" aria-label={recordingTitle(recording)}>
        {recording.thumbnailUrl ? <img src={recording.thumbnailUrl} alt="" loading="lazy" /> : <div className="no-picture">{recording.kind === 'archive' ? '🎞' : '🎙'}</div>}
        {recording.durationSeconds > 0 && <span className="badge duration">{duration(recording.durationSeconds)}</span>}
        {recording.live && <span className="badge live">● Live</span>}
      </Link>
      <div className="card-body">
        <div className="card-kind">{KIND_LABEL[recording.kind]}{recording.startedAt ? ` · ${time(recording.startedAt)}` : ''}</div>
        <h3><Link to={`/recordings/${recording.id}`}>{recordingTitle(recording)}</Link></h3>
        <div className="chips">
          {recording.transcriptLines > 0 && <span title="Transcript lines">📝 {recording.transcriptLines.toLocaleString()}</span>}
          {recording.chapters > 0 && <span title="Chapters">📑 {recording.chapters}</span>}
          {recording.votes > 0 && <span title="Votes">🗳 {recording.votes}</span>}
          {recording.speakerMarks > 0 && <span title="Speaker changes marked">🗣️ {recording.speakerMarks}</span>}
          {partCount > 0 && <span title="Captured sessions joined into this meeting">🧩 {partCount} parts</span>}
          {recording.partOf && <span title="This capture is part of a full meeting">🧩 in a full meeting</span>}
        </div>
        <div className="card-actions">
          {recording.pageUrl && <a href={recording.pageUrl} className="button primary">▶ Review</a>}
          <Link to={`/recordings/${recording.id}`} className="button">Details</Link>
        </div>
      </div>
    </article>
  );
}
