import { useState } from 'react';
import { clock } from '../format.ts';
import type { AudienceMember } from '../people/usePeople.ts';

// People seen in the audience (on a camera view that shows it): county staff, vendors, officials of other bodies,
// residents. Each is tagged from the source's people (or added to them), with the moment they were seen; their page
// then counts the meeting as attended, whether or not they spoke.
export default function AudienceList({
  audience,
  people,
  nameOf,
  canEdit,
  moment,
  onPlay,
  onSave,
  onAddPerson
}: {
  audience: AudienceMember[];
  people: { id: string; name?: string; role?: string }[];
  nameOf: (id: string) => string;
  canEdit: boolean;
  // Where the player is (a person is seen then), when it's playing this meeting.
  moment: () => { part: string; seconds: number } | null;
  onPlay: ((part: string, seconds: number) => void) | null;
  onSave: (audience: AudienceMember[], message: string) => void;
  // A new person on the source's roster; returns their id.
  onAddPerson: (name: string, role: string) => Promise<string>;
}) {
  const [choice, setChoice] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('');
  const tagged = new Set(audience.map((member) => member.id));
  const add = (id: string) => {
    const at = moment();
    onSave(
      [
        ...audience.filter((member) => member.id !== id),
        { id, ...(at ? { part: at.part, at: Math.floor(at.seconds) } : {}) }
      ],
      `${nameOf(id)} in the audience`
    );
    setChoice('');
  };
  const addNew = async () => {
    if (!newName.trim()) return;
    const id = await onAddPerson(newName.trim(), newRole.trim());
    add(id);
    setNewName('');
    setNewRole('');
  };
  if (!audience.length && !canEdit) return null;
  return (
    <div className="audience">
      <h3>In the audience</h3>
      {audience.length === 0 && <p className="muted small">No one tagged yet.</p>}
      <ul className="attendance-list">
        {audience.map((member) => (
          <li key={member.id}>
            <span className="grow">{nameOf(member.id)}</span>
            {member.at !== undefined && member.part && (
              <button
                type="button"
                className="link-button small"
                disabled={!onPlay}
                onClick={() => onPlay?.(member.part!, member.at!)}
                title="Where they were seen"
              >
                seen at {clock(member.at)}
              </button>
            )}
            {canEdit && (
              <button
                type="button"
                className="link-button danger small"
                onClick={() =>
                  onSave(
                    audience.filter((item) => item.id !== member.id),
                    `${nameOf(member.id)} not in the audience`
                  )
                }
                aria-label={`Remove ${nameOf(member.id)} from the audience`}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <div className="toolbar small">
          <select
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            aria-label="Someone in the audience"
          >
            <option value="">Someone seen…</option>
            {[...people]
              .filter((person) => !tagged.has(person.id))
              .sort((a, b) => nameOf(a.id).localeCompare(nameOf(b.id)))
              .map((person) => (
                <option key={person.id} value={person.id}>
                  {nameOf(person.id)}
                  {person.role ? ` (${person.role})` : ''}
                </option>
              ))}
          </select>
          <button type="button" className="button" disabled={!choice} onClick={() => add(choice)}>
            Tag at the player&apos;s moment
          </button>
          <input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Or a new name"
            aria-label="A new person's name"
          />
          <input
            value={newRole}
            onChange={(event) => setNewRole(event.target.value)}
            placeholder="Role (Vendor, Resident…)"
            aria-label="Their role"
          />
          <button type="button" className="button" disabled={!newName.trim()} onClick={addNew}>
            Add and tag
          </button>
        </div>
      )}
    </div>
  );
}
