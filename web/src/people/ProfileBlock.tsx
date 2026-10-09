import { useState, type FormEvent } from 'react';
import type { Civic } from '../civic/useCivic.ts';
import { can } from '../data/account.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import {
  linkUrl,
  nameParts,
  profileId,
  readLink,
  saveLinkKinds,
  siteName,
  useProfiles,
  type LinkKind,
  type Profile
} from './profiles.ts';
import { saveRosterPerson } from './roster.ts';
import type { MeetingPerson } from './usePeople.ts';

// Under a person's name on their page: what they do (their position and group on the roster, and who they work for),
// their other names, and their links (pages on other sites by id, and any others, such as Facebook). People who may
// edit public bodies change them; the position and group are the roster's, for people who may also see meetings.
export default function ProfileBlock({ person, civic }: { person: MeetingPerson; civic: Civic }) {
  const { profiles, kinds } = useProfiles();
  const id = profileId(person.sourceKey, person.id);
  const profile = profiles.get(id) || {};
  const [editing, setEditing] = useState(false);
  const employer = civic.organizations?.find((item) => item.id === profile.employerId)?.data.name;
  const work = [person.nameUnknown ? '' : person.role, person.group, employer].filter(Boolean);
  const others = (profile.nicknames || []).slice(1);
  const kindLinks = kinds.filter((kind) => profile.links?.[kind.id]);
  const links = [
    ...kindLinks.map((kind) => ({ label: kind.name, url: linkUrl(kind, profile.links![kind.id]) })),
    ...(profile.urls || [])
  ];

  return (
    <div className="profile-block">
      {work.length > 0 && <p className="meta">{work.join(' · ')}</p>}
      {others.length > 0 && <p className="muted">Also known as {others.map((name) => `“${name}”`).join(', ')}</p>}
      {links.length > 0 && (
        <p className="profile-links small">
          {links.map((link) => (
            <a key={link.url} href={link.url} target="_blank" rel="noreferrer">
              {link.label} ↗
            </a>
          ))}
        </p>
      )}
      {civic.editor && !editing && (
        <button type="button" className="link-button small" onClick={() => setEditing(true)}>
          Change name, work, and links…
        </button>
      )}
      {editing && (
        <ProfileForm
          id={id}
          person={person}
          profile={profile}
          kinds={kinds}
          civic={civic}
          onDone={() => setEditing(false)}
        />
      )}
    </div>
  );
}

const HONORIFICS = [
  'Mr.',
  'Mrs.',
  'Ms.',
  'Miss',
  'Mx.',
  'Dr.',
  'Hon.',
  'Rev.',
  'Pastor',
  'Sgt.',
  'Capt.',
  'Lt.',
  'Col.'
];
const SUFFIXES = ['Jr.', 'Sr.', 'II', 'III', 'IV', 'PhD', 'MD', 'Esq.'];

