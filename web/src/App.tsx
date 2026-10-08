import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router';
import { api, type Config } from './api.ts';
import { setTimeZone } from './format.ts';
import { startSyncing } from './data/sync.ts';
import Library from './pages/Library.tsx';
import RecordingPage from './pages/RecordingPage.tsx';
import SearchPage from './pages/SearchPage.tsx';
import CapturePage from './pages/CapturePage.tsx';
import MeetingsPage from './pages/MeetingsPage.tsx';
import MeetingPage from './pages/MeetingPage.tsx';
import SchedulesPage from './pages/SchedulesPage.tsx';
import LivePage from './pages/LivePage.tsx';
import SettingsPage from './pages/SettingsPage.tsx';

// Two ways to run: served by a recorder's streamscribe server (its library of local recordings, search, and capture,
// plus the hub pages), or as a static site such as GitHub Pages (the hub pages only: meetings, live, schedules, and
// settings, kept in this browser and synced with the hub).
export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [mode, setMode] = useState<'checking' | 'local' | 'static'>('checking');
  useEffect(() => {
    api.config()
      .then((value) => { setTimeZone(value.timeZone); setConfig(value); setMode('local'); })
      .catch(() => setMode('static'));
    startSyncing(30);
  }, []);
  const local = mode === 'local' && config;

  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">🎙 streamscribe</NavLink>
        <nav>
          {local && <NavLink to="/" end>Library</NavLink>}
          {local && <NavLink to="/search">Search</NavLink>}
          {local && <NavLink to="/capture">Capture</NavLink>}
          <NavLink to={local ? '/meetings' : '/'} end={!local}>Meetings</NavLink>
          <NavLink to="/live">Live</NavLink>
          <NavLink to="/schedules">Schedules</NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        {local && <SearchBox />}
      </header>
      <main className="page">
        {mode !== 'checking' && (
          <Routes>
            {local ? <Route path="/" element={<Library config={config} />} /> : <Route path="/" element={<MeetingsPage />} />}
            {local && <Route path="/recordings/:id" element={<RecordingPage />} />}
            {local && <Route path="/search" element={<SearchPage config={config} />} />}
            {local && <Route path="/capture" element={<CapturePage />} />}
            <Route path="/meetings" element={<MeetingsPage />} />
            <Route path="/meetings/:id" element={<MeetingPage />} />
            <Route path="/live" element={<LivePage />} />
            <Route path="/schedules" element={<SchedulesPage sourceKeys={config?.sources.map((source) => source.key) || []} />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<p>Nothing here. <NavLink to="/">Back to the start</NavLink></p>} />
          </Routes>
        )}
      </main>
    </>
  );
}

function SearchBox() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get('q') || '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim()) navigate(`/search?q=${encodeURIComponent(text.trim())}`);
  };
  return (
    <form className="topsearch" onSubmit={submit} role="search">
      <input type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder="Search all transcripts" aria-label="Search all transcripts" />
    </form>
  );
}
