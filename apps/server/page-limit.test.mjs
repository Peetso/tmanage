import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createReportLimiter } from './csp-report.mjs';
import { createPageLimiter, isLimitedPagePath } from './page-limit.mjs';

test('the server-rendered account pages are limited, the rest of the site is not', () => {
  for (const path of [
    '/sign-in',
    '/sign-in/verify?token=x',
    '/ar/sign-in',
    '/sign-up',
    '/ar/sign-up',
    '/recover',
    '/confirm-email/TOKEN',
    '/setup',
    '/organizations',
    '/onboarding/organization',
    '/sessions',
    '/platform/audit',
    '/portal-sign-in',
  ]) {
    assert.equal(isLimitedPagePath(path), true, path);
  }
  for (const path of ['/', '/pricing', '/northstar/projects', '/sign-inx', '/_next/static/a.js']) {
    assert.equal(isLimitedPagePath(path), false, path);
  }
});

async function serve(limit) {
  const server = createServer((req, res) => {
    if (!limit(req, res)) res.end('web');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test('over the burst a sign-in page answers 429 with a short page; other pages still pass', async () => {
  let now = 0;
  const limit = createPageLimiter({
    limiter: createReportLimiter({ burst: 3, perMinute: 60, now: () => now }),
  });
  const { server, base } = await serve(limit);
  try {
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await (await fetch(`${base}/sign-in`)).text(), 'web');
    }
    const refused = await fetch(`${base}/sign-in`);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers.get('retry-after'), '60');
    assert.equal(refused.headers.get('cache-control'), 'no-store');
    assert.match(refused.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(await refused.text(), /Please wait a minute/);
    // Pages outside the list are not counted or refused.
    assert.equal((await fetch(`${base}/pricing`)).status, 200);
    // A second later one token is back (60 a minute).
    now += 1_000;
    assert.equal((await fetch(`${base}/sign-up`)).status, 200);
  } finally {
    server.close();
  }
});

test('the defaults let a person through: 120 page loads in a row pass', async () => {
  const limit = createPageLimiter();
  const { server, base } = await serve(limit);
  try {
    for (let i = 0; i < 120; i += 1) {
      assert.equal((await fetch(`${base}/sign-in`)).status, 200);
    }
    assert.equal((await fetch(`${base}/sign-in`)).status, 429);
  } finally {
    server.close();
  }
});
