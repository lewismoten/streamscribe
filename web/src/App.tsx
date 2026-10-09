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
import AccountPage from './pages/AccountPage.tsx';
import AccountsPage from './pages/AccountsPage.tsx';
import PeoplePage from './people/PeoplePage.tsx';
import PersonPage from './people/PersonPage.tsx';
import BodiesPage from './civic/BodiesPage.tsx';
import BodyPage from './civic/BodyPage.tsx';
import ElectionsPage from './civic/ElectionsPage.tsx';
import ElectionPage from './civic/ElectionPage.tsx';
import ReligionPage from './religion/ReligionPage.tsx';
import VideosPage from './videos/VideosPage.tsx';
import RoomsPage from './rooms/RoomsPage.tsx';
import LocationsPage from './locations/LocationsPage.tsx';
import NotificationsBell from './notifications/NotificationsBell.tsx';
import NotificationsPage from './notifications/NotificationsPage.tsx';
import LocationPage from './locations/LocationPage.tsx';
import RoomPage from './rooms/RoomPage.tsx';
import VideoPage from './videos/VideoPage.tsx';
import AgentsPage from './pages/AgentsPage.tsx';
import NavMenu from './NavMenu.tsx';
import TopicsPage from './annotations/TopicsPage.tsx';
import TopicPage from './annotations/TopicPage.tsx';
import QuotesPage from './annotations/QuotesPage.tsx';
import LawsPage from './annotations/LawsPage.tsx';
import LawPage from './annotations/LawPage.tsx';
import TasksPage from './prompts/TasksPage.tsx';
import { MapPage, MapsPage } from './maps/MapsPage.tsx';
import ExplorePage from './maps/ExplorePage.tsx';
import SourcesPage from './sources/SourcesPage.tsx';
import SetupPage from './pages/SetupPage.tsx';
import { PublishedList, PublicationPage } from './pages/PublishedPage.tsx';
import { can, refreshAccount, useAccount } from './data/account.ts';
import { setPreviewing } from './data/preview.ts';
import { settleHubAddress } from './data/hub.ts';

// Two ways to run: served by a recorder's streamscribe server (its library of local recordings, search, and capture,
// plus the hub pages), or as a static site such as GitHub Pages or the hub's own server (the hub pages only, kept in
// this browser and synced with the hub). It's an independent archive: what's published (notes, transcripts, clips)
// is for everyone; meetings themselves are private, for groups that may see them (Meetings, Live, Agents). Signing
// in (Account) allows what the person's group may do.
const STATIC_BUILD = import.meta.env.VITE_ROUTER === 'hash';

