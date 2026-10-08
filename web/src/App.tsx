import { useEffect, useState, type FormEvent } from 'react';
import { NavLink, Route, Routes, useNavigate, useSearchParams } from 'react-router';
import { api, type Config } from './api.ts';
import { setTimeZone } from './format.ts';
import Library from './pages/Library.tsx';
import RecordingPage from './pages/RecordingPage.tsx';
import SearchPage from './pages/SearchPage.tsx';
import CapturePage from './pages/CapturePage.tsx';

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.config().then((value) => { setTimeZone(value.timeZone); setConfig(value); }).catch((reason: Error) => setError(reason.message));
  }, []);

  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">🎙 streamscribe</NavLink>
        <nav>
          <NavLink to="/" end>Library</NavLink>
          <NavLink to="/search">Search</NavLink>
          <NavLink to="/capture">Capture</NavLink>
        </nav>
        <SearchBox />
      </header>
      <main className="page">
        {error && <p className="error">Can't reach the streamscribe server: {error}</p>}
        {config && (
          <Routes>
            <Route path="/" element={<Library config={config} />} />
            <Route path="/recordings/:id" element={<RecordingPage />} />
            <Route path="/search" element={<SearchPage config={config} />} />
            <Route path="/capture" element={<CapturePage />} />
            <Route path="*" element={<p>Nothing here. <NavLink to="/">Back to the library</NavLink></p>} />
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
