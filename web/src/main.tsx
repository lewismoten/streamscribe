import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router';
import App from './App.tsx';
// The stylesheets, by area; their order is the cascade order (later rules win).
import './styles/base.css';
import './styles/layout.css';
import './styles/recording.css';
import './styles/hub-pages.css';
import './styles/accounts.css';
import './styles/meeting-page.css';
import './styles/publishing.css';
import './styles/agents.css';
import './styles/official-sources.css';
import './styles/civic.css';
import './styles/videos.css';

// A static host (GitHub Pages) can't send every address to index.html, so that build keeps the page in the # part.
const Router = import.meta.env.VITE_ROUTER === 'hash' ? HashRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Router>
      <App />
    </Router>
  </StrictMode>
);
