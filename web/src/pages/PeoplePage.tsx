import { useCallback, useEffect, useState } from 'react';
import { can, refreshAccount, useAccount, type User } from '../data/account.ts';
import { hubCall } from '../data/hub.ts';

// People and groups on the hub. Admins (manage.users) change anyone's group, turn accounts off, remove them, and set
// what each group may do and who new sign-ups are. Reviewers (review) mark people trusted or not: an untrusted
// person's changes are seen by them alone.
interface Person extends User { contributions: number; private: number }
interface Group { id: number; name: string; builtin: boolean; position: number; permissions: string[] }

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'never');

export default function PeoplePage() {
  const account = useAccount();
  const [people, setPeople] = useState<Person[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [message, setMessage] = useState('');
  const admin = can('manage.users', account);
  const load = useCallback(async () => {
    try {
      const reply = await hubCall<{ users: Person[]; groups: Group[] }>('users');
      setPeople(reply.users);
      setGroups(reply.groups);
    } catch (error) {
      setMessage((error as Error).message);
    }
  }, []);
  useEffect(() => { if (account.user) load(); }, [account.user, load]);

  if (!account.user || (!admin && !can('review', account))) return <p className="empty">Only admins and reviewers can see this page.</p>;

  const act = async (work: () => Promise<unknown>, done = '') => {
    setMessage('');
    try {
      await work();
      if (done) setMessage(done);
      await load();
      await refreshAccount();
    } catch (error) {
      setMessage((error as Error).message);
    }
  };
  const update = (person: Person, change: Record<string, unknown>) => act(() => hubCall('users/update', { id: person.id, ...change }));
  const resetPassword = (person: Person) => {
    const password = prompt(`New password for ${person.username} (at least 8 characters):`);
    if (password) act(() => hubCall('users/update', { id: person.id, password }), `${person.username}'s password is changed; they are signed out everywhere.`);
  };
  const remove = (person: Person) => {
    if (confirm(`Remove ${person.username}? Their account goes, and their changes with it.`)) act(() => hubCall('users/delete', { id: person.id }), `Removed ${person.username}.`);
  };
  const saveGroup = (group: Partial<Group>) => act(() => hubCall('groups/save', group));
  const addGroup = () => {
    const name = prompt('Name of the new group:');
    if (name?.trim()) saveGroup({ name: name.trim(), permissions: [] });
  };
  const removeGroup = (group: Group) => {
    const others = groups.filter((item) => item.id !== group.id && item.id !== 1);
    const target = prompt(`Remove the group ${group.name}? Its people move to (type one): ${others.map((item) => item.name).join(', ')}`, others.find((item) => item.id === account.settings?.defaultGroupId)?.name || others[0]?.name);
    const moveTo = others.find((item) => item.name.toLowerCase() === target?.trim().toLowerCase());
    if (target && !moveTo) setMessage(`No group named ${target}`);
    if (moveTo) act(() => hubCall('groups/delete', { id: group.id, moveTo: moveTo.id }), `Removed ${group.name}; its people are in ${moveTo.name} now.`);
  };
  const settings = account.settings;
  const permissionNames = account.permissionNames;

  return (
    <section>
      <div className="toolbar"><h1 className="grow">People</h1></div>
      {message && <p className="note">{message}</p>}
      <div className="panel table-scroll">
        <table className="people">
          <thead><tr><th>Person</th><th>Group</th><th title="Others see their changes">Trusted</th>{admin && <th>Account</th>}<th>Changes</th><th>Joined</th><th>Last seen</th>{admin && <th />}</tr></thead>
          <tbody>
            {people.map((person) => (
              <tr key={person.id} className={person.disabled ? 'muted' : ''}>
                <td><strong>{person.displayName || person.username}</strong>{person.displayName && <div className="muted">{person.username}</div>}</td>
                <td>{admin ? (
                  <select value={person.groupId} onChange={(event) => update(person, { groupId: Number(event.target.value) })} aria-label={`${person.username}'s group`}>
                    {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                ) : person.group}</td>
                <td><input type="checkbox" checked={person.trusted} onChange={(event) => update(person, { trusted: event.target.checked })} aria-label={`Trust ${person.username}`} /></td>
                {admin && <td><label className="inline"><input type="checkbox" checked={!person.disabled} onChange={(event) => update(person, { disabled: !event.target.checked })} /> on</label></td>}
                <td>{person.contributions} public{person.private ? `, ${person.private} private` : ''}</td>
                <td>{when(person.createdAt)}</td>
                <td>{when(person.lastSeenAt)}</td>
                {admin && <td className="card-actions">
                  <button type="button" className="link-button" onClick={() => resetPassword(person)}>Password</button>
                  {person.id !== account.user?.id && <button type="button" className="link-button" onClick={() => remove(person)}>Remove</button>}
                </td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {admin && (
        <>
          <div className="toolbar"><h2 className="grow">Groups</h2><button type="button" className="button" onClick={addGroup}>＋ New group</button></div>
          <div className="panel table-scroll">
            <table className="permissions">
              <thead>
                <tr><th>Permission</th>{groups.map((group) => (
                  <th key={group.id}>
                    {group.id === 1 ? group.name : <input className="group-name" defaultValue={group.name} aria-label="Group name"
                      onBlur={(event) => { if (event.target.value.trim() && event.target.value.trim() !== group.name) saveGroup({ ...group, name: event.target.value.trim() }); }} />}
                    {group.id !== 1 && <button type="button" className="link-button" title={`Remove ${group.name}`} onClick={() => removeGroup(group)}>✕</button>}
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {Object.entries(permissionNames).map(([permission, label]) => (
                  <tr key={permission}>
                    <td>{label}</td>
                    {groups.map((group) => (
                      <td key={group.id} className="center">
                        <input type="checkbox" checked={group.id === 1 || group.permissions.includes(permission)} disabled={group.id === 1}
                          aria-label={`${group.name}: ${label}`}
                          onChange={(event) => saveGroup({ ...group, permissions: event.target.checked ? [...group.permissions, permission] : group.permissions.filter((item) => item !== permission) })} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">Admins can do everything. A change someone's group can't make public is kept for them alone. An admin's changes win over everyone else's.</p>
          </div>

          {settings && (
            <div className="panel schedule-form">
              <h2>Sign-ups</h2>
              <label className="inline"><input type="checkbox" checked={settings.registration === 'open'} onChange={(event) => act(() => hubCall('hub-settings', { registration: event.target.checked ? 'open' : 'closed' }))} /> Anyone can make an account</label>
              <label>New accounts join <select value={settings.defaultGroupId} onChange={(event) => act(() => hubCall('hub-settings', { defaultGroupId: Number(event.target.value) }))}>
                {groups.filter((group) => group.id !== 1).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select></label>
              <label className="inline"><input type="checkbox" checked={settings.newUsersTrusted} onChange={(event) => act(() => hubCall('hub-settings', { newUsersTrusted: event.target.checked }))} /> New accounts are trusted (others see their changes until you say otherwise)</label>
            </div>
          )}
        </>
      )}
    </section>
  );
}
