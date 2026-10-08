import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in web/. While developing (`npm run dev`), Vite serves it and passes the API and the data folders
// through to the streamscribe server; `npm run build` puts it in web/dist, which the server serves itself.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4873',
      '/files': 'http://127.0.0.1:4873'
    }
  }
});
