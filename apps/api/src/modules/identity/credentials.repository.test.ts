import { describe, expect, it } from 'vitest';
import { NON_CREDENTIAL_FAILURE_REASONS } from './credentials.repository.js';
import { SIGN_IN_ABUSE_REASONS } from './sign-in-abuse-control.js';
import type { AuthenticationReason } from './authentication.service.js';

/**
 * The one list in this file that is a security property rather than a detail.
 *
 * `countRecentFailures` runs a `NOT IN` over {@link NON_CREDENTIAL_FAILURE_REASONS}, and what
 * that predicate holds is a single invariant: **the counter counts credentials that were
 * presented and refused, and never a row it caused itself.** Every entry in the list is there
 * because it fails one half or the other — nobody guessed anything, or the row is the
 * counter's own consequence — and a reason wrongly *outside* the list is a lockout somebody
 * other than the account holder can spend.
 *
 * A database case cannot be the only guard on it. `apps/api/test/id-002-credentials.db.test.ts`
 * drives the real predicate against a real server and is the proof that the query behaves; it
 * is also slow, needs an engine, and — the part that matters here — says nothing about a
 * reason that is added to {@link AuthenticationReason} tomorrow and never considered. The
 * exhaustiveness check below is what fails on that day, at typecheck, in the file where the
 * argument for the list is written down.
 */
describe('the reasons that are not credential failures', () => {
  /**
   * Every `reauth_*` member of the union, as a type rather than a copied list.
   *
   * `D05`'s gate writes one of these against the caller's own user id each time it refuses a
   * credential-changing route for want of fresh proof. None of them is a credential guess:
   *
   * - `reauth_required` — no token was presented at all.
   * - `reauth_expired` — a token this server signed itself, correctly, whose TTL has passed.
   * - `reauth_wrong_session` — an authentic token whose claims name another session.
   * - `reauth_invalid` — malformed, or signed under another key. The only forgery of the
   *   four, and it is a forgery of an HMAC over `SESSION_SECRET`, not a guess at the
   *   low-entropy secret this counter exists to protect. Five attempts in 900 seconds is
   *   meaningless against the first and decisive against the second, which is the whole
   *   reason the two do not belong in one budget.
   *
   * What made counting them a denial of service rather than an inaccuracy is who can produce
   * them. The refusal is reached from inside a live session, so somebody holding a stolen
   * cookie writes them at will against the owner's user id — and the lockout they fill is
   * read by `signInWithPassword` *and* `confirmReauthentication`, so the owner can neither
   * sign in nor mint the proof that would end the intruder's session.
   */
  type ReauthReason = Extract<AuthenticationReason, `reauth_${string}`>;

  const REAUTH_REASONS = [
    'reauth_required',
    'reauth_invalid',
    'reauth_expired',
    'reauth_wrong_session',
  ] as const satisfies readonly ReauthReason[];

  /**
   * Fails to compile the moment a `reauth_*` reason is added to the union without being
   * weighed here — which is the only way this file can speak about a reason nobody has
   * written yet.
   */
  const everyReauthReasonIsListed: [
    Exclude<ReauthReason, (typeof REAUTH_REASONS)[number]>,
  ] extends [never]
    ? true
    : false = true;

  it('covers every reason the union spells', () => {
    expect(everyReauthReasonIsListed).toBe(true);
  });

  it('excludes the three throttle refusals, which never reached a password', () => {
    expect(NON_CREDENTIAL_FAILURE_REASONS).toEqual(
      expect.arrayContaining([...SIGN_IN_ABUSE_REASONS]),
    );
  });

  it('excludes the lockout row, which the count writes about itself', () => {
    expect(NON_CREDENTIAL_FAILURE_REASONS).toContain('locked_out');
  });

  it('excludes every re-authentication refusal, for the same reason', () => {
    expect(NON_CREDENTIAL_FAILURE_REASONS).toEqual(expect.arrayContaining([...REAUTH_REASONS]));
  });

  /**
   * The direction that fails open, pinned from the other side. A credential that *was*
   * presented and refused must stay counted, or the lockout stops being one.
   */
  it('excludes nothing that is a credential presented and refused', () => {
    const counted: readonly AuthenticationReason[] = [
      'bad_password',
      'no_password_set',
      'no_such_user',
      'mfa_bad_code',
      'mfa_replayed',
      'mfa_no_factor',
      'mfa_required',
      'challenge_invalid',
      'challenge_expired',
      'recovery_code_invalid',
      'recovery_code_spent',
    ];
    for (const reason of counted) {
      expect(NON_CREDENTIAL_FAILURE_REASONS).not.toContain(reason);
    }
  });
});
