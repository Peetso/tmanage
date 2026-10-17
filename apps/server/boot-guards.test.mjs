import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CSP_REPORT_ONLY,
  HSTS_VALUE,
  isApiPath,
  resolveNodeEnv,
  webSecurityHeaders,
} from './boot-guards.mjs';

test('a missing NODE_ENV is forced to production, never left to default to development', () => {
  assert.equal(resolveNodeEnv(undefined).nodeEnv, 'production');
  assert.equal(resolveNodeEnv('').nodeEnv, 'production');
  assert.match(resolveNodeEnv(undefined).note, /not set/);
  assert.deepEqual(resolveNodeEnv('production'), { nodeEnv: 'production' });
});

test('any NODE_ENV other than production refuses to boot', () => {
  for (const value of ['development', 'test', 'Production', 'prod']) {
    const result = resolveNodeEnv(value);
    assert.equal(result.nodeEnv, undefined, value);
    assert.match(result.error, /only runs in production/);
  }
});

test('the API answers /v1 and the public site routes; the rest is the web app', () => {
  for (const path of [
    '/v1',
    '/v1/auth/password',
    '/public/site/contact',
    '/public/site/maintenance?x=1',
  ]) {
    assert.equal(isApiPath(path), true, path);
  }
  for (const path of ['/', '/sign-in', '/v1x', '/public', '/public/sitemap.xml', '/healthz']) {
    assert.equal(isApiPath(path), false, path);
  }
});

test('HSTS on every web response, the report-only CSP on HTML only', () => {
  const html = webSecurityHeaders({ 'content-type': 'text/html; charset=utf-8' });
  assert.equal(html['strict-transport-security'], HSTS_VALUE);
  assert.match(HSTS_VALUE, /max-age=(\d+)/);
  assert.ok(Number(/max-age=(\d+)/.exec(HSTS_VALUE)[1]) >= 31_536_000);
  assert.match(HSTS_VALUE, /includeSubDomains/);
  assert.equal(html['content-security-policy-report-only'], CSP_REPORT_ONLY);

  const js = webSecurityHeaders({ 'content-type': 'application/javascript' });
  assert.equal(js['strict-transport-security'], HSTS_VALUE);
  assert.equal(js['content-security-policy-report-only'], undefined);

  const kept = webSecurityHeaders({
    'content-type': 'text/html',
    'strict-transport-security': 'max-age=63072000',
    'content-security-policy': "default-src 'self'",
  });
  assert.deepEqual(kept, {});
});
