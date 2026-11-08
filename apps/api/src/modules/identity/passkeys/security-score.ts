import { summarizeUserAgent } from '../geo/user-agent-summary.js';

/**
 * 56-22. The per-person security score card: four checks, each worth a fixed share of 100, each
 * with the screen that fixes it. Pure, so the rule is testable without a database.
 */

export type SecurityCheckId = 'two_step' | 'passkey' | 'recovery_codes' | 'recent_password';

export interface SecurityCheck {
  readonly id: SecurityCheckId;
  readonly passed: boolean;
  readonly points: number;
  /** The settings screen (relative to `/{orgSlug}/settings/`) that fixes a failed check. */
  readonly fix: 'two-step' | 'sign-in-security' | 'password';
}

export interface SecurityScoreView {
  readonly score: number;
  readonly checks: readonly SecurityCheck[];
}

/** A password older than this no longer counts as recent. */
export const PASSWORD_MAX_AGE_DAYS = 365;

export function computeSecurityScore(
  facts: {
    readonly mfaFactors: number;
    readonly passkeys: number;
    readonly recoveryCodes: number;
    readonly passwordSetAt: Date | null;
  },
  now: Date,
): SecurityScoreView {
  const ageMs = facts.passwordSetAt ? now.getTime() - facts.passwordSetAt.getTime() : null;
  // No password at all (passkey or Google only) leaves nothing to go stale.
  const recentPassword = ageMs === null || ageMs <= PASSWORD_MAX_AGE_DAYS * 86_400_000;
  const checks: SecurityCheck[] = [
    { id: 'two_step', passed: facts.mfaFactors > 0, points: 30, fix: 'two-step' },
    { id: 'passkey', passed: facts.passkeys > 0, points: 30, fix: 'sign-in-security' },
    { id: 'recovery_codes', passed: facts.recoveryCodes > 0, points: 20, fix: 'two-step' },
    { id: 'recent_password', passed: recentPassword, points: 20, fix: 'password' },
  ];
  const score = checks.reduce((sum, check) => sum + (check.passed ? check.points : 0), 0);
  return { score, checks };
}

/** "Chrome on macOS" style key for comparing devices; `null` when the agent says nothing. */
export function deviceKey(userAgent: string | null): string | null {
  const summary = summarizeUserAgent(userAgent);
  if (summary.browser === null && summary.os === null) return null;
  return `${summary.browser ?? '?'}|${summary.os ?? '?'}|${summary.deviceType}`;
}

/**
 * A sign-in is from a new device when this person has signed in before and no earlier session
 * carried the same browser/OS/type. The very first sign-in is not "new" (nothing to compare), and
 * an agent that says nothing is never reported (it would mail on every scripted client).
 */
export function isNewDevice(current: string | null, earlier: readonly (string | null)[]): boolean {
  const key = deviceKey(current);
  if (key === null || earlier.length === 0) return false;
  return !earlier.some((agent) => deviceKey(agent) === key);
}