function ProfileForm({
  id,
  person,
  profile,
  kinds,
  civic,
  onDone
}: {
  id: string;
  person: MeetingPerson;
  profile: Profile;
  kinds: LinkKind[];
  civic: Civic;
  onDone: () => void;
}) {
  const parts = nameParts(profile);
  const [form, setForm] = useState({
    honorific: parts.honorific || '',
    first: parts.first || '',
    middle: parts.middle || '',
    last: parts.last || '',
    suffix: parts.suffix || '',
    nicknames: (parts.nicknames || []).join(', '),
    employerId: parts.employerId || '',
    role: person.role || '',
    group: person.group || ''
  });
  const [links, setLinks] = useState<Record<string, string>>(profile.links || {});
  const [urls, setUrls] = useState(profile.urls || []);
  const [pasted, setPasted] = useState('');
  const [message, setMessage] = useState('');
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  // The roster is private, like the meetings: its position and group are for people who may see them.
  const roster = can('view.meetings', civic.account) && Boolean(civic.account.user);
  const field = (name: keyof typeof form) => ({
    value: form[name],
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [name]: event.target.value })
  });

  // A pasted address: its id under its kind of link, or a link of its own (named for its site).
  const addPasted = () => {
    const found = readLink(pasted, kinds);
    if (!found) return setMessage("That isn't a web address");
    if ('kind' in found && found.kind) setLinks({ ...links, [found.kind.id]: found.id });
    else setUrls([...urls, { label: siteName(pasted.trim()), url: pasted.trim() }]);
    setPasted('');
    setMessage('');
  };
  // A link that holds an id (such as a staff directory's ?eid=34): a kind of link of its own, for anyone's profile.
  const makeKind = async (index: number) => {
    const link = urls[index];
    const found = readLink(link.url, kinds);
    if (!found || !('prefix' in found) || !found.prefix)
      return setMessage("This link doesn't seem to have an id in it");
    const name = prompt(`Links starting ${found.prefix} are called:`, link.label);
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
    setUrls(urls.filter((_, at) => at !== index));
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const text = (value: string) => value.trim();
    await putRecord('profiles', id, {
      honorific: text(form.honorific),
      first: text(form.first),
      middle: text(form.middle),
      last: text(form.last),
      suffix: text(form.suffix),
      nicknames: form.nicknames.split(',').map(text).filter(Boolean),
      employerId: form.employerId,
      links: Object.fromEntries(Object.entries(links).filter(([, value]) => value.trim())),
      urls: urls
        .filter((link) => link.url.trim())
        .map((link) => ({ label: text(link.label) || siteName(link.url), url: text(link.url) }))
    } satisfies Profile);
    if (roster && marks && (text(form.role) !== (person.role || '') || text(form.group) !== (person.group || '')))
      await saveRosterPerson(civic.account, marks, person.sourceKey, person.id, {
        role: text(form.role),
        group: text(form.group)
      });
    onDone();
  };

  return (
    <form className="panel schedule-form profile-form" onSubmit={save}>
      <fieldset>
        <legend>Name</legend>
        <div className="form-grid name-grid">
          <label>
            Title
            <input {...field('honorific')} list="honorifics" placeholder="Hon." />
          </label>
          <label>
            First
            <input {...field('first')} />
          </label>
          <label>
            Middle
            <input {...field('middle')} />
          </label>
          <label>
            Last
            <input {...field('last')} />
          </label>
          <label>
            Suffix
            <input {...field('suffix')} list="suffixes" placeholder="Jr." />
          </label>
          <label>
            Nicknames, separated by commas (the first shows in their name)
            <input {...field('nicknames')} placeholder="Zach" />
          </label>
        </div>
        <datalist id="honorifics">
          {HONORIFICS.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </datalist>
        <datalist id="suffixes">
          {SUFFIXES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </datalist>
      </fieldset>
      <fieldset>
        <legend>Work</legend>
        <div className="form-grid">
          {roster && (
            <>
              <label>
                Position
                <input {...field('role')} placeholder="Deputy Clerk" />
              </label>
              <label>
                Group
                <input {...field('group')} list="roster-groups" placeholder="County staff" />
              </label>
              <datalist id="roster-groups">
                {civic.roster.groups.map((group) => (
                  <option key={group} value={group}>
                    {group}
                  </option>
                ))}
              </datalist>
            </>
          )}
          <label>
            Works for
            <select {...field('employerId')}>
              <option value="">—</option>
              {(civic.organizations || []).map((organization) => (
                <option key={organization.id} value={organization.id}>
                  {organization.data.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset>
        <legend>Links</legend>
        <div className="form-grid">
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
        <ul className="profile-urls">
          {urls.map((link, index) => (
            <li key={index}>
              <input
                value={link.label}
                onChange={(event) =>
                  setUrls(urls.map((item, at) => (at === index ? { ...item, label: event.target.value } : item)))
                }
                aria-label="What the link is"
              />
              <input
                type="url"
                value={link.url}
                onChange={(event) =>
                  setUrls(urls.map((item, at) => (at === index ? { ...item, url: event.target.value } : item)))
                }
                aria-label="Its address"
              />
              <button type="button" className="link-button" onClick={() => makeKind(index)}>
                Use for others like it
              </button>
              <button
                type="button"
                className="link-button"
                onClick={() => setUrls(urls.filter((_, at) => at !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <span className="toolbar">
          <label className="inline">
            Add a link{' '}
            <input
              type="url"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="https://www.facebook.com/…"
            />
          </label>
          <button type="button" className="button" onClick={addPasted} disabled={!pasted.trim()}>
            Add
          </button>
        </span>
        <p className="muted small">
          A link to a site of known links (such as Virginia elections) keeps only its id. “Use for others like it” makes
          one, for links that end in an id (such as a staff directory&apos;s …?eid=34).
        </p>
      </fieldset>
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
