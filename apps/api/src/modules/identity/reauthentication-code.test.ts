import { describe, expect, it } from 'vitest';
import {
  reauthenticationCodeFactors,
  reauthenticationNeedsAuthenticatorCode,
} from './reauthentication-code.js';

/**
 * STEPUPFIX (live 2026-11-19): the owner set up two-step by e-mail codes, the Platform admin
 * step-up then demanded a code that is never mailed, and the owner was locked out. The rule that
 * `confirmReauthentication` enforces and the screens' "show a code field?" flag now share one
 * helper; these cases pin it.
 */

const CONFIRMED = new Date('2026-11-01T09:00:00Z');
const email = { id: 'e', kind: 'email', confirmedAt: CONFIRMED };
const totp = { id: 't', kind: 'totp', confirmedAt: CONFIRMED };
const pendingTotp = { id: 'p', kind: 'totp', confirmedAt: null };

describe('reauthentication code rule', () => {
  it('e-mail codes only: the password is enough, no code is asked for', () => {
    expect(reauthenticationNeedsAuthenticatorCode([email])).toBe(false);
    expect(reauthenticationCodeFactors([email])).toEqual([]);
  });

  it('an authenticator app: the 6-digit code is asked for', () => {
    expect(reauthenticationNeedsAuthenticatorCode([totp])).toBe(true);
    expect(reauthenticationNeedsAuthenticatorCode([email, totp])).toBe(true);
    expect(reauthenticationCodeFactors([email, totp])).toEqual([totp]);
  });

  it('an authenticator whose set-up was never finished does not count', () => {
    expect(reauthenticationNeedsAuthenticatorCode([pendingTotp, email])).toBe(false);
  });

  it('no two-step at all: no code', () => {
    expect(reauthenticationNeedsAuthenticatorCode([])).toBe(false);
  });
});
