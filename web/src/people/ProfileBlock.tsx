import { useState, type FormEvent } from 'react';
import { putRecord } from '../data/useRecords.ts';
import { linkUrl, profileId, readLink, saveLinkKinds, useProfiles, type LinkKind, type Profile } from './profiles.ts';
import type { MeetingPerson } from './usePeople.ts';

// A person's other names (formal name, nicknames) and their pages on other sites, under their name on their page.
// People who may edit public bodies change them; pasting a link to another site fills in its id, or makes a new kind
// of link (saved once, for everyone's profiles).
export default function ProfileBlock({ person, canEdit }: { person: MeetingPerson; canEdit: boolean }) {
  const { profiles, kinds } = useProfiles();
  const id = profileId(person.sourceKey, person.id);
  const profile = profiles.get(id) || {};
  const [editing, setEditing] = useState(false);
  const links = kinds.filter((kind) => profile.links?.[kind.id]);
  const names = [
    profile.formalName && profile.formalName !== person.name ? profile.formalName : '',
    ...(profile.nicknames || []).map((nickname) => `“${nickname}”`)
  ].filter(Boolean);

  return (
    <div className="profile-block">
      {names.length > 0 && <p className="muted">Also known as {names.join(', ')}</p>}
      {links.length > 0 && (
        <p className="small">
          {links.map((kind, index) => (
            <span key={kind.id}>
              {index > 0 && ' · '}
              <a href={linkUrl(kind, profile.links![kind.id])}>{kind.name}</a>
            </span>
          ))}
        </p>
      )}
      {canEdit && !editing && (
        <button type="button" className="link-button small" onClick={() => setEditing(true)}>
          Names and links…
        </button>
      )}
      {editing && <ProfileForm id={id} profile={profile} kinds={kinds} onDone={() => setEditing(false)} />}
    </div>
  );
}

function ProfileForm({
  id,
  profile,
  kinds,
  onDone
}: {
  id: string;
  profile: Profile;
  kinds: LinkKind[];
  onDone: () => void;
}) {
  const [formalName, setFormalName] = useState(profile.formalName || '');
  const [nicknames, setNicknames] = useState((profile.nicknames || []).join(', '));
  const [links, setLinks] = useState<Record<string, string>>(profile.links || {});
  const [pasted, setPasted] = useState('');
  const [message, setMessage] = useState('');

  // A pasted address: its id under its kind of link, or a new kind made from it.
  const addPasted = async () => {
    const found = readLink(pasted, kinds);
    if (!found) return setMessage("That doesn't look like a link to someone's page");
    if ('kind' in found && found.kind) {
      setLinks({ ...links, [found.kind.id]: found.id });
    } else if ('prefix' in found && found.prefix) {
      const name = prompt(
        `A new kind of link, for every address starting ${found.prefix}. What is it called?`,
        new URL(found.prefix).hostname
      );
      if (!name?.trim()) return;
      const kind = {
        id: name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-'),
        name: name.trim(),
        url: found.prefix
      };
      await saveLinkKinds([...kinds.filter((item) => item.id !== kind.id), kind]);
      setLinks({ ...links, [kind.id]: found.id });
    }
    setPasted('');
    setMessage('');
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const kept = Object.fromEntries(Object.entries(links).filter(([, value]) => value.trim()));
    await putRecord('profiles', id, {
      formalName: formalName.trim(),
      nicknames: nicknames
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      links: kept
    });
    onDone();
  };

  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>Names and links</h2>
      <div className="form-grid">
        <label>
          Formal name
          <input
            value={formalName}
            onChange={(event) => setFormalName(event.target.value)}
            placeholder="Victoria Cook"
          />
        </label>
        <label>
          Nicknames, separated by commas
          <input value={nicknames} onChange={(event) => setNicknames(event.target.value)} placeholder="Vicky" />
        </label>
        {kinds.map((kind) => (
          <label key={kind.id}>
            {kind.name} id
            <input
              value={links[kind.id] || ''}
              onChange={(event) => setLinks({ ...links, [kind.id]: event.target.value })}
              placeholder={kind.url.includes('{id}') ? kind.url : `${kind.url}…`}
            />
          </label>
        ))}
      </div>
      <label className="inline">
        Paste a link to their page on another site{' '}
        <input
          type="url"
          value={pasted}
          onChange={(event) => setPasted(event.target.value)}
          placeholder="https://historical.elections.virginia.gov/candidate/87362"
        />
      </label>{' '}
      <button type="button" className="button" onClick={addPasted} disabled={!pasted.trim()}>
        Add
      </button>
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save
        </button>
        <button type="button" className="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
