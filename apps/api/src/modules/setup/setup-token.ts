import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * The shortest SETUP_TOKEN the operator should configure. Enforcing it is the caller's
 * job (config validation or the setup guard); this module only compares.
 */
export const SETUP_TOKEN_MIN_LENGTH = 32;

/**
 * True only when `configured` is a non-empty string and `presented` is a string equal to it.
 *
 * SETUP_TOKEN is a one-time install secret: the operator sets it in hPanel to unlock the
 * first-owner /setup screen and removes it once the first owner exists (see
 * deploy/hostinger/DEPLOY-HOSTINGER.md). Without it the setup route stays disabled.
 *
 * The comparison is constant time. Both values are hashed with SHA-256 first, so the two
 * buffers handed to timingSafeEqual are always 32 bytes: a wrong length does not
 * short-circuit and the response time does not reveal how long the real token is or how
 * many leading characters matched. Neither value is ever logged.
 */
export function setupTokenMatches(
  configured: string | null | undefined,
  presented: unknown,
): boolean {
  if (typeof configured !== 'string' || configured.length === 0) return false;
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const expected = createHash('sha256').update(configured, 'utf8').digest();
  const actual = createHash('sha256').update(presented, 'utf8').digest();
  return timingSafeEqual(expected, actual);
}
