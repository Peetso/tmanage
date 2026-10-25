import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

import { readFileSync } from 'node:fs';

import {
  API_DEFAULT_CACHE_CONTROL,
  hasLocaleCookie,
  IMMUTABLE_CACHE_CONTROL,
  LOCALE_COOKIE,
  LOCALE_PAGE_CACHE_CONTROL,
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
    // The policy is untouched; only `Vary: Cookie` is added, as on every page (wave 6 E3).
    assert.deepEqual(webCacheHeaders('/acme/home', headers), { vary: 'Cookie' }, policy);
  }
});

test('the locale cookie name matches the one the web app writes', () => {
  const source = readFileSync(
    new URL('../web/src/lib/i18n/locale-cookie.ts', import.meta.url),
    'utf8',
  );
  assert.match(source, new RegExp(`LOCALE_COOKIE_NAME = '${LOCALE_COOKIE}'`));
});

test('every page varies by Cookie, keeping what Next already listed', () => {
  const html = { 'content-type': HTML, 'cache-control': NEXT_PRERENDERED };
  assert.equal(webCacheHeaders('/pricing', html).vary, 'Cookie');
  const rsc = {
    'content-type': 'text/x-component',
    vary: 'RSC, Next-Router-State-Tree, Next-Router-Prefetch',
  };
  assert.equal(
    webCacheHeaders('/pricing?_rsc=1', rsc).vary,
    'RSC, Next-Router-State-Tree, Next-Router-Prefetch, Cookie',
  );
  assert.equal(webCacheHeaders('/p', { ...html, vary: 'Accept, cookie' }).vary, 'Accept, cookie');
  // Assets and non-pages are left alone.
  assert.equal(webCacheHeaders('/_next/static/a.js', { 'content-type': HTML }).vary, undefined);
  assert.equal(webCacheHeaders('/logo.svg', { 'content-type': 'image/svg+xml' }).vary, undefined);
});

test('a page rendered for a saved locale never enters the shared cache', () => {
  const html = { 'content-type': HTML, 'cache-control': NEXT_PRERENDERED };
  const arabic = { cookie: `a=1; ${LOCALE_COOKIE}=ar-EG; b=2` };
  assert.equal(
    webCacheHeaders('/pricing', html, arabic)['cache-control'],
    LOCALE_PAGE_CACHE_CONTROL,
  );
  assert.equal(
    webCacheHeaders('/pricing', { 'content-type': HTML }, { cookie: `${LOCALE_COOKIE}=en-US` })[
      'cache-control'
    ],
    LOCALE_PAGE_CACHE_CONTROL,
  );
  // Without the cookie the short shared policy stands (the response still varies by Cookie).
  assert.equal(
    webCacheHeaders('/pricing', html, { cookie: 'other=1' })['cache-control'],
    PAGE_CACHE_CONTROL,
  );
  assert.equal(webCacheHeaders('/pricing', html)['cache-control'], PAGE_CACHE_CONTROL);
  // A private page keeps its own policy; an asset is never touched by the cookie.
  const dynamic = { 'content-type': HTML, 'cache-control': 'private, no-cache, no-store' };
  assert.equal(webCacheHeaders('/pricing', dynamic, arabic)['cache-control'], undefined);
  assert.equal(
    webCacheHeaders('/_next/static/a.js', { 'content-type': 'application/javascript' }, arabic)[
      'cache-control'
    ],
    IMMUTABLE_CACHE_CONTROL,
  );
});

test('an Arabic public page (locale in the URL) keeps the short shared policy like its English twin', () => {
  for (const path of ['/ar', '/ar/pricing', '/ar/features/communication']) {
    const upstream = { 'content-type': HTML, 'cache-control': NEXT_PRERENDERED };
    assert.deepEqual(webCacheHeaders(path, upstream), {
      'cache-control': PAGE_CACHE_CONTROL,
      vary: 'Cookie',
    });
    // The cookie guard still applies to /ar exactly as to every other page.
    assert.equal(
      webCacheHeaders(path, upstream, { cookie: `${LOCALE_COOKIE}=ar-EG` })['cache-control'],
      LOCALE_PAGE_CACHE_CONTROL,
    );
  }
});

test('hasLocaleCookie matches the cookie name exactly', () => {
  assert.equal(hasLocaleCookie(`${LOCALE_COOKIE}=ar-EG`), true);
  assert.equal(hasLocaleCookie(` x=1;  ${LOCALE_COOKIE}=en-US`), true);
  assert.equal(hasLocaleCookie(`x${LOCALE_COOKIE}=ar-EG; ${LOCALE_COOKIE}x=1`), false);
  assert.equal(hasLocaleCookie(undefined), false);
  assert.equal(hasLocaleCookie(''), false);
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
