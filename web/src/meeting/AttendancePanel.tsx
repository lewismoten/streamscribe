import { Link } from 'react-router';
import { activeOn, bodiesOfRecording, MEMBER_KINDS, STAFF_KINDS, type Body, type Term } from '../civic/types.ts';
import { dayKey } from '../format.ts';
import { useRecords } from '../data/useRecords.ts';
import type { Attendance } from '../people/usePeople.ts';

// Who was at the meeting: the body it's a meeting of (matched by source and title, or chosen here), the people on it
// that day (members, officers, staff; see ../civic), and anyone who spoke. Each can be marked present or absent, and
// one as presiding. Saved as the meeting's attendance mark (a layer of the viewer's own, like other marks); person
// pages use it to say who presided, attended, or was absent.
export default function AttendancePanel({
  recordingId,
  recording,
  attendance,
  spoke,
  nameOf,
  canEdit,
  onSave
}: {
  recordingId: string;
  recording: { sourceKey: string; title: string; startedAt: string };
  attendance: Attendance;
  spoke: string[];
  nameOf: (id: string) => string;
  canEdit: boolean;
  onSave: (next: Attendance, message: string) => void;
}) {
  const { records: bodies } = useRecords<Body>('bodies');
  const { records: terms } = useRecords<Term>('terms');
  const matched = bodiesOfRecording(bodies || [], recording, attendance.bodyId);
  const day = dayKey(recording.startedAt);
  // Who was expected, with what they were there as.
  const expected = new Map<string, string>();
  for (const term of terms || []) {
    const data = term.data;
    if (data.sourceKey !== recording.sourceKey || !activeOn(data, day)) continue;
    if (!matched.some((body) => body.id === data.bodyId)) continue;
    if (![...MEMBER_KINDS, ...STAFF_KINDS, 'officer'].includes(data.kind)) continue;
    expected.set(data.personId, [expected.get(data.personId), data.title].filter(Boolean).join(', '));
  }
  const present = new Set(attendance.present || []);
  const absent = new Set(attendance.absent || []);
  const everyone = [...new Set([...expected.keys(), ...spoke, ...present, ...absent])];
  if (!everyone.length && !canEdit) return null;

  const mark = (id: string, value: string) => {
    const nextPresent = new Set(present);
    const nextAbsent = new Set(absent);
    nextPresent.delete(id);
    nextAbsent.delete(id);
    if (value === 'present') nextPresent.add(id);
    if (value === 'absent') nextAbsent.add(id);
    onSave(
      {
        ...attendance,
        present: [...nextPresent],
        absent: [...nextAbsent],
        presiding: value === 'absent' && attendance.presiding === id ? '' : attendance.presiding
      },
      `${nameOf(id)}: ${value || 'not marked'}`
    );
  };
  const presiding = (id: string) =>
    onSave(
      {
        ...attendance,
        presiding: id,
        present: [...new Set([...present, id])],
        absent: [...absent].filter((item) => item !== id)
      },
      `${nameOf(id)} presided`
    );
  const allHere = () =>
    onSave(
      { ...attendance, present: [...new Set([...present, ...[...expected.keys()].filter((id) => !absent.has(id))])] },
      'Everyone expected marked present'
    );

  return (
    <section className="panel attendance" aria-labelledby={`attendance-${recordingId}`}>
      <h2 id={`attendance-${recordingId}`}>Attendance</h2>
      <p className="muted small">
        {matched.length ? (
          <>
            A meeting of{' '}
            {matched.map((body, index) => (
              <span key={body.id}>
                {index > 0 && ', '}
                <Link to={`/bodies/${encodeURIComponent(body.id)}`}>{body.data.name}</Link>
              </span>
            ))}
            .
          </>
        ) : (
          'Not matched to a public body yet.'
        )}
      </p>
      {canEdit && (bodies || []).length > 0 && (
        <label className="inline small">
          Body{' '}
          <select
            value={attendance.bodyId || ''}
            onChange={(event) => onSave({ ...attendance, bodyId: event.target.value }, 'Body saved')}
          >
            <option value="">Matched by source and title</option>
            {(bodies || []).map((body) => (
              <option key={body.id} value={body.id}>
                {body.data.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ul className="attendance-list">
        {everyone.map((id) => (
          <li key={id}>
            <span className="grow">
              {nameOf(id)}
              <span className="muted small">
                {' '}
                {[expected.get(id), attendance.presiding === id ? 'presided' : '', spoke.includes(id) ? 'spoke' : '']
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            {canEdit ? (
              <>
                <select
                  value={present.has(id) ? 'present' : absent.has(id) ? 'absent' : ''}
                  onChange={(event) => mark(id, event.target.value)}
                  aria-label={`Was ${nameOf(id)} there?`}
                >
                  <option value="">—</option>
                  <option value="present">Present</option>
                  <option value="absent">Absent</option>
                </select>
                <label className="inline small">
                  <input
                    type="radio"
                    name={`presiding-${recordingId}`}
                    checked={attendance.presiding === id}
                    onChange={() => presiding(id)}
                  />{' '}
                  Presided
                </label>
              </>
            ) : (
              <span className="small">{present.has(id) ? 'Present' : absent.has(id) ? 'Absent' : ''}</span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && expected.size > 0 && (
        <button type="button" className="button" onClick={allHere}>
          Everyone expected was here
        </button>
      )}
    </section>
  );
}
