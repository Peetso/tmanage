import { describe, expect, it } from 'vitest';
import {
  TOKEN_PREFIX,
  displayPrefixOf,
  evaluateTokenUsability,
  hashPersonalAccessToken,
  isWellFormedPersonalAccessToken,
  mintPersonalAccessToken,
} from './personal-access-token.js';

describe('personal access token minting and shape', () => {
  it('mints a prefixed token whose hash and display hint agree and never repeat', () => {
    const a = mintPersonalAccessToken();
    const b = mintPersonalAccessToken();
    expect(isWellFormedPersonalAccessToken(a.token)).toBe(true);
    expect(a.tokenHash).toBe(hashPersonalAccessToken(a.token));
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.displayPrefix).toBe(displayPrefixOf(a.token));
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it('rejects a wrong prefix, length or alphabet, and never shows the whole secret', () => {
    expect(isWellFormedPersonalAccessToken('nope')).toBe(false);
    expect(isWellFormedPersonalAccessToken(TOKEN_PREFIX + 'short')).toBe(false);
    expect(isWellFormedPersonalAccessToken(TOKEN_PREFIX + '!'.repeat(43))).toBe(false);
    const { token, displayPrefix } = mintPersonalAccessToken();
    expect(displayPrefix.length).toBeLessThan(token.length);
  });
});

describe('evaluateTokenUsability — the revocation/expiry rule', () => {
  const now = new Date('2026-10-16T12:00:00.000Z');
  it('accepts a live token, refuses a revoked one before expiry, and refuses a past expiry', () => {
    expect(evaluateTokenUsability({ revokedAt: null, expiresAt: null }, now).usable).toBe(true);
    expect(evaluateTokenUsability({ revokedAt: now, expiresAt: null }, now).reason).toBe('revoked');
    expect(evaluateTokenUsability({ revokedAt: null, expiresAt: now }, now).reason).toBe('expired');
    const future = new Date(now.getTime() + 1000);
    expect(evaluateTokenUsability({ revokedAt: null, expiresAt: future }, now).usable).toBe(true);
  });
});
