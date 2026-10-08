import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in web/. While developing (`npm run dev`), Vite serves it and passes the API and the data folders
// through to the streamscribe server; `npm run build` puts it in web/dist, which the server serves itself.
// For a static host, build with VITE_BASE (the site's folder, such as /streamscribe/) and VITE_ROUTER=hash (see
// .github/workflows/pages.yml). The app also uses the shared sync code in src/sync, outside web/.
export default defineConfig({
  root: 'web',
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': 'http://127.0.0.1:4873',
      '/files': 'http://127.0.0.1:4873'
    }
  }
});
