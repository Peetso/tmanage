import { describe, expect, it } from 'vitest';
import { parseSeedKeys } from '@tmanage/config';
import { createSeedCipher, SeedCipherError } from './seed-cipher.js';

/** Obviously fake keys: a byte repeated thirty-two times. Nothing here is a real key. */
const key = (fill: number): string => Buffer.alloc(32, fill).toString('base64url');

/** Two versions, so rotation and decrypt-only keys are exercised rather than described. */
const KEYRING = parseSeedKeys(`1:${key(0x11)};2:${key(0x22)}`);
const ONE_KEY_ONLY = parseSeedKeys(`1:${key(0x11)}`);

const USER = '0198f0aa-0000-7000-8000-000000000001';
const OTHER_USER = '0198f0aa-0000-7000-8000-000000000002';
/** A real TOTP seed shape: RFC 4648 base32, which is what the column held before D07. */
const SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** The width of `user_mfa_factors.secret`. The envelope has to fit without a migration. */
const SECRET_COLUMN_CHARS = 255;

const cipher = createSeedCipher(KEYRING);

/** Replace one character of an envelope field with a different, still-valid base64url one. */
function tamper(envelope: string, fieldIndex: number): string {
  const parts = envelope.split('.');
  const field = parts[fieldIndex];
  if (field === undefined) throw new Error(`no field ${fieldIndex} in ${envelope}`);
  parts[fieldIndex] = (field[0] === 'A' ? 'B' : 'A') + field.slice(1);
  return parts.join('.');
}

function reasonOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof SeedCipherError) return error.reason;
    throw error;
  }
  throw new Error('expected a SeedCipherError');
}

describe('encrypt', () => {
  it('round-trips a seed through the active key', () => {
    const envelope = cipher.encrypt(SEED, { userId: USER });

    expect(envelope.startsWith('mfa1.2.')).toBe(true);
    expect(envelope).not.toContain(SEED);
    expect(cipher.decrypt(envelope, { userId: USER })).toBe(SEED);
  });

  /**
   * A fresh IV per call. Two rows holding the same seed must not be recognisable as equal
   * from the ciphertext, and GCM's security collapses entirely if an IV is ever reused
   * under one key.
   */
  it('produces a different envelope every time it encrypts the same seed', () => {
    const first = cipher.encrypt(SEED, { userId: USER });
    const second = cipher.encrypt(SEED, { userId: USER });

    expect(first).not.toBe(second);
    expect(cipher.decrypt(first, { userId: USER })).toBe(SEED);
    expect(cipher.decrypt(second, { userId: USER })).toBe(SEED);
  });

  it('encrypts under the highest version even when older keys are present', () => {
    expect(cipher.keyVersionOf(cipher.encrypt(SEED, { userId: USER }))).toBe(2);
  });

  /**
   * The whole envelope has to fit `user_mfa_factors.secret` — a `VARCHAR(255)` — because the
   * design choice was to avoid a migration. The header quotes that constraint in prose; this
   * asserts it against a real 32-character base32 seed, so a later change to the format
   * (a longer prefix, a second tag, a KDF salt) fails here rather than as a truncation on a
   * production INSERT. The margin is checked, not just the limit: 255 is not a cliff we want
   * to be sitting one character below.
   */
  it('produces an envelope that fits the VARCHAR(255) column with room to spare', () => {
    const envelope = cipher.encrypt(SEED, { userId: USER });

    expect(envelope.length).toBeLessThan(SECRET_COLUMN_CHARS / 2);
    expect(cipher.decrypt(envelope, { userId: USER })).toBe(SEED);
  });

  /**
   * An empty seed would encrypt to an empty ciphertext field, which `decrypt` refuses as
   * `malformed` — the envelope would be unopenable by the very code that wrote it. It is a
   * caller bug rather than a stored-data problem, so it is a `TypeError` and not one of the
   * `SeedCipherRejection` reasons an operator is meant to act on.
   */
  it('refuses to encrypt an empty seed rather than writing an unopenable envelope', () => {
    expect(() => cipher.encrypt('', { userId: USER })).toThrow(TypeError);
    expect(() => cipher.encrypt('', { userId: USER })).toThrow(/empty MFA seed/i);
  });

  /** Every non-empty seed survives the round trip, short and odd-shaped ones included. */
  it.each([
    ['a single character', 'A'],
    ['a full base32 seed', SEED],
    ['a seed with non-ASCII bytes', 'sëed-with-ünicode'],
  ])('round-trips %s', (_label, seed) => {
    expect(cipher.decrypt(cipher.encrypt(seed, { userId: USER }), { userId: USER })).toBe(seed);
  });
});

