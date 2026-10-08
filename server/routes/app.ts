import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { REPO_ROOT } from '../../src/config/paths.js';
import { sendFile, sendText } from '../http.ts';

// The web app, built into web/dist with `npm run build`; any address that isn't a file is a page of the app.
const webDist = path.join(REPO_ROOT, 'web', 'dist');

export function handleApp(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  if (!fs.existsSync(webDist)) {
    return sendText(
      response,
      404,
      'The web app is not built yet: run `npm run build`, or `npm run dev` while working on it.'
    );
  }
  const candidate = path.resolve(webDist, '.' + decodeURIComponent(url.pathname));
  if (candidate.startsWith(webDist + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return sendFile(request, response, candidate, fs.statSync(candidate));
  }
  // Any other address is a page of the app (it routes in the browser).
  const index = path.join(webDist, 'index.html');
  return sendFile(request, response, index, fs.statSync(index));
}
