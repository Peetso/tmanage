import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { webChildHost } from './web-transport.mjs';

// NOTFOUND500 (live 2026-11-17): behind Hostinger every unknown page answered 500. The web
// child's proxy rewrites to the not-found page (and to the Markdown twins); Next keeps a rewrite
// inside the server only when it has the same origin as the URL the server was started on, and
// otherwise fetches it — here `https://localhost:<port>`, TLS against a plain-http port.

const require = createRequire(import.meta.url);
const { getRelativeURL } = require('next/dist/shared/lib/router/utils/relativize-url.js');

const SOCKET = { kind: 'socket', path: '/home/u/app/.web/web.sock' };
const PORT = 3001;

/** What Next 16 does with a proxy rewrite: a relative result is internal, absolute is a fetch. */
function rewriteTarget(host, forwardedProto) {
  // The URL the proxy is handed (`initProtocol://localhost:port`, next-server runMiddleware) …
  const proxyUrl = `${forwardedProto}://localhost:${PORT}/no-such-page`;
  // … and the one the router compares the rewrite with (`protocol://<-H>:port`, resolve-routes).
  const startUrl = `${forwardedProto}://${host}:${PORT}/no-such-page`;
  return getRelativeURL(new URL('/_not-found', proxyUrl).href, startUrl);
}

test('a proxy rewrite stays inside the web child behind an https front (socket transport)', () => {
  const host = webChildHost(SOCKET);
  assert.equal(rewriteTarget(host, 'https'), '/_not-found');
  assert.equal(rewriteTarget(host, 'http'), '/_not-found');
});

test('the old -H 127.0.0.1 turned the rewrite into a fetch of https://localhost', () => {
  assert.equal(rewriteTarget('127.0.0.1', 'https'), `https://localhost:${PORT}/_not-found`);
});

test('server.mjs starts the web child with webChildHost, never a fixed host', () => {
  const source = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /'-H', webChildHost\(transport\)\]/);
  assert.doesNotMatch(source, /'-H', '127\.0\.0\.1'/);
});

test('loopback TCP (local development) keeps the address webTarget connects to', () => {
  assert.equal(webChildHost({ kind: 'tcp', port: PORT }), '127.0.0.1');
});
