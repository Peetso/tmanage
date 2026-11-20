import { describe, expect, it } from 'vitest';
import { PASSWORD_POLICY, passwordLength, passwordTooShort } from './password-policy.js';

// NIST SP 800-63B-4 §3.1.1.2 items 1-2 (ENGINEERING-STANDARD S19), AR-8 / DC-2.
describe('PASSWORD_POLICY', () => {
  it('is 15 at least (single-factor floor) and allows 64 or more', () => {
    expect(PASSWORD_POLICY.minLength).toBe(15);
    expect(PASSWORD_POLICY.maxLength).toBeGreaterThanOrEqual(64);
  });

  it('counts code points after NFKC, as the API hashes them', () => {
    expect(passwordLength('🌱🌿')).toBe(2);
    expect(passwordLength('é')).toBe(1);
    expect(passwordTooShort('a calm long ro')).toBe(true);
    expect(passwordTooShort('a calm long row')).toBe(false);
  });
});