export default function App() {
  const [config, setConfig] = useState<Config | null>(null);
  const [mode, setMode] = useState<'checking' | 'local' | 'static'>(STATIC_BUILD ? 'static' : 'checking');
  const account = useAccount();
  useEffect(() => {
    // A hub given by its website's address: found once, then synced with.
    settleHubAddress().then((changed) => {
      if (changed) refreshAccount();
    });
    refreshAccount();
    // A static site's build (hash routes: bin/deploy-hub.sh, GitHub Pages) has no local server to ask; a local build
    // asks it (/api/config), and is static if nothing answers.
    if (!STATIC_BUILD)
      api
        .config()
        .then((value) => {
          setTimeZone(value.timeZone);
          setConfig(value);
          setMode('local');
        })
        .catch(() => setMode('static'));
    startSyncing(30);
  }, []);
  const local = mode === 'local' && config;
  // Meetings are private (view.meetings); what's published is for everyone.
  const viewer = can('view.meetings', account);

  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">
          <img src={`${import.meta.env.BASE_URL}favicon.ico`} alt="" />
          Stream Scribe
        </NavLink>
        <nav>
          {local && (
            <NavLink to="/" end>
              Library
            </NavLink>
          )}
          {local && <NavLink to="/search">Search</NavLink>}
          {local && <NavLink to="/capture">Capture</NavLink>}
          <NavLink to={local ? '/published' : '/'} end={!local}>
            Published
          </NavLink>
          {(local || viewer) && <NavLink to="/meetings">Meetings</NavLink>}
          {viewer && <NavLink to="/videos">Videos</NavLink>}
          {viewer && <NavLink to="/live">Live</NavLink>}
          <NavLink to="/schedules">Schedules</NavLink>
          <NavMenu label="Public bodies" paths={['/people', '/bodies', '/elections', '/rooms']}>
            <NavLink to="/people">People</NavLink>
            <NavLink to="/bodies">Bodies</NavLink>
            <NavLink to="/elections">Elections</NavLink>
            <NavLink to="/rooms">Rooms</NavLink>
          </NavMenu>
          <NavMenu
            label="Research"
            paths={['/topics', '/quotes', '/laws', '/locations', '/maps', '/religion', '/tasks']}
          >
            {viewer && <NavLink to="/topics">Topics</NavLink>}
            {viewer && <NavLink to="/quotes">Quotes</NavLink>}
            <NavLink to="/laws">Laws</NavLink>
            <NavLink to="/locations">Locations</NavLink>
            <NavLink to="/maps">Maps</NavLink>
            {viewer && <NavLink to="/tasks">Tasks</NavLink>}
            {/* An internal reference: never for the public. */}
            {viewer && can('edit.bodies', account) && <NavLink to="/religion">Religion</NavLink>}
          </NavMenu>
          <NavMenu label="Manage" paths={['/agents', '/sources', '/accounts', '/settings']}>
            {viewer && <NavLink to="/agents">Agents</NavLink>}
            {can('edit.sources', account) && <NavLink to="/sources">Sources</NavLink>}
            {(can('manage.users', account) || can('review', account)) && <NavLink to="/accounts">Accounts</NavLink>}
            <NavLink to="/settings">Settings</NavLink>
          </NavMenu>
          <NavLink to="/account" className="account-link">
            {account.user ? `👤 ${account.user.displayName || account.user.username}` : 'Sign in'}
          </NavLink>
        </nav>
        {local && <SearchBox />}
        {viewer && <NotificationsBell />}
      </header>
      <main className="page">
        {/* A new hub with no accounts yet: its first visitor makes the admin. */}
        {account.needsSetup && <SetupPage />}
        {mode !== 'checking' && !account.needsSetup && (
          <Routes>
            {local ? (
              <Route path="/" element={<Library config={config} />} />
            ) : (
              <Route path="/" element={<PublishedList />} />
            )}
            <Route path="/published" element={<PublishedList />} />
            <Route path="/published/:id" element={<PublicationPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            {local && <Route path="/recordings/:id" element={<RecordingPage />} />}
            {local && <Route path="/search" element={<SearchPage config={config} />} />}
            {local && <Route path="/capture" element={<CapturePage />} />}
            <Route path="/meetings" element={<MeetingsPage />} />
            <Route path="/meetings/:id" element={<MeetingPage />} />
            <Route path="/live" element={<LivePage />} />
            <Route
              path="/schedules"
              element={<SchedulesPage sourceKeys={config?.sources.map((source) => source.key) || []} />}
            />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/accounts" element={<AccountsPage />} />
            <Route path="/people" element={<PeoplePage />} />
            <Route path="/people/:source/:id" element={<PersonPage />} />
            <Route path="/bodies" element={<BodiesPage />} />
            <Route path="/bodies/:id" element={<BodyPage />} />
            <Route path="/elections" element={<ElectionsPage />} />
            <Route path="/elections/:id" element={<ElectionPage />} />
            <Route path="/religion" element={<ReligionPage />} />
            <Route path="/notifications" element={<NotificationsPage />} />
            <Route path="/locations" element={<LocationsPage />} />
            <Route path="/locations/:id" element={<LocationPage />} />
            <Route path="/rooms" element={<RoomsPage />} />
            <Route path="/topics" element={<TopicsPage />} />
            <Route path="/topics/:id" element={<TopicPage />} />
            <Route path="/quotes" element={<QuotesPage />} />
            <Route path="/laws" element={<LawsPage />} />
            <Route path="/laws/:id" element={<LawPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/maps" element={<MapsPage />} />
            <Route path="/maps/explore" element={<ExplorePage />} />
            <Route path="/maps/:id" element={<MapPage />} />
            <Route path="/rooms/:id" element={<RoomPage />} />
            <Route path="/videos" element={<VideosPage />} />
            <Route path="/videos/:id" element={<VideoPage />} />
            <Route
              path="*"
              element={
                <p>
                  Nothing here. <NavLink to="/">Back to the start</NavLink>
                </p>
              }
            />
          </Routes>
        )}
      </main>
      {account.admin && (
        <button
          type="button"
          className={`preview-toggle${account.previewing ? ' on' : ''}`}
          aria-pressed={account.previewing}
          aria-label={account.previewing ? 'Back to my view' : 'See what the public sees'}
          title={account.previewing ? 'Back to my view' : 'See what the public sees'}
          onClick={() => setPreviewing(!account.previewing)}
        >
          <span aria-hidden="true">{account.previewing ? '🙈' : '👁️'}</span>
        </button>
      )}
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
    <search className="topsearch">
      <form onSubmit={submit}>
        <input
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Search all transcripts"
          aria-label="Search all transcripts"
        />
      </form>
    </search>
  );
}
