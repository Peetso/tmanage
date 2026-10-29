import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createServer as createTlsServer } from 'node:tls';
import { fileURLToPath } from 'node:url';

import {
  ALERT_WINDOW_MS,
  decide,
  deepOriginTlsLine,
  failuresFrom,
  originTlsFailures,
  parseAlertEmails,
  renderMail,
} from './uptime-check.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'uptime-check.mjs');

/** A self-signed certificate valid for `days`, or null when no openssl is on PATH. */
function selfSigned(dir, days) {
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        String(days),
        '-subj',
        '/CN=localhost',
        '-keyout',
        join(dir, 'k.pem'),
        '-out',
        join(dir, 'c.pem'),
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  } catch {
    return null;
  }
}

function listen(server) {
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server.address().port)));
}

test('56-30: origin_tls warns at ≤ 14 days, fails when unreadable, and reads the deep check', () => {
  assert.deepEqual(originTlsFailures(undefined), []);
  assert.deepEqual(originTlsFailures({ issuer: 'x', notAfter: 'y', daysLeft: 400 }), []);
  assert.equal(
    originTlsFailures({ issuer: 'x', notAfter: 'y', daysLeft: 14 })[0].kind,
    'origin_tls_expiring',
  );
  assert.equal(originTlsFailures({ error: 'ECONNREFUSED' })[0].kind, 'origin_tls_unreadable');
  assert.equal(
    deepOriginTlsLine({ checks: { origin_tls: { state: 'fail', daysLeft: 9 } } }),
    'deep origin_tls fail daysLeft=9',
  );
});

test('56-30: against a local self-signed origin expiring in 10 days, reports daysLeft and exits 1', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tmanage-origin-tls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pair = selfSigned(dir, 10);
  if (pair === null) return t.skip('openssl not on PATH');
  const origin = createTlsServer(pair, (socket) => socket.end());
  const site = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', checks: { origin_tls: { state: 'not_configured' } } }));
  });
  const [tlsPort, httpPort] = [await listen(origin), await listen(site)];
  t.after(() => {
    origin.close();
    site.close();
  });
  const env = {
    ...process.env,
    UPTIME_URL: `http://127.0.0.1:${String(httpPort)}`,
    UPTIME_ORIGIN_ADDRESS: `127.0.0.1:${String(tlsPort)}`,
    UPTIME_ORIGIN_SERVERNAME: 'localhost',
    UPTIME_STATE_FILE: join(dir, 'state.json'),
    ALERT_EMAILS: '',
  };
  const result = await new Promise((done) => {
    execFile(process.execPath, [SCRIPT, '--once'], { env }, (error, stdout) =>
      done({ code: error ? error.code : 0, stdout }),
    );
  });
  assert.equal(result.code, 1);
  const days = Number(/origin_tls daysLeft=(-?\d+)/u.exec(result.stdout)?.[1]);
  assert.ok(days >= 9 && days <= 10, result.stdout);
  assert.match(result.stdout, /FAIL origin_tls_expiring/u);
  assert.match(result.stdout, /deep origin_tls not_configured/u);
});

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
