import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { signIn, signOut, signUp, useAccount } from '../data/account.ts';
import { hubCall, hubSettings } from '../data/hub.ts';

// Signing in and up on the hub, and the signed-in person's account: their group, what it lets them do, their password.
// Signed out, everything is read-only.
export default function AccountPage() {
  const account = useAccount();
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [form, setForm] = useState({ username: '', password: '', displayName: '' });
  const [passwords, setPasswords] = useState({ current: '', password: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  if (!hubSettings().url)
    return (
      <p className="empty">
        Set the hub under <Link to="/settings">Settings</Link> first.
      </p>
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      if (mode === 'in') await signIn(form.username.trim(), form.password);
      else await signUp(form.username.trim(), form.password, form.displayName.trim());
      setForm({ username: '', password: '', displayName: '' });
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await hubCall('password', passwords);
      setPasswords({ current: '', password: '' });
      setMessage('Password changed. Other browsers signed in as you are signed out.');
    } catch (error) {
      setMessage((error as Error).message);
    }
  };

  if (!account.user) {
    const closed = account.settings?.registration === 'closed';
    return (
      <section className="narrow">
        <h1>{mode === 'in' ? 'Sign in' : 'Make an account'}</h1>
        <p className="muted">
          Anyone can read everything here. Signed in, you can correct transcripts and say who is speaking; what your
          group can't make public is kept for you alone.
        </p>
        <form className="panel schedule-form" onSubmit={submit}>
          <label>
            Username{' '}
            <input
              value={form.username}
              onChange={(event) => setForm({ ...form, username: event.target.value })}
              autoComplete="username"
              required
            />
          </label>
          {mode === 'up' && (
            <label>
              Your name, as others see it{' '}
              <input
                value={form.displayName}
                onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                placeholder="optional"
              />
            </label>
          )}
          <label>
            Password{' '}
            <input
              type="password"
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              autoComplete={mode === 'in' ? 'current-password' : 'new-password'}
              minLength={mode === 'up' ? 8 : undefined}
              required
            />
          </label>
          <div className="toolbar">
            <button type="submit" className="button primary" disabled={busy}>
              {mode === 'in' ? 'Sign in' : 'Make my account'}
            </button>
            {mode === 'in' && !closed && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setMode('up');
                  setMessage('');
                }}
              >
                New here? Make an account
              </button>
            )}
            {mode === 'up' && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setMode('in');
                  setMessage('');
                }}
              >
                I have an account
              </button>
            )}
          </div>
          {closed && mode === 'in' && <p className="muted">New sign-ups are closed on this hub.</p>}
          {message && <p className="error">{message}</p>}
        </form>
      </section>
    );
  }

  const user = account.user;
  return (
    <section className="narrow">
      <h1>{user.displayName || user.username}</h1>
      <div className="panel">
        <p>
          Signed in as <strong>{user.username}</strong> · {user.group}
          {!user.trusted && <span className="error"> · your changes are visible only to you</span>}
        </p>
        <h2>What you can do</h2>
        {account.permissions.length === 0 ? (
          <p className="muted">Your changes are kept for you alone; nobody else sees them.</p>
        ) : (
          <ul>
            {account.permissions.map((permission) => (
              <li key={permission}>{account.permissionNames[permission] || permission}</li>
            ))}
          </ul>
        )}
        <p className="muted">Anything else you change (in a meeting) is kept for you alone.</p>
        <button type="button" className="button" onClick={() => signOut()}>
          Sign out
        </button>
      </div>
      <form className="panel schedule-form" onSubmit={changePassword}>
        <h2>Change your password</h2>
        <label>
          Current password{' '}
          <input
            type="password"
            value={passwords.current}
            onChange={(event) => setPasswords({ ...passwords, current: event.target.value })}
            autoComplete="current-password"
            required
          />
        </label>
        <label>
          New password{' '}
          <input
            type="password"
            value={passwords.password}
            onChange={(event) => setPasswords({ ...passwords, password: event.target.value })}
            autoComplete="new-password"
            minLength={8}
            required
          />
        </label>
        <div className="toolbar">
          <button type="submit" className="button">
            Change password
          </button>
        </div>
      </form>
      {message && <p className="note">{message}</p>}
    </section>
  );
}
