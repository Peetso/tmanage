import { describe, expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { constantTimeEquals } from './session-token.js';
import type * as NodeCrypto from 'node:crypto';
import type * as SessionToken from './session-token.js';
import {
  EMAIL_CODE_RESEND_GAP_MS,
  EMAIL_CODE_SENDS_PER_HOUR,
  createEmailCodeSendBudget,
  emailCodeBinding,
  emailCodeMatches,
  generateEmailCode,
  hashEmailCode,
  maskEmailAddress,
} from './email-code.js';

/**
 * MFAOPTIONS. The pure half of the e-mail code second step: the code, its stored form, what it
 * is bound to, and the send limits. Each case fails when the check it names is removed.
 */

// Pass-through spies: the real CSPRNG and the real compare run, and the test sees the calls.
vi.mock('node:crypto', async (original) => {
  const real = await original<typeof NodeCrypto>();
  return { ...real, randomInt: vi.fn(real.randomInt) };
});
vi.mock('./session-token.js', async (original) => {
  const real = await original<typeof SessionToken>();
  return { ...real, constantTimeEquals: vi.fn(real.constantTimeEquals) };
});

const SECRET = 'local_dev_only_session_secret_for_the_email_code_test';
const BINDING = emailCodeBinding('sign_in', 'challenge-token-a');

describe('generateEmailCode', () => {
  it('is six digits, leading zeros kept', () => {
    for (let i = 0; i < 200; i += 1) expect(generateEmailCode()).toMatch(/^\d{6}$/u);
  });

  it('comes from the CSPRNG over the whole million', () => {
    vi.mocked(randomInt).mockClear();
    generateEmailCode();
    expect(randomInt).toHaveBeenCalledWith(0, 1_000_000);
  });
});

describe('the stored form of a code', () => {
  it('is never the code itself and depends on the secret', () => {
    const stored = hashEmailCode('123456', BINDING, SECRET);
    expect(stored).not.toContain('123456');
    expect(stored).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashEmailCode('123456', BINDING, `${SECRET}-other`)).not.toBe(stored);
  });

  it('is bound: a code sent for one challenge does not finish another', () => {
    const stored = hashEmailCode('123456', BINDING, SECRET);
    expect(emailCodeMatches(stored, '123456', BINDING, SECRET)).toBe(true);
    const other = emailCodeBinding('sign_in', 'challenge-token-b');
    expect(emailCodeMatches(stored, '123456', other, SECRET)).toBe(false);
    // Nor does a sign-in code finish an enrolment over the same subject.
    expect(
      emailCodeMatches(stored, '123456', emailCodeBinding('enrol', 'challenge-token-a'), SECRET),
    ).toBe(false);
  });

  it('refuses a wrong or malformed code, and tolerates spaces a person types', () => {
    const stored = hashEmailCode('012345', BINDING, SECRET);
    expect(emailCodeMatches(stored, '012346', BINDING, SECRET)).toBe(false);
    expect(emailCodeMatches(stored, '12345', BINDING, SECRET)).toBe(false);
    expect(emailCodeMatches(stored, '', BINDING, SECRET)).toBe(false);
    expect(emailCodeMatches(stored, '012 345', BINDING, SECRET)).toBe(true);
  });

  it('a malformed candidate that hashes like the stored value still never matches', () => {
    // If the shape check were dropped, a stored hash of a non-code value would be reachable.
    const stored = hashEmailCode('abcdef', BINDING, SECRET);
    expect(emailCodeMatches(stored, 'abcdef', BINDING, SECRET)).toBe(false);
  });

  it('compares in constant time', () => {
    vi.mocked(constantTimeEquals).mockClear();
    emailCodeMatches(hashEmailCode('123456', BINDING, SECRET), '654321', BINDING, SECRET);
    expect(constantTimeEquals).toHaveBeenCalledTimes(1);
  });
});

describe('maskEmailAddress', () => {
  it('shows the first letter and the domain only', () => {
    expect(maskEmailAddress('peter@example.com')).toBe('p•••@example.com');
    expect(maskEmailAddress('not-an-address')).toBe('•••');
  });
});

describe('the send budget', () => {
  const at = { t: 1_757_000_000_000 };
  const budget = () => {
    at.t = 1_757_000_000_000;
    return createEmailCodeSendBudget(() => at.t);
  };

  it('holds 30 seconds between two sends to one person', () => {
    const b = budget();
    expect(b.admit({ userId: 'u1', ip: '198.51.100.1' })).toBe('admitted');
    at.t += EMAIL_CODE_RESEND_GAP_MS - 1;
    expect(b.admit({ userId: 'u1', ip: '198.51.100.1' })).toBe('too_soon');
    at.t += 1;
    expect(b.admit({ userId: 'u1', ip: '198.51.100.1' })).toBe('admitted');
  });

  it('allows five an hour per person, from any address', () => {
    const b = budget();
    for (let i = 0; i < EMAIL_CODE_SENDS_PER_HOUR; i += 1) {
      expect(b.admit({ userId: 'u1', ip: `198.51.100.${i}` })).toBe('admitted');
      at.t += EMAIL_CODE_RESEND_GAP_MS;
    }
    expect(b.admit({ userId: 'u1', ip: '198.51.100.99' })).toBe('over_budget');
  });

  it('allows five an hour per source address, across people', () => {
    const b = budget();
    for (let i = 0; i < EMAIL_CODE_SENDS_PER_HOUR; i += 1) {
      expect(b.admit({ userId: `u${i}`, ip: '198.51.100.7' })).toBe('admitted');
    }
    expect(b.admit({ userId: 'u-next', ip: '198.51.100.7' })).toBe('over_budget');
  });

  it('charges nothing for a refused send', () => {
    const b = budget();
    for (let i = 0; i < EMAIL_CODE_SENDS_PER_HOUR; i += 1) {
      expect(b.admit({ userId: `u${i}`, ip: '198.51.100.7' })).toBe('admitted');
    }
    // Refused on the source; the person's own budget and gap stay untouched.
    expect(b.admit({ userId: 'fresh', ip: '198.51.100.7' })).toBe('over_budget');
    expect(b.admit({ userId: 'fresh', ip: '203.0.113.9' })).toBe('admitted');
  });
});
