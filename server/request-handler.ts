import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendText } from './http.ts';

type Route = (request: IncomingMessage, response: ServerResponse, url: URL) => unknown;

export function requestHandler(handleApi: Route, handleFiles: Route, handleApp: Route) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    let url: URL;
    try {
      url = new URL(request.url || '/', 'http://localhost');
    } catch {
      sendText(response, 400, 'Invalid request target');
      return;
    }
    try {
      await (url.pathname.startsWith('/api/')
        ? handleApi(request, response, url)
        : url.pathname.startsWith('/files/')
          ? handleFiles(request, response, url)
          : handleApp(request, response, url));
    } catch {
      if (!response.headersSent) sendText(response, 500, 'Server error');
      else response.destroy();
    }
  };
}
