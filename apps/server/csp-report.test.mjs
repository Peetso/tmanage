import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

import {
  clientAddress,
  createCspReportHandler,
  createLineDeduper,
  createReportLimiter,
  MAX_BODY_BYTES,
  isCspReportPath,
  trustedProxyMatcher,
} from './csp-report.mjs';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/csp-report`;
  try {
    await run(url);
  } finally {
    server.close();
  }
}

const REPORT = JSON.stringify({
  'csp-report': {
    'document-uri': 'https://app.example/northstar-studio/home?token=secret#frag',
    'violated-directive': "script-src-elem 'self'",
    'blocked-uri': 'https://evil.example/x.js?user=42',
  },
});

test('a report answers 204 and logs one line: path, directive name, blocked origin — nothing else', async () => {
  const lines = [];
  await withServer(createCspReportHandler({ log: (line) => lines.push(line) }), async (url) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report', cookie: 'tmanage_session=abc' },
      body: REPORT,
    });
    assert.equal(res.status, 204);
  });
  assert.deepEqual(lines, [
    'csp-report {"documentUri":"/northstar-studio/home","violatedDirective":"script-src-elem","blockedUri":"https://evil.example"}',
  ]);
  assert.doesNotMatch(lines[0], /secret|42|abc|frag/);
});

test('a real-sized report (3 KB, full original-policy) is read; a body over 64 KB answers 413', async () => {
  const lines = [];
  const big = JSON.stringify({
    'csp-report': {
      'document-uri': 'https://app.example/platform/settings',
      'effective-directive': 'script-src-elem',
      'blocked-uri': 'inline',
      'original-policy': "default-src 'self'; ".repeat(150),
    },
  });
  assert.ok(big.length > 2048);
  await withServer(createCspReportHandler({ log: (line) => lines.push(line) }), async (url) => {
    assert.equal((await fetch(url, { method: 'POST', body: big })).status, 204);
    // Declared too large: refused on the headers, before a byte of body is read.
    const status = await new Promise((done, fail) => {
      const req = request(url, {
        method: 'POST',
        headers: { 'content-length': MAX_BODY_BYTES + 1 },
      });
      req.on('response', (res) => done(res.statusCode));
      req.on('error', fail);
      req.flushHeaders();
    });
    assert.equal(status, 413);
  });
  assert.equal(lines.length, 1);
});

test('a Reporting API batch logs each distinct report once; a repeat in the minute is not relogged', async () => {
  const lines = [];
  const entry = (blocked) => ({
    type: 'csp-violation',
    body: {
      documentURL: 'https://a.example/x',
      effectiveDirective: 'img-src',
      blockedURL: blocked,
    },
  });
  const batch = JSON.stringify([
    entry('https://a.test/1'),
    entry('https://b.test/2'),
    entry('https://a.test/3'),
  ]);
  await withServer(createCspReportHandler({ log: (line) => lines.push(line) }), async (url) => {
    assert.equal((await fetch(url, { method: 'POST', body: batch })).status, 204);
    assert.equal((await fetch(url, { method: 'POST', body: batch })).status, 204);
  });
  assert.equal(lines.length, 2);
  let clock = 0;
  const firstSeen = createLineDeduper({ now: () => clock });
  assert.equal(firstSeen('a'), true);
  assert.equal(firstSeen('a'), false);
  clock = 60_000;
  assert.equal(firstSeen('a'), true);
});

test('a burst of 600 reports from one address is kept; the 601st answers 429 until it refills', async () => {
  let clock = 0;
  const limiter = createReportLimiter({ now: () => clock });
  for (let i = 0; i < 600; i += 1) assert.equal(limiter('203.0.113.9'), true);
  assert.equal(limiter('203.0.113.9'), false);
  assert.equal(limiter('198.51.100.1'), true);
  clock = 1_000; // 300 a minute: five tokens a second
  for (let i = 0; i < 5; i += 1) assert.equal(limiter('203.0.113.9'), true);
  assert.equal(limiter('203.0.113.9'), false);

  await withServer(createCspReportHandler({ log: () => {}, limiter: () => false }), async (url) => {
    const res = await fetch(url, { method: 'POST', body: REPORT });
    assert.equal(res.status, 429);
  });
});

test('the client address is the socket peer, or behind a trusted proxy the right-most untrusted entry', () => {
  const trusted = trustedProxyMatcher('10.0.0.0/8, 192.0.2.1');
  const req = (peer, xff) => ({
    socket: { remoteAddress: peer },
    headers: { 'x-forwarded-for': xff },
  });
  assert.equal(clientAddress(req('198.51.100.7', '1.2.3.4'), trusted), '198.51.100.7');
  assert.equal(
    clientAddress(req('::ffff:10.1.2.3', '6.6.6.6, 203.0.113.5, 192.0.2.1'), trusted),
    '203.0.113.5',
  );
  assert.equal(clientAddress(req('10.1.2.3', '1.2.3.4'), trustedProxyMatcher('')), '10.1.2.3');
  assert.equal(isCspReportPath('/csp-report?x=1'), true);
  assert.equal(isCspReportPath('/csp-report/x'), false);
});
