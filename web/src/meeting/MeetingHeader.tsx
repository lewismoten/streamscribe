import { Link } from 'react-router';
import { can, type Account } from '../data/account.ts';
import { duration } from '../format.ts';
import { dateTime, mediaUrlOf, STATUS_LABEL, type RecordingData } from '../pages/MeetingsPage.tsx';

// A meeting page's heading: its first still, title, when and how long, why the recording stopped, and what the viewer
// may do here. Someone allowed to publish can ask for the hub's audio and video when there isn't any yet.
const STOP_REASON: Record<string, string> = {
  standby: 'the standby slide',
  idle: 'no new video',
  cap: 'the time limit'
};

export default function MeetingHeader({
  recording: data,
  picture,
  account,
  hasMedia,
  onEncode
}: {
  recording: RecordingData;
  picture: string | undefined;
  account: Account;
  hasMedia: boolean;
  onEncode: () => void;
}) {
  return (
    <header className="recording-head">
      {picture && <img src={mediaUrlOf(picture)} alt="" className="recording-picture" />}
      <div>
        <div className="card-kind">
          {STATUS_LABEL[data.status] || data.status} · {data.sourceKey} · recorded by {data.recorderId}
        </div>
        <h1>{data.title}</h1>
        <p className="meta">
          {dateTime(data.startedAt)}
          {data.stoppedAt
            ? ` – ${new Date(data.stoppedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
            : ''}
          {data.durationSeconds > 0 && <> · {duration(data.durationSeconds)}</>}
          {data.stopReason && <> · stopped after {STOP_REASON[data.stopReason] || data.stopReason}</>}
        </p>
        {data.error && <p className="error">{data.error}</p>}
        <p className="muted">
          {account.user ? (
            <>
              Click a word to correct it or to say who is speaking from there.
              {account.user.trusted ? '' : ' Your changes are visible only to you.'}
            </>
          ) : (
            <>
              <Link to="/account">Sign in</Link> to correct the transcript or say who is speaking.
            </>
          )}{' '}
          {hasMedia ? `The full-quality video is on ${data.recorderId}.` : `The video is on ${data.recorderId}.`}
        </p>
        {!hasMedia && can('publish', account) && (
          <p className="small">
            <button type="button" className="link-button" onClick={onEncode}>
              Make audio and video for the hub
            </button>
          </p>
        )}
      </div>
    </header>
  );
}
