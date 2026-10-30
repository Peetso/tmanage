import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createSecurityTxtHandler, isSecurityTxtPath, securityTxt } from './security-txt.mjs';

const NOW = new Date('2026-10-30T12:00:00.000Z');
const ENV = { WEB_PUBLIC_URL: 'https://tmanage.example/', SECURITY_CONTACT_EMAIL: 'sec@x.example' };

test('security.txt carries the RFC 9116 fields with Expires in the future and under a year', () => {
  const text = securityTxt(ENV, NOW);
  assert.match(text, /^Contact: mailto:sec@x\.example$/m);
  assert.match(text, /^Preferred-Languages: en, ar$/m);
  assert.match(text, /^Policy: https:\/\/tmanage\.example\/security\/disclosure$/m);
  assert.match(text, /^Canonical: https:\/\/tmanage\.example\/\.well-known\/security\.txt$/m);
  const expires = new Date(/^Expires: (\S+)$/m.exec(text)[1]);
  assert.ok(expires > NOW && expires.getTime() - NOW.getTime() < 365 * 24 * 3600 * 1000);
  const fallback = securityTxt({ WEB_PUBLIC_URL: 'https://a.example' }, NOW);
  assert.match(fallback, /mailto:security@a\.example/);
});

test('served as text/plain on GET, 405 on POST, exact path only', async () => {
  assert.equal(isSecurityTxtPath('/.well-known/security.txt?x=1'), true);
  assert.equal(isSecurityTxtPath('/security.txt'), false);
  const server = createServer(createSecurityTxtHandler(ENV, () => NOW));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/.well-known/security.txt`;
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    assert.match(await res.text(), /^Contact: /);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  } finally {
    server.close();
  }
});
