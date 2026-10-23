import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

import {
  API_DEFAULT_CACHE_CONTROL,
  IMMUTABLE_CACHE_CONTROL,
  PAGE_CACHE_CONTROL,
  webCacheControl,
  webCacheHeaders,
} from './cache-headers.mjs';
import { createPublicHandler } from './web-transport.mjs';

// What `next start` sends for a prerendered page (the header hcdn kept for a year, live M1).
const NEXT_PRERENDERED = 's-maxage=31536000';
const HTML = 'text/html; charset=utf-8';

test('a prerendered HTML page never keeps the one-year s-maxage', () => {
  for (const path of ['/', '/contact', '/customers?x=1', '/features/communication']) {
    const value = webCacheControl(path, {
      'content-type': HTML,
      'cache-control': NEXT_PRERENDERED,
    });
    assert.equal(value, PAGE_CACHE_CONTROL, path);
  }
  assert.match(PAGE_CACHE_CONTROL, /max-age=0/);
  assert.match(PAGE_CACHE_CONTROL, /s-maxage=60(,|$)/);
  assert.doesNotMatch(PAGE_CACHE_CONTROL, /31536000|immutable/);
});

test('an HTML page with no cache-control, or the RSC payload of a page, gets the short policy', () => {
  assert.equal(webCacheControl('/pricing', { 'content-type': HTML }), PAGE_CACHE_CONTROL);
  assert.equal(
    webCacheControl('/pricing?_rsc=abc', {
      'content-type': 'text/x-component',
      'cache-control': 's-maxage=31536000, stale-while-revalidate',
    }),
    PAGE_CACHE_CONTROL,
  );
});

test('an authenticated (private / no-store) page keeps its own policy', () => {
  for (const policy of [
    'private, no-cache, no-store, max-age=0, must-revalidate',
    'no-store',
    'private, max-age=0',
  ]) {
    const headers = { 'content-type': HTML, 'cache-control': policy };
    assert.equal(webCacheControl('/acme/home', headers), undefined, policy);
    assert.deepEqual(webCacheHeaders('/acme/home', headers), {}, policy);
  }
});

test('hashed /_next/static assets keep the immutable year', () => {
  const asset = '/_next/static/chunks/app-3f2a9c.js';
  assert.equal(
    webCacheControl(asset, {
      'content-type': 'application/javascript',
      'cache-control': IMMUTABLE_CACHE_CONTROL,
    }),
    undefined,
  );
  assert.equal(
    webCacheControl(asset, { 'content-type': 'application/javascript' }),
    IMMUTABLE_CACHE_CONTROL,
  );
});

test('a non-page response is capped only when a shared cache could keep it past a minute', () => {
  assert.equal(
    webCacheControl('/robots.txt', {
      'content-type': 'text/plain',
      'cache-control': NEXT_PRERENDERED,
    }),
    PAGE_CACHE_CONTROL,
  );
  // A 304 has no content-type but still carries the upstream policy.
  assert.equal(
    webCacheControl('/contact', { 'cache-control': NEXT_PRERENDERED }),
    PAGE_CACHE_CONTROL,
  );
  assert.equal(
    webCacheControl('/favicon.ico', {
      'content-type': 'image/x-icon',
      'cache-control': 'public, max-age=0',
    }),
    undefined,
  );
  assert.equal(webCacheControl('/logo.svg', { 'content-type': 'image/svg+xml' }), undefined);
});

function get(server, path) {
  const { port } = server.address();
  return new Promise((done, fail) => {
    request({ host: '127.0.0.1', port, path }, (res) => {
      res.resume();
      res.on('end', () => done({ status: res.statusCode, headers: res.headers }));
    })
      .on('error', fail)
      .end();
  });
}

test('API responses default to no-store, and a route that sets its own policy keeps it', async () => {
  // The fake Fastify does what Fastify does: its headers go through writeHead, which overrides
  // anything set with setHeader before routing.
  const routing = (req, res) => {
    if (req.url === '/v1/files/1/download') {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'private, no-store',
      });
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
    }
    res.end('{}');
  };
  const state = { ready: { fastify: { routing } } };
  const server = createServer(createPublicHandler(state, (_req, res) => res.end('web')));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const json = await get(server, '/v1/auth/session');
    assert.equal(json.headers['cache-control'], API_DEFAULT_CACHE_CONTROL);
    const file = await get(server, '/v1/files/1/download');
    assert.equal(file.headers['cache-control'], 'private, no-store');
    const site = await get(server, '/public/site/maintenance');
    assert.equal(site.headers['cache-control'], API_DEFAULT_CACHE_CONTROL);
  } finally {
    server.close();
  }
});