describe('decrypt', () => {
  it('reads an envelope written under an older, decrypt-only key', () => {
    const old = createSeedCipher(ONE_KEY_ONLY).encrypt(SEED, { userId: USER });

    expect(cipher.decrypt(old, { userId: USER })).toBe(SEED);
  });

  it.each([
    ['the ciphertext', 3],
    ['the tag', 4],
    ['the iv', 2],
  ])('refuses an envelope whose %s has been altered', (_label, fieldIndex) => {
    const envelope = cipher.encrypt(SEED, { userId: USER });

    expect(reasonOf(() => cipher.decrypt(tamper(envelope, fieldIndex), { userId: USER }))).toBe(
      'authentication_failed',
    );
  });

  /**
   * The AAD is the owning user id, so a ciphertext copied into another user's row fails to
   * authenticate — a row-level move is not a way to borrow someone's second factor.
   */
  it('refuses an envelope presented for a different user', () => {
    const envelope = cipher.encrypt(SEED, { userId: USER });

    expect(reasonOf(() => cipher.decrypt(envelope, { userId: OTHER_USER }))).toBe(
      'authentication_failed',
    );
  });

  /**
   * A row left over from before D07 holds a bare base32 seed. It is refused rather than
   * used: a silent pass-through would leave plaintext working indefinitely and nobody
   * would run the backfill.
   */
  it('refuses a bare base32 seed and names the backfill command', () => {
    let caught: SeedCipherError | undefined;
    try {
      cipher.decrypt(SEED, { userId: USER });
    } catch (error) {
      caught = error as SeedCipherError;
    }

    expect(caught?.reason).toBe('not_encrypted');
    expect(caught?.message).toContain('pnpm --filter @tmanage/api mfa:encrypt-seeds');
  });

  it.each([
    ['an empty value', ''],
    ['a different envelope prefix', 'mfa2.1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'],
  ])('reports %s as not encrypted', (_label, value) => {
    expect(reasonOf(() => cipher.decrypt(value, { userId: USER }))).toBe('not_encrypted');
  });

  it('refuses an envelope written under a key this deployment does not hold', () => {
    const foreign = createSeedCipher(parseSeedKeys(`9:${key(0x99)}`)).encrypt(SEED, {
      userId: USER,
    });

    expect(reasonOf(() => cipher.decrypt(foreign, { userId: USER }))).toBe('unknown_key_version');
  });

  it.each([
    ['too few fields', 'mfa1.2.AAAAAAAAAAAAAAAA.AAAA'],
    ['too many fields', 'mfa1.2.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA.extra'],
    ['nothing after the prefix', 'mfa1.'],
    ['a non-numeric version', 'mfa1.two.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'],
    ['a zero version', 'mfa1.0.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'],
    ['an iv that is not 12 bytes', 'mfa1.2.AAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA'],
    ['a tag that is not 16 bytes', 'mfa1.2.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAA'],
    ['an empty ciphertext', 'mfa1.2.AAAAAAAAAAAAAAAA..AAAAAAAAAAAAAAAAAAAAAA'],
    ['characters outside base64url', 'mfa1.2.AAAAAAAAAAAAAAAA.AA+A.AAAAAAAAAAAAAAAAAAAAAA'],
  ])('reports %s as malformed', (_label, value) => {
    expect(reasonOf(() => cipher.decrypt(value, { userId: USER }))).toBe('malformed');
  });

  /**
   * The version is read before the key is looked up, so an envelope whose shape is wrong is
   * `malformed` rather than `unknown_key_version`: the two send an operator to different
   * places.
   */
  it('reports a malformed envelope as malformed even when its version is unknown', () => {
    expect(reasonOf(() => cipher.decrypt('mfa1.9.AAAA.AAAA.AAAA', { userId: USER }))).toBe(
      'malformed',
    );
  });
});

describe('keyVersionOf', () => {
  it('reads the version out of an envelope', () => {
    expect(cipher.keyVersionOf(cipher.encrypt(SEED, { userId: USER }))).toBe(2);
    expect(
      cipher.keyVersionOf(createSeedCipher(ONE_KEY_ONLY).encrypt(SEED, { userId: USER })),
    ).toBe(1);
  });

  it('reads a version the keyring does not hold: the envelope says what it says', () => {
    const foreign = createSeedCipher(parseSeedKeys(`9:${key(0x99)}`)).encrypt(SEED, {
      userId: USER,
    });

    expect(cipher.keyVersionOf(foreign)).toBe(9);
  });

  it.each([
    ['a bare base32 seed', SEED],
    ['an empty value', ''],
    ['a malformed envelope', 'mfa1.2.AAAA'],
  ])('returns null for %s', (_label, value) => {
    expect(cipher.keyVersionOf(value)).toBeNull();
  });
});

describe('needsRotation', () => {
  it('is false for an envelope under the active key', () => {
    expect(cipher.needsRotation(cipher.encrypt(SEED, { userId: USER }))).toBe(false);
  });

  it('is true for an envelope under an older key', () => {
    const old = createSeedCipher(ONE_KEY_ONLY).encrypt(SEED, { userId: USER });

    expect(cipher.needsRotation(old)).toBe(true);
  });

  /**
   * Plaintext left over from before D07 is the most urgent case the backfill has to pick
   * up, so it counts as needing rotation rather than being skipped for not being an
   * envelope at all.
   */
  it('is true for a value that is not an envelope at all', () => {
    expect(cipher.needsRotation(SEED)).toBe(true);
    expect(cipher.needsRotation('')).toBe(true);
  });
});
