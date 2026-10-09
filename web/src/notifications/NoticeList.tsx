import { useState } from 'react';
import { Link } from 'react-router';
import { date, time } from '../format.ts';
import type { HubRecord } from '../data/useRecords.ts';
import type { Job, Notice } from './useNotifications.ts';

// Jobs under way (each with its progress), and messages (newest first; where a result is, with a way to copy a file's
// location on its agent).
export function ActiveJobs({ jobs }: { jobs: HubRecord<Job>[] }) {
  if (!jobs.length) return null;
  return (
    <ul className="active-jobs">
      {jobs.map((job) => (
        <li key={job.id}>
          <strong>{job.data.title}</strong>
          <span className="muted small">
            {' '}
            {job.data.status === 'queued'
              ? 'waiting for an agent'
              : `${job.data.agentName || 'an agent'} · ${Math.round((job.data.progress || 0) * 100)}%${job.data.message ? ` · ${job.data.message}` : ''}`}
          </span>
          <progress
            max={1}
            value={job.data.status === 'queued' ? 0 : job.data.progress || 0}
            aria-label={`${job.data.title}: progress`}
          />
        </li>
      ))}
    </ul>
  );
}

export function Notices({ notices, unseen }: { notices: HubRecord<Notice>[]; unseen?: Set<string> }) {
  const [copied, setCopied] = useState('');
  if (!notices.length) return <p className="muted small">No messages yet.</p>;
  return (
    <ul className="notices">
      {notices.map((notice) => (
        <li
          key={notice.id}
          className={`${notice.data.problem ? 'problem' : ''}${unseen?.has(notice.id) ? ' unseen' : ''}`}
        >
          <strong>{notice.data.title}</strong>
          <span className="muted small">
            {' '}
            · {date(notice.data.createdAt)} {time(notice.data.createdAt)}
            {notice.data.agent ? ` · ${notice.data.agent}` : ''}
          </span>
          <div className="small">{notice.data.message}</div>
          {notice.data.link && (
            <Link to={notice.data.link} className="small">
              Open it
            </Link>
          )}
          {notice.data.location && (
            <div className="small notice-location">
              <code>{notice.data.location}</code>{' '}
              <button
                type="button"
                className="link-button"
                onClick={() =>
                  navigator.clipboard?.writeText(notice.data.location!).then(() => {
                    setCopied(notice.id);
                    setTimeout(() => setCopied(''), 2000);
                  })
                }
              >
                {copied === notice.id ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
