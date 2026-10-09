import { useEffect, useState } from 'react';
import { hubCall } from '../data/hub.ts';
import type { Enrolled, Install } from './types.ts';

// For admins: adds an agent (making its one-time install command), and lists the agents added so far with a new
// install command or a revoke for each.
const fetchEnrolled = () => hubCall<{ agents: Enrolled[]; packageReady: boolean }>('agents');

export default function AddAgent() {
  const [enrolled, setEnrolled] = useState<Enrolled[]>([]);
  const [packageReady, setPackageReady] = useState(true);
  const [install, setInstall] = useState<Install | null>(null);
  const [form, setForm] = useState({ id: '', name: '' });
  const [problem, setProblem] = useState('');
  const show = (value: { agents: Enrolled[]; packageReady: boolean }) => {
    setEnrolled(value.agents);
    setPackageReady(value.packageReady);
  };
  // Errors are left alone: the list just stays as it was.
  const loadEnrolled = () => fetchEnrolled().then(show, () => {});
  useEffect(() => {
    fetchEnrolled().then(
      (value) => {
        setEnrolled(value.agents);
        setPackageReady(value.packageReady);
      },
      () => {}
    );
  }, []);
  const agentAction = async (route: string, body: Record<string, string>) => {
    setProblem('');
    try {
      const reply = await hubCall<Install & { ok?: boolean }>(route, body);
      setInstall(reply.command ? reply : null);
      if (route === 'agents/create') setForm({ id: '', name: '' });
      loadEnrolled();
    } catch (error) {
      setProblem((error as Error).message);
    }
  };

  return (
    <section className="panel add-agent">
      <h2>Add an agent</h2>
      <p className="muted small">
        For a Raspberry Pi (64-bit Raspberry Pi OS), another Debian or Ubuntu machine, or a Mac with Homebrew. The
        command installs what the agent needs, joins this hub, and sets it up as a service that restarts if it stops and
        starts with the machine (on a Mac, when you log in). Run it there, in a terminal, as the user the agent should
        run as.
      </p>
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          agentAction('agents/create', form);
        }}
      >
        <label>
          Short id{' '}
          <input
            value={form.id}
            onChange={(event) => setForm({ ...form, id: event.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
            placeholder="pi1"
            size={10}
            required
          />
        </label>
        <label>
          Name{' '}
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Kitchen Raspberry Pi"
          />
        </label>
        <button type="submit" className="button primary">
          Make install command
        </button>
      </form>
      {!packageReady && (
        <p className="error small">
          The agent package isn't on the hub yet: deploy again (bin/deploy-hub.sh makes it).
        </p>
      )}
      {problem && <p className="error">{problem}</p>}
      {install && (
        <div className="install">
          <p>
            On <strong>{install.agent.name}</strong> (ssh into it), run:
          </p>
          <pre className="command">{install.command}</pre>
          <p className="toolbar small">
            <button type="button" className="button" onClick={() => navigator.clipboard?.writeText(install.command)}>
              Copy
            </button>
            <span className="muted">
              Works once, until {new Date(install.expiresAt).toLocaleString()}. Then it shows here as online.
            </span>
          </p>
        </div>
      )}
      {enrolled.length > 0 && (
        <table className="people">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Joined</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {enrolled.map((agent) => (
              <tr key={agent.id} className={agent.revoked ? 'muted' : ''}>
                <td>
                  <strong>{agent.name}</strong> <code>{agent.id}</code>
                </td>
                <td>
                  {agent.revoked
                    ? 'Revoked'
                    : agent.joined
                      ? `Yes, ${new Date(agent.enrolledAt || '').toLocaleDateString()}`
                      : 'Not yet'}
                </td>
                <td className="card-actions">
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => agentAction('agents/token', { id: agent.id })}
                  >
                    {agent.joined ? 'Reinstall command' : 'New install command'}
                  </button>
                  {!agent.revoked && (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        if (confirm(`Revoke ${agent.name}? Its key stops working at once.`))
                          agentAction('agents/revoke', { id: agent.id });
                      }}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
