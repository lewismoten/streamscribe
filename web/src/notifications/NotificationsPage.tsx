import { can, useAccount } from '../data/account.ts';
import { ActiveJobs, Notices } from './NoticeList.tsx';
import { useNotifications } from './useNotifications.ts';

// Every message from agents (newest first), and the jobs under way with their progress.
export default function NotificationsPage() {
  const account = useAccount();
  const { notices, active } = useNotifications();
  if (!can('view.meetings', account)) return <p className="empty">Only for people who may see meetings.</p>;
  return (
    <section>
      <h1>Notifications</h1>
      <section className="panel">
        <h2>Under way</h2>
        {active.length ? <ActiveJobs jobs={active} /> : <p className="muted small">Nothing under way.</p>}
      </section>
      <section className="panel">
        <h2>Messages</h2>
        <Notices notices={notices} />
      </section>
    </section>
  );
}
