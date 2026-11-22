import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createFieldCipher, parseFieldCipherKeys } from './field-cipher.js';
import type { FieldCipherKeyring } from './field-cipher.js';

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

/**
 * LANE-X (2026-11-22): setting FIELD_CIPHER_KEYS on live, where MFA ran on the
 * AUTH_MFA_SEED_KEYS fallback ring until then.
 */
describe('FieldCipher: setting FIELD_CIPHER_KEYS without an MFA lockout', () => {
  const mfa = { purpose: 'mfa', ownerId: 'user-1' } as const;
  const b64url = () => randomBytes(32).toString('base64url');
  const ringOf = (raw: string): FieldCipherKeyring => parseFieldCipherKeys(raw);
  // Both rings start at id 1 on live: the collision is the normal case, not an edge.
  const seedRing = ringOf(`1:${b64url()}`);
  const before = createFieldCipher(null, { mfaFallback: seedRing });
  const after = createFieldCipher(ringOf(`1:${b64url()}`), { mfaFallback: seedRing });

  it('keeps an old seed readable after the key is set, even with key id 1 in both rings', () => {
    const old = before.encrypt('JBSWY3DPEHPK3PXP', mfa);
    expect(before.keyIdOf(old)).toBe('1');
    expect(after.decrypt(old, mfa)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('writes a new seed under the new key, which the fallback ring alone cannot open', () => {
    const fresh = after.encrypt('NEWSEED', mfa);
    expect(after.decrypt(fresh, mfa)).toBe('NEWSEED');
    expect(reason(() => before.decrypt(fresh, mfa))).toBe('authentication_failed');
    expect(after.activeKeyId('mfa')).toBe('1');
    expect(after.status()).toMatchObject({ enabled: true, mfaFallback: false });
  });

  it('opens an old seed whose key id the new ring does not hold', () => {
    const seedTwo = ringOf(`1:${b64url()},2:${b64url()}`);
    const old = createFieldCipher(null, { mfaFallback: seedTwo }).encrypt('S', mfa);
    expect(
      createFieldCipher(ringOf(`1:${b64url()}`), { mfaFallback: seedTwo }).decrypt(old, mfa),
    ).toBe('S');
  });

  it('rotates a collided fallback seed onto the new key, then leaves it alone', () => {
    const old = before.encrypt('SEED', mfa);
    // Same id as the new active key, but a different key: rotate must not call it current.
    const moved = after.rotate(old, mfa) as string;
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(old);
    expect(after.keyIdOf(moved)).toBe('1');
    expect(reason(() => before.decrypt(moved, mfa))).toBe('authentication_failed');
    expect(after.decrypt(moved, mfa)).toBe('SEED');
    expect(after.rotate(moved, mfa)).toBeNull();
  });

  it('still refuses a tampered seed, a moved seed and an unknown key', () => {
    const old = before.encrypt('SEED', mfa);
    const flipped = old.slice(0, -2) + (old.endsWith('AA') ? 'BA' : 'AA');
    expect(reason(() => after.decrypt(flipped, mfa))).toBe('authentication_failed');
    expect(reason(() => after.decrypt(old, { ...mfa, ownerId: 'user-2' }))).toBe(
      'authentication_failed',
    );
    const nine = createFieldCipher(ringOf(`9:${b64url()}`)).encrypt('X', mfa);
    expect(reason(() => after.decrypt(nine, mfa))).toBe('unknown_key');
  });

  it('never lends the MFA fallback to another purpose', () => {
    const token = createFieldCipher(seedRing).encrypt('t', aad);
    expect(reason(() => after.decrypt(token, aad))).toBe('authentication_failed');
    expect(reason(() => before.encrypt('t', aad))).toBe('disabled');
  });
});

describe('FIELD_CIPHER_KEYS entry separator (Hostinger cuts at ";")', () => {
  it('reads "," entries, highest id active', () => {
    const ring = parseFieldCipherKeys(` 1:${k1} , 2:${k2} `);
    expect([...ring.byId.keys()]).toEqual(['1', '2']);
    expect(ring.active.id).toBe('2');
  });

  it('still reads ";" entries from older values', () => {
    expect(parseFieldCipherKeys(`1:${k1};2:${k2}`).active.id).toBe('2');
  });

  it('refuses the leftovers of a ";" cut clearly, naming the fix', () => {
    expect(() => parseFieldCipherKeys(`1:${k1};`)).toThrow(
      /entry 2 is empty.*Hostinger cuts a value at ";".*","/,
    );
    expect(() => parseFieldCipherKeys(`1:${k1};;2:${k2}`)).toThrow(/entry 2 is empty/);
    expect(() => parseFieldCipherKeys(`1:${k1},2:${k2};3:${k()}`)).toThrow(/mixes "," and ";"/);
    // A cut inside an entry leaves a short key.
    expect(() => parseFieldCipherKeys(`1:${k1.slice(0, 20)}`)).toThrow(/32 bytes/);
  });

  it('accepts the generator output: 1:<base64url 32 bytes>, no "=", "+" or "/"', () => {
    const line = `1:${randomBytes(32).toString('base64url')}`;
    expect(line).toMatch(/^1:[A-Za-z0-9_-]{43}$/);
    expect(parseFieldCipherKeys(line).active.key.byteLength).toBe(32);
  });
});
