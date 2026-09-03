import { describe, expect, it } from 'vitest';
import { derivePartSigningKey, mintPartToken, verifyPartToken } from './part-token.js';

const KEY = derivePartSigningKey('a_signing_secret_that_is_long_enough_for_the_suite');
const OTHER_KEY = derivePartSigningKey('another_signing_secret_of_the_same_length_here');
const UPLOAD = 'a3f1c2d4e5f60718293a4b5c6d7e8f90';
const OTHER_UPLOAD = 'b3f1c2d4e5f60718293a4b5c6d7e8f90';
const NOW = 1_800_000_000_000;
const EXPIRES = NOW + 900_000;

const mint = (partNumber = 1, expiresAtMs = EXPIRES, uploadId = UPLOAD, key = KEY) =>
  mintPartToken(key, { providerUploadId: uploadId, partNumber, expiresAtMs });

describe('the part token', () => {
  it('is deterministic for the same claims and verifies for exactly those claims', () => {
    expect(mint()).toBe(mint());
    expect(verifyPartToken(KEY, mint(), UPLOAD, 1, NOW)).toBe(true);
  });

  it('carries the version and the expiry in the clear, and nothing else', () => {
    const [version, expiry, signature, ...rest] = mint().split('.');
    expect(version).toBe('pu1');
    expect(expiry).toBe(String(EXPIRES));
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(rest).toEqual([]);
    expect(mint()).not.toContain(UPLOAD);
  });

  it('differs per part, per upload and per secret, and verifies for none of the others', () => {
    const token = mint(1);
    expect(verifyPartToken(KEY, token, UPLOAD, 2, NOW)).toBe(false);
    expect(verifyPartToken(KEY, token, OTHER_UPLOAD, 1, NOW)).toBe(false);
    expect(verifyPartToken(OTHER_KEY, token, UPLOAD, 1, NOW)).toBe(false);
    expect(mint(1, EXPIRES, UPLOAD, OTHER_KEY)).not.toBe(token);
  });

  it('refuses a re-labelled version and a tampered expiry, because both are inside the signature', () => {
    const [, expiry, signature] = mint().split('.');
    // Reversal: leave the version out of the signed input and `pu2` verifies.
    expect(verifyPartToken(KEY, `pu2.${expiry}.${signature}`, UPLOAD, 1, NOW)).toBe(false);
    expect(verifyPartToken(KEY, `pu1.${EXPIRES + 1}.${signature}`, UPLOAD, 1, NOW)).toBe(false);
  });

  it('refuses an expired token, indistinguishably from a forged one', () => {
    const expired = mint(1, NOW - 1);
    const forged = `${expired.slice(0, -1)}${expired.endsWith('A') ? 'B' : 'A'}`;
    expect(verifyPartToken(KEY, expired, UPLOAD, 1, NOW)).toBe(false);
    expect(verifyPartToken(KEY, forged, UPLOAD, 1, NOW)).toBe(false);
    // Exactly at the boundary is expired; one millisecond before is not.
    expect(verifyPartToken(KEY, mint(1, NOW), UPLOAD, 1, NOW)).toBe(false);
    expect(verifyPartToken(KEY, mint(1, NOW + 1), UPLOAD, 1, NOW)).toBe(true);
  });

  it('parses the expiry as digits only, never as a JavaScript number', () => {
    const [, , signature] = mint().split('.');
    // Reversal: `Number()` accepts every one of these; `^\d+$` accepts none. The last three
    // are the ones that matter: they parse to the *signed* expiry, so a `Number()` verifier
    // would accept them and a token would have more than one spelling.
    for (const expiry of [' 1 ', '1e15', '0x10', '-1', '1.5', '', ` ${EXPIRES}`, `+${EXPIRES}`, `${EXPIRES}.0`]) {
      expect(verifyPartToken(KEY, `pu1.${expiry}.${signature}`, UPLOAD, 1, NOW)).toBe(false);
    }
  });

  it('refuses anything that is not a three-segment token, without throwing', () => {
    for (const token of [undefined, '', 'pu1', 'pu1.1', 'pu1.1.x.y', 'x'.repeat(300)]) {
      expect(verifyPartToken(KEY, token, UPLOAD, 1, NOW)).toBe(false);
    }
    expect(verifyPartToken(KEY, mint(), 'not-a-handle', 1, NOW)).toBe(false);
    expect(verifyPartToken(KEY, mint(), UPLOAD, 0, NOW)).toBe(false);
    expect(verifyPartToken(KEY, mint(), UPLOAD, 1.5, NOW)).toBe(false);
  });

  it('will not mint for a handle or part that is not one', () => {
    expect(() => mint(1, EXPIRES, 'nope')).toThrow(/handle/);
    expect(() => mint(0)).toThrow(/partNumber/);
  });
});
