import { useState } from 'react';
import { Link } from 'react-router';
import { ActiveJobs, Notices } from './NoticeList.tsx';
import { useNotifications } from './useNotifications.ts';

// The bell in the top bar (for people who may see meetings): how many messages are new, and, opened, the jobs under way
// with their progress and the latest messages. Opening it marks them seen.
export default function NotificationsBell() {
  const { notices, active, unseen, markSeen } = useNotifications();
  const [open, setOpen] = useState(false);
  const fresh = new Set(unseen.map((notice) => notice.id));
  const [shownFresh, setShownFresh] = useState<Set<string>>(new Set());
  const toggle = () => {
    if (!open) {
      setShownFresh(fresh);
      markSeen();
    }
    setOpen(!open);
  };
  const count = unseen.length;
  return (
    <div className="bell">
      <button
        type="button"
        className="bell-button"
        aria-expanded={open}
        aria-label={`Notifications${count ? `: ${count} new` : ''}${active.length ? `, ${active.length} job${active.length === 1 ? '' : 's'} under way` : ''}`}
        onClick={toggle}
      >
        🔔{count > 0 && <span className="bell-count">{count}</span>}
        {active.length > 0 && <span className="bell-busy" aria-hidden="true" />}
      </button>
      {open && (
        <section className="bell-panel panel" aria-label="Notifications">
          {active.length > 0 && (
            <>
              <h2>Under way</h2>
              <ActiveJobs jobs={active} />
            </>
          )}
          <h2>Messages</h2>
          <Notices notices={notices.slice(0, 6)} unseen={shownFresh} />
          <Link to="/notifications" className="small" onClick={() => setOpen(false)}>
            All messages and jobs
          </Link>
        </section>
      )}
    </div>
  );
}
