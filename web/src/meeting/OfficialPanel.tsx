import { useState } from 'react';
import { embedCode, isTimed, officialLinks, parseOfficialUrl, videoAt } from '../../../src/sync/official.js';
import SyncPoints from './SyncPoints.tsx';

// A meeting's official sources (src/sync/official.js): the official video (watch, from the player's moment, embed,
// download, transcript, agenda), its documents (overview, agenda, packet), and calendar entry. People who may edit
// chapters can set them by pasting the official addresses, give another video of the meeting (YouTube, …), and keep
// the official video lined up with this recording (SyncPoints).
export interface Official {
  swagit?: { base: string; videoId: string; offset?: number; timeline?: [number, number][]; duration?: number };
  civicclerk?: { base: string; eventId: string; agendaFileId?: string; packetFileId?: string };
  // Another video of the meeting (used when there's no Swagit video): linked at a time with ?<param>=<seconds>.
  video?: { url: string; param?: string; offset?: number; timeline?: [number, number][] };
  calendarUrl?: string;
  links?: { label: string; url: string }[];
}

export default function OfficialPanel({
  official,
  playerTime,
  canEdit,
  onSave
}: {
  official: Official | null;
  playerTime: () => number;
  canEdit: boolean;
  onSave: (official: Official) => Promise<void>;
}) {
  const [autoplay, setAutoplay] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    video: '',
    event: '',
    agenda: '',
    packet: '',
    calendar: '',
    offset: '',
    otherVideo: '',
    param: 't',
    other: ''
  });
  const [problem, setProblem] = useState('');
  const links = officialLinks(official) as { group: string; label: string; url: string }[];
  const groups = [...new Set(links.map((link) => link.group))];
  const timed = isTimed(official);
  const clockOf = official?.swagit || official?.video;

  const startEditing = () => {
    const clerk = official?.civicclerk;
    setForm({
      video: official?.swagit ? `${official.swagit.base}/videos/${official.swagit.videoId}` : '',
      event: clerk ? `${clerk.base}/event/${clerk.eventId}/overview` : '',
      agenda: clerk?.agendaFileId ? `${clerk.base}/event/${clerk.eventId}/files/agenda/${clerk.agendaFileId}` : '',
      packet: clerk?.packetFileId ? `${clerk.base}/event/${clerk.eventId}/files/agenda/${clerk.packetFileId}` : '',
      calendar: official?.calendarUrl || '',
      offset: Number.isFinite(clockOf?.offset) ? String(clockOf?.offset) : '',
      otherVideo: official?.video?.url || '',
      param: official?.video?.param || 't',
      other: (official?.links || []).map((link) => `${link.label} | ${link.url}`).join('\n')
    });
    setProblem('');
    setEditing(true);
  };
  const save = async () => {
    const next: Official = {};
    const read = (text: string) => (text.trim() ? parseOfficialUrl(text) : null);
    const video = read(form.video);
    if (form.video.trim() && !video?.swagit) {
      setProblem('The official video should be a Swagit video address (…/videos/<number>)');
      return;
    }
    if (video?.swagit) {
      const same = official?.swagit?.videoId === video.swagit.videoId ? official?.swagit : undefined;
      const swagit: NonNullable<Official['swagit']> = {
        ...video.swagit,
        ...(same ? { timeline: same.timeline, duration: same.duration } : {})
      };
      if (form.offset.trim()) swagit.offset = Number(form.offset);
      next.swagit = swagit;
    }
    for (const [field, kind] of [
      ['event', ''],
      ['agenda', 'agendaFileId'],
      ['packet', 'packetFileId']
    ] as const) {
      const value = read(form[field]);
      if (form[field].trim() && !value?.civicclerk) {
        setProblem(
          `${field === 'event' ? 'The meeting overview' : field === 'agenda' ? 'The agenda' : 'The packet'} should be a CivicClerk address (…/event/<number>…)`
        );
        return;
      }
      if (!value?.civicclerk) continue;
      const clerk: NonNullable<Official['civicclerk']> = {
        ...(next.civicclerk || value.civicclerk),
        eventId: next.civicclerk?.eventId || value.civicclerk.eventId
      };
      if (kind && value.file) clerk[kind] = value.file.id;
      next.civicclerk = clerk;
    }
    if (form.otherVideo.trim()) {
      if (!/^https?:\/\/\S+$/.test(form.otherVideo.trim())) {
        setProblem('The other video should be a web address (https://…)');
        return;
      }
      const same = official?.video?.url === form.otherVideo.trim() ? official.video : undefined;
      next.video = {
        url: form.otherVideo.trim(),
        param: form.param.trim() || 't',
        ...(same?.timeline ? { timeline: same.timeline } : {})
      };
      if (!next.swagit && form.offset.trim()) next.video.offset = Number(form.offset);
    }
    if (form.calendar.trim()) next.calendarUrl = form.calendar.trim();
    next.links = form.other
      .split('\n')
      .map((line) => line.split('|').map((part) => part.trim()))
      .filter((parts) => parts.some(Boolean))
      .map((parts) =>
        parts.length > 1 ? { label: parts[0], url: parts.slice(1).join('|') } : { label: '', url: parts[0] }
      )
      .filter((link) => /^https?:\/\//.test(link.url));
    await onSave(next);
    setEditing(false);
  };

  if (!links.length && !canEdit) return null;
  return (
    <section className="panel official">
      <div className="panel-head">
        <h2>Official sources</h2>
        {canEdit && !editing && (
          <button type="button" className="link-button" onClick={startEditing}>
            {links.length ? 'Edit' : 'Add'}
          </button>
        )}
      </div>
      {!links.length && !editing && (
        <p className="muted small">
          No official sources linked yet. Add the official video, agenda, and calendar entry.
        </p>
      )}
      {!editing &&
        groups.map((group) => (
          <div key={group} className="official-group">
            <h3>{group}</h3>
            <ul className="small">
              {links
                .filter((link) => link.group === group)
                .map((link) => (
                  <li key={link.url}>
                    <a href={link.url} rel="noopener noreferrer" target="_blank">
                      {link.label} ↗
                    </a>
                  </li>
                ))}
              {group === 'Official video' && clockOf && (
                <li>
                  <a
                    href={videoAt(official, 0) || '#'}
                    rel="noopener noreferrer"
                    target="_blank"
                    onClick={(event) => {
                      event.currentTarget.href = videoAt(official, playerTime()) || event.currentTarget.href;
                    }}
                  >
                    From the player's moment ↗
                  </a>
                  {!timed && <span className="muted"> (not lined up: set the offset)</span>}
                </li>
              )}
            </ul>
          </div>
        ))}
      {!editing && canEdit && official && clockOf && (
        <SyncPoints official={official} playerTime={playerTime} onSave={onSave} />
      )}
      {!editing && official?.swagit && (
        <details className="small">
          <summary>Embed the official video</summary>
          <label className="inline">
            <input type="checkbox" checked={autoplay} onChange={(event) => setAutoplay(event.target.checked)} /> Start
            playing on its own
          </label>
          <textarea
            readOnly
            rows={3}
            value={embedCode(official.swagit, { autoplay })}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            type="button"
            className="button"
            onClick={() => navigator.clipboard?.writeText(embedCode(official.swagit!, { autoplay }))}
          >
            Copy
          </button>
        </details>
      )}
      {editing && (
        <div className="schedule-form small">
          <p className="muted">Paste the official addresses; the ids are taken from them.</p>
          <label>
            Official video (Swagit){' '}
            <input
              value={form.video}
              onChange={(event) => setForm({ ...form, video: event.target.value })}
              placeholder="https://…swagit.com/videos/403089"
            />
          </label>
          <label>
            Seconds the official video is ahead of this one{' '}
            <input
              value={form.offset}
              onChange={(event) => setForm({ ...form, offset: event.target.value })}
              placeholder={clockOf?.timeline?.length ? 'lined up by sync points' : '0'}
              disabled={Boolean(clockOf?.timeline?.length)}
            />
          </label>
          <label>
            Another video of the meeting (YouTube, …){' '}
            <input
              value={form.otherVideo}
              onChange={(event) => setForm({ ...form, otherVideo: event.target.value })}
              placeholder="https://www.youtube.com/watch?v=…"
            />
          </label>
          <label>
            Its time setting in the address (seconds){' '}
            <input
              value={form.param}
              onChange={(event) => setForm({ ...form, param: event.target.value })}
              placeholder="t"
            />
          </label>
          <label>
            Meeting overview (CivicClerk){' '}
            <input
              value={form.event}
              onChange={(event) => setForm({ ...form, event: event.target.value })}
              placeholder="https://…civicclerk.com/event/2947/overview"
            />
          </label>
          <label>
            Agenda{' '}
            <input
              value={form.agenda}
              onChange={(event) => setForm({ ...form, agenda: event.target.value })}
              placeholder="…/event/2947/files/agenda/6083"
            />
          </label>
          <label>
            Full packet{' '}
            <input
              value={form.packet}
              onChange={(event) => setForm({ ...form, packet: event.target.value })}
              placeholder="…/event/2947/files/agenda/6084"
            />
          </label>
          <label>
            Calendar entry{' '}
            <input
              value={form.calendar}
              onChange={(event) => setForm({ ...form, calendar: event.target.value })}
              placeholder="https://…/Calendar.aspx?EID=…"
            />
          </label>
          <label>
            Other links (one per line: label | address){' '}
            <textarea
              rows={3}
              value={form.other}
              onChange={(event) => setForm({ ...form, other: event.target.value })}
            />
          </label>
          {problem && <p className="error">{problem}</p>}
          <div className="toolbar">
            <button type="button" className="button primary" onClick={save}>
              Save
            </button>
            <button type="button" className="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
