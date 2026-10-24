import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  READ_P95_MS,
  SEARCH_P95_MS,
  buildRoutes,
  cookieHeaderFrom,
  evaluate,
  formatReport,
  isLocalTarget,
  percentile,
  summarise,
} from './load-plan.mjs';

const ok = (ms) => ({ ms, ok: true, status: 200 });
const fail = (ms, status = 500) => ({ ms, ok: false, status });

test('percentile is nearest-rank over a sorted array', () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(percentile(hundred, 50), 50);
  assert.equal(percentile(hundred, 95), 95);
  assert.equal(percentile(hundred, 99), 99);
  assert.equal(percentile(hundred, 100), 100);
  assert.equal(percentile(hundred, 0), 1);
  assert.equal(percentile([7], 99), 7);
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 95), 40);
  assert.equal(percentile([], 95), null);
  assert.throws(() => percentile([1], 101), /out of range/);
});

test('summarise sorts, counts errors and statuses, and computes throughput', () => {
  const samples = [
    ok(30),
    ok(10),
    fail(50, 503),
    ok(20),
    { ms: 10_000, ok: false, status: 'timeout' },
  ];
  const s = summarise(samples, 2000);
  assert.equal(s.count, 5);
  assert.equal(s.errors, 2);
  assert.equal(s.errorRate, 0.4);
  assert.equal(s.p50, 30);
  assert.equal(s.p95, 10_000); // a slow failure counts against p95
  assert.equal(s.max, 10_000);
  assert.equal(s.rps, 2.5);
  assert.deepEqual(s.statuses, { 200: 3, 503: 1, timeout: 1 });
});

test('summarise of no samples has null percentiles and zero rates', () => {
  const s = summarise([], 0);
  assert.equal(s.count, 0);
  assert.equal(s.p95, null);
  assert.equal(s.errorRate, 0);
  assert.equal(s.rps, 0);
});

test('evaluate passes under target and misses on p95, error rate and an empty run', () => {
  const target = { p95Ms: 300, maxErrorRate: 0.01 };
  const fast = summarise(
    Array.from({ length: 100 }, (_, i) => ok(i + 1)),
    1000,
  );
  assert.deepEqual(evaluate(fast, target), { pass: true, misses: [] });

  const slow = summarise(
    Array.from({ length: 100 }, (_, i) => ok(i < 94 ? 100 : 400)),
    1000,
  );
  const slowVerdict = evaluate(slow, target);
  assert.equal(slowVerdict.pass, false);
  assert.match(slowVerdict.misses[0], /p95 400 ms is over the 300 ms target/);

  // Exactly at the target is a pass; the plan says "<300" but timing noise makes == meaningless.
  const edge = summarise([ok(300)], 1000);
  assert.equal(evaluate(edge, target).pass, true);

  const flaky = summarise([...Array.from({ length: 98 }, () => ok(5)), fail(5), fail(5)], 1000);
  const flakyVerdict = evaluate(flaky, target);
  assert.equal(flakyVerdict.pass, false);
  assert.match(flakyVerdict.misses[0], /2 of 100 requests failed \(2\.0%, limit 1\.0%\)/);

  assert.deepEqual(evaluate(summarise([], 0), target), {
    pass: false,
    misses: ['no requests completed'],
  });
});

test('buildRoutes uses the plan targets and a tenant-scoped path for every route', () => {
  const routes = buildRoutes({
    org: 'northstar-studio',
    projectId: 'p1',
    workItemId: 'w1',
    search: 'brand kit',
  });
  const byName = Object.fromEntries(routes.map((r) => [r.name, r]));
  assert.equal(byName['home-my-day'].p95Ms, READ_P95_MS);
  assert.equal(byName['search'].p95Ms, SEARCH_P95_MS);
  assert.match(byName['search'].path, /q=brand%20kit/);
  assert.match(byName['work-list'].path, /projectId=p1/);
  assert.deepEqual(byName['recent-item-write'].body, { objectType: 'work', objectId: 'w1' });
  for (const r of routes) assert.ok(r.path.startsWith('/v1/organizations/northstar-studio/'));
  assert.ok(routes.some((r) => r.kind === 'write') && routes.some((r) => r.kind === 'read'));

  const bare = buildRoutes({ org: 'x', search: 'y' });
  assert.equal(bare.find((r) => r.kind === 'write').body.objectType, 'meeting');
  assert.doesNotMatch(bare.find((r) => r.name === 'work-list').path, /projectId/);
});

test('isLocalTarget accepts only local development hosts', () => {
  for (const url of [
    'http://localhost:3001',
    'http://127.0.0.1:3001',
    'http://127.4.5.6',
    'http://[::1]:3001',
    'http://api.tmanage.localhost',
    'https://tmanage.test',
  ]) {
    assert.equal(isLocalTarget(url), true, url);
  }
  for (const url of [
    'https://tmanage.peetrix.com',
    'http://localhost.evil.com',
    'http://10.0.0.5:3001',
    'http://127.0.0.1.nip.io',
    'not a url',
  ]) {
    assert.equal(isLocalTarget(url), false, url);
  }
});

test('cookieHeaderFrom keeps root-path cookies and drops the path-scoped refresh cookie', () => {
  const header = cookieHeaderFrom([
    'tmanage_session=abc; Path=/; HttpOnly; SameSite=Lax',
    'tmanage_session_refresh=r; Path=/v1/sessions; HttpOnly; SameSite=Strict',
    'tmanage_session_csrf=c; Path=/; SameSite=Lax',
    'garbage',
  ]);
  assert.equal(header, 'tmanage_session=abc; tmanage_session_csrf=c');
});

test('formatReport marks each route and says how many missed', () => {
  const [route] = buildRoutes({ org: 'o', search: 's' });
  const summary = summarise([ok(10), ok(20)], 1000);
  const settings = { api: 'http://localhost:3001', connections: 2, durationS: 1, users: 1 };
  const passing = formatReport([{ route, summary, verdict: { pass: true, misses: [] } }], settings);
  assert.match(passing, /home-my-day .* PASS/);
  assert.match(passing, /All routes met their targets\./);

  const missing = formatReport(
    [
      {
        route,
        summary,
        verdict: { pass: false, misses: ['p95 900 ms is over the 300 ms target'] },
      },
    ],
    settings,
  );
  assert.match(missing, /MISS/);
  assert.match(missing, /- p95 900 ms is over the 300 ms target/);
  assert.match(missing, /1 route\(s\) missed their targets\./);
});
