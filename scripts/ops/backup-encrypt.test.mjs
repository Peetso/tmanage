import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { test } from 'node:test';

import { decryptStream, encryptStream, generateIdentity } from './backup-encrypt.mjs';
import { buildConfigManifest, compareConfigManifest } from './config-snapshot.mjs';

const seal = (data, recipient) => buffer(Readable.from([data]).pipe(encryptStream([recipient])));
const unseal = (data, identity) => buffer(Readable.from([data]).pipe(decryptStream(identity)));

test('age round trip across chunk boundaries; a wrong key or one flipped byte is refused', async () => {
  const { identity, recipient } = generateIdentity();
  for (const size of [0, 65536, 140000]) {
    const plain = Buffer.alloc(size, 7);
    assert.ok((await unseal(await seal(plain, recipient), identity)).equals(plain));
  }
  const sealed = await seal(Buffer.from('backup'), recipient);
  await assert.rejects(unseal(sealed, generateIdentity().identity), /no stanza/);
  sealed[sealed.length - 1] ^= 1;
  await assert.rejects(unseal(sealed, identity), /authentication failed/);
});

test('config manifest holds no values and detects a changed or missing variable', () => {
  const env = { APP_SECRET: 'hunter2-long-secret', SMTP_HOST: 'mail', PATH: '/bin' };
  const m = buildConfigManifest(env);
  assert.deepEqual(Object.keys(m.entries), ['APP_SECRET', 'SMTP_HOST']);
  assert.ok(!JSON.stringify(m).includes('hunter2'));
  assert.equal(compareConfigManifest(m, env).ok, true);
  const r = compareConfigManifest(m, { APP_SECRET: 'other', NEW_ONE: '1' });
  assert.deepEqual(
    [r.ok, r.changed, r.missing, r.extra],
    [false, ['APP_SECRET'], ['SMTP_HOST'], ['NEW_ONE']],
  );
});
