import { useState } from 'react';
import { listedPerson, savePublic, type Directory } from './directory.ts';
import { shownName, type MeetingPerson } from './usePeople.ts';

// For people who may publish: whether a person is listed on the public People page, and whether their photo may be
// shown publicly (there, and beside their name in published transcripts). Saving updates the hub's public directory.
export default function PublicToggles({
  person,
  directories,
  groups
}: {
  person: MeetingPerson;
  directories: Directory[] | null;
  groups: string[];
}) {
  const entry = listedPerson(directories, person.sourceKey, person.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const save = async (listed: boolean, photo: boolean) => {
    setBusy(true);
    setProblem('');
    try {
      await savePublic(person, groups, listed, photo);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const name = shownName(person);
  return (
    <span className="public-toggles small">
      <label className="inline">
        <input
          type="checkbox"
          checked={Boolean(entry)}
          disabled={busy}
          onChange={(event) => save(event.target.checked, false)}
          aria-label={`List ${name} publicly`}
        />
        Public
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={Boolean(entry?.photo)}
          disabled={busy || !entry || !person.photo}
          onChange={(event) => save(true, event.target.checked)}
          aria-label={`Show ${name}'s photo publicly`}
        />
        Public photo
      </label>
      {problem && <span className="error">{problem}</span>}
    </span>
  );
}
