import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COOP_VALUE,
  CSP_FALLBACK_REPORT_ONLY,
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
    '/mcp',
  ]) {
    assert.equal(isApiPath(path), true, path);
  }
  for (const path of [
    '/',
    '/sign-in',
    '/v1x',
    '/public',
    '/public/sitemap.xml',
    '/healthz',
    '/mcpx',
    '/mcp/x',
  ]) {
    assert.equal(isApiPath(path), false, path);
  }
});

test('first-owner setup at /public/setup goes to the API, and only that exact path', () => {
  assert.equal(isApiPath('/public/setup'), true);
  assert.equal(isApiPath('/public/setup?token=x'), true);
  for (const path of ['/public/setup/', '/public/setupx', '/public/setup/extra', '/setup']) {
    assert.equal(isApiPath(path), false, path);
  }
});

test('the AI connector OAuth discovery and authorization endpoints go to the API, exact paths only', () => {
  for (const path of [
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-authorization-server',
    '/oauth/authorize?client_id=x&state=y',
    '/oauth/register',
    '/oauth/revoke',
    '/oauth/token',
    '/openapi/ai.json',
    '/downloads/tmanage-mcp.tgz',
  ]) {
    assert.equal(isApiPath(path), true, path);
  }
  for (const path of [
    '/.well-known',
    '/.well-known/',
    '/.well-known/security.txt',
    '/.well-known/oauth-protected-resource/',
    '/.well-known/oauth-protected-resource/other',
    '/.well-known/oauth-authorization-serverx',
    '/oauth',
    '/oauth/',
    '/oauth/consent',
    '/oauth/authorizex',
    '/connect/oauth',
    '/openapi',
    '/openapi/ai.jsonx',
    '/openapi/other.json',
    '/downloads',
    '/downloads/other.tgz',
  ]) {
    assert.equal(isApiPath(path), false, path);
  }
});

test('HSTS with preload on every web response; COOP and the CSP fallback on HTML only', () => {
  const html = webSecurityHeaders({ 'content-type': 'text/html; charset=utf-8' });
  assert.equal(html['strict-transport-security'], HSTS_VALUE);
  assert.ok(Number(/max-age=(\d+)/.exec(HSTS_VALUE)[1]) >= 31_536_000);
  assert.match(HSTS_VALUE, /includeSubDomains; preload$/);
  assert.equal(html['cross-origin-opener-policy'], COOP_VALUE);
  assert.equal(html['content-security-policy-report-only'], CSP_FALLBACK_REPORT_ONLY);
  assert.doesNotMatch(CSP_FALLBACK_REPORT_ONLY, /unsafe-inline/);

  const js = webSecurityHeaders({ 'content-type': 'application/javascript' });
  assert.deepEqual(js, { 'strict-transport-security': HSTS_VALUE });
});

test("the web app's own nonce CSP (either header) and HSTS/COOP are kept, never overwritten", () => {
  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    const kept = webSecurityHeaders({
      'content-type': 'text/html',
      'strict-transport-security': 'max-age=63072000',
      'cross-origin-opener-policy': 'same-origin',
      [name]: "script-src 'nonce-abc'",
    });
    assert.deepEqual(kept, {}, name);
  }
});

test('the deep health check at /healthz/deep goes to the API; /healthz stays with the server', () => {
  assert.equal(isApiPath('/healthz/deep'), true);
  assert.equal(isApiPath('/healthz/deep?x=1'), true);
  for (const path of ['/healthz', '/healthz/', '/healthz/deeper', '/healthz/deep/x']) {
    assert.equal(isApiPath(path), false, path);
  }
});
