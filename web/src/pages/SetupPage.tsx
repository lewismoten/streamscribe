import { useState, type FormEvent } from 'react';
import { setUp } from '../data/account.ts';

// A new hub's first visit: it has no accounts yet, so the person opening it names the hub and makes the admin account
// (the hub allows this only until there is one). Everything else is set later under Accounts.
export default function SetupPage() {
  const [form, setForm] = useState({ name: '', username: '', displayName: '', password: '', again: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (name: keyof typeof form) => ({
    value: form[name],
    onChange: (event: { target: { value: string } }) => setForm({ ...form, [name]: event.target.value })
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (form.password !== form.again) return setMessage('The passwords are different.');
    setBusy(true);
    setMessage('');
    try {
      await setUp(form.username.trim(), form.password, form.displayName.trim(), form.name.trim());
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="narrow">
      <h1>Set up this hub</h1>
      <p className="muted">
        This hub has no accounts yet. Make yours: it becomes the admin, who can change the hub&apos;s settings and
        everyone&apos;s access under Accounts.
      </p>
      <form className="panel schedule-form" onSubmit={submit}>
        <label>
          The hub&apos;s name <input {...field('name')} placeholder="streamscribe hub" />
        </label>
        <label>
          Username <input {...field('username')} autoComplete="username" required />
        </label>
        <label>
          Your name, as others see it <input {...field('displayName')} placeholder="optional" />
        </label>
        <label>
          Password <input type="password" {...field('password')} autoComplete="new-password" minLength={8} required />
        </label>
        <label>
          Password again{' '}
          <input type="password" {...field('again')} autoComplete="new-password" minLength={8} required />
        </label>
        <div className="toolbar">
          <button type="submit" className="button primary" disabled={busy}>
            Make the admin account
          </button>
        </div>
        {message && (
          <p className="error" role="alert">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
