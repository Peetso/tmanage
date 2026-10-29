import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, parseFieldCipherKeys } from './field-cipher.js';

const k = () => randomBytes(32).toString('base64');
const [k1, k2] = [k(), k()];
const aad = { purpose: 'storage_token', ownerId: 'row-1' } as const;
const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as { reason?: string }).reason ?? 'type';
  }
  return 'none';
};

describe('FieldCipher (56-02)', () => {
  const old = createFieldCipher(parseFieldCipherKeys(`1:${k1}`));
  const ring = createFieldCipher(parseFieldCipherKeys(`1:${k1};2:${k2}`));

  it('round-trips under the newest key', () => {
    const env = ring.encrypt('secret', aad);
    expect(env.startsWith('fc1.storage_token.2.')).toBe(true);
    expect(ring.decrypt(env, aad)).toBe('secret');
  });

  it('rejects a wrong key, a tampered envelope, a wrong purpose and a moved row', () => {
    const env = ring.encrypt('secret', aad);
    expect(reason(() => old.decrypt(env, aad))).toBe('unknown_key');
    const other = createFieldCipher(parseFieldCipherKeys(`2:${k()}`));
    expect(reason(() => other.decrypt(env, aad))).toBe('authentication_failed');
    const flipped = env.slice(0, -2) + (env.endsWith('AA') ? 'BA' : 'AA');
    expect(reason(() => ring.decrypt(flipped, aad))).toBe('authentication_failed');
    expect(reason(() => ring.decrypt(env, { ...aad, purpose: 'scim_token' }))).toBe(
      'wrong_purpose',
    );
    expect(reason(() => ring.decrypt(env, { ...aad, ownerId: 'row-2' }))).toBe(
      'authentication_failed',
    );
    expect(reason(() => ring.decrypt('plain', aad))).toBe('not_encrypted');
  });

  it('rotates an old-key envelope to the newest key and leaves a current one alone', () => {
    const before = old.encrypt('secret', aad);
    const after = ring.rotate(before, aad) as string;
    expect(ring.keyIdOf(after)).toBe('2');
    expect(ring.decrypt(after, aad)).toBe('secret');
    expect(ring.rotate(after, aad)).toBeNull();
  });

  it('is disabled without keys and never stores plaintext', () => {
    expect(reason(() => createFieldCipher(null).encrypt('secret', aad))).toBe('disabled');
  });
});
