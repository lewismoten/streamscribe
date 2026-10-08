import http from 'node:http';
import { db, scan } from './context.ts';
import { sendText } from './http.ts';
import { handleApi } from './routes/api.ts';
import { handleFiles } from './routes/files.ts';
import { handleApp } from './routes/app.ts';

// streamscribe's web server: the library API (/api), every source's data folder (/files/<source>/...: video, images,
// and the review pages, whose saves go to the database), and the web app (web/dist, built with `npm run build`).
//   npm start [-- --port 4873] [--host 127.0.0.1]
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => (args.includes(name) ? String(args[args.indexOf(name) + 1]) : fallback);
const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '4873'));

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const handler = url.pathname.startsWith('/api/') ? handleApi(request, response, url)
    : url.pathname.startsWith('/files/') ? handleFiles(request, response, url)
      : Promise.resolve(handleApp(request, response, url));
  handler.catch((error) => {
    console.error(error);
    if (!response.headersSent) sendText(response, 500, `Server error: ${error.message}`);
  });
});

await scan();
const count = (db.prepare('SELECT count(*) AS n FROM recordings WHERE missing = 0').get() as { n: number }).n;
// New captures, transcripts, and files changed by the scripts are picked up every half minute.
setInterval(scan, 30000).unref();
server.listen(port, host, () => {
  console.log(`streamscribe at http://${host}:${port}/ (${count} recordings)`);
});
