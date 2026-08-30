import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A static file server for `storybook-static`, ~40 lines, zero dependencies.
 *
 * It exists because the visual-regression harness needs the built Storybook over HTTP —
 * `file://` breaks the iframe's relative asset fetches — and installing a static-server
 * package for one directory would be a dependency doing less work than this file.
 * Playwright starts and stops it via the `webServer` block in `playwright.config.ts`.
 */

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'storybook-static');
const port = Number(process.env['VR_PORT'] ?? 6007);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    // `normalize` plus the prefix check keeps `..` inside the served directory.
    const file = normalize(join(root, decodeURIComponent(pathname)));
    if (!file.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type }).end(body);
  } catch {
    response.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`storybook-static on http://127.0.0.1:${port}`);
});
