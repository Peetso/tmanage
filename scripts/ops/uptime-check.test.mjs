import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ALERT_WINDOW_MS,
  decide,
  failuresFrom,
  parseAlertEmails,
  renderMail,
} from './uptime-check.mjs';

test('healthy probes produce no failure', () => {
  assert.deepEqual(failuresFrom({ healthz: { status: 200 }, deep: { status: 200, body: {} } }), []);
});

test('a down site and a failing deep check are two kinds, naming the failing checks', () => {
  const failures = failuresFrom({
    healthz: { error: 'TimeoutError' },
    deep: { status: 503, body: { checks: { database: 'fail', migrations: 'fail', worker: 'ok' } } },
  });
  assert.deepEqual(
    failures.map((f) => f.kind),
    ['uptime_down:healthz', 'uptime_fail:deep'],
  );
  assert.equal(failures[1].detail, 'HTTP 503 — failing: database, migrations');
});

test('mails once per kind per 15 minutes, counts the held passes, and says when it recovered', () => {
  const failure = [{ kind: 'uptime_fail:deep', detail: 'HTTP 503' }];
  const first = decide({}, failure, 0);
  assert.equal(first.send.length, 1);
  const held = decide(first.next, failure, ALERT_WINDOW_MS - 1);
  assert.equal(held.send.length, 0);
  assert.equal(held.next['uptime_fail:deep'].held, 1);
  const again = decide(held.next, failure, ALERT_WINDOW_MS);
  assert.equal(again.send.length, 1);
  assert.equal(again.send[0].held, 1);
  const recovered = decide(again.next, [], ALERT_WINDOW_MS + 1);
  assert.deepEqual(
    recovered.send.map((s) => [s.kind, s.recovered]),
    [['uptime_fail:deep', true]],
  );
  assert.deepEqual(recovered.next, {});
});

test('the mail names the site and kind, and ALERT_EMAILS parses like the app', () => {
  const mail = renderMail(
    { kind: 'uptime_down:healthz', detail: 'HTTP 502', held: 0, recovered: false },
    'https://tmanage.example.com',
    new Date('2026-10-25T00:00:00.000Z'),
  );
  assert.equal(mail.subject, '[TManage alert] TManage is not healthy: uptime_down:healthz');
  assert.match(mail.text, /Site: https:\/\/tmanage\.example\.com/);
  assert.deepEqual(parseAlertEmails('A@b.co, a@b.co, junk'), ['a@b.co']);
});
