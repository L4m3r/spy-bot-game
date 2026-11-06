import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../prototype/miniapp/', import.meta.url);
const files = new Map([
  ['/', ['index.html', 'text/html']], ['/index.html', ['index.html', 'text/html']],
  ['/app.html', ['app.html', 'text/html']], ['/app.css', ['app.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']], ['/preview.js', ['preview.js', 'text/javascript']],
  ['/invites.js', ['invites.js', 'text/javascript']],
]);
const port = Number(process.env.PORT || 8793);
const server = createServer(async (request, response) => {
  const entry = files.get(new URL(request.url, 'http://localhost').pathname);
  if (!entry || !['GET', 'HEAD'].includes(request.method)) { response.writeHead(404); response.end('Not found'); return; }
  try {
    const body = await readFile(fileURLToPath(new URL(entry[0], root)));
    response.writeHead(200, { 'content-type': entry[1] + '; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(500); response.end('Preview is unavailable'); }
});
server.listen(port, '127.0.0.1', () => console.log(`Mini App prototype: http://127.0.0.1:${port}`));
process.on('SIGINT', () => server.close());
