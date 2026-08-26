import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Recovery codes — the fallback `22-SCREEN-BY-SCREEN` §3 puts on `ID-02` ("Enter a recovery
 * code") and `ID-05` ("recovery codes"), and the answer to the failure mode TOTP creates: a
 * person who loses their phone loses their account.
 *
 * Pure, like its neighbours. Generation, formatting, hashing and comparison; no storage.
 *
 * ## Why these are hashed the way passwords are not
 *
 * A recovery code is a credential, so it is hashed at rest — but with **SHA-256, not
 * Argon2id**, and that difference is deliberate rather than an inconsistency.
 *
 * Argon2 exists to make guessing expensive when the secret is weak, which is the situation
 * with a human-chosen password. A recovery code is not human-chosen: it is 50 bits of
 * randomness from `randomBytes`. There is no dictionary to run against it, and an attacker
 * with the hash gains nothing from a slow function that they would not gain from a fast one —
 * 2^50 is out of reach either way.
 *
 * What the fast hash buys is real: ten codes are checked on every attempt, because a code is
 * presented without saying which of the ten it is. Ten Argon2 verifications at 19 MiB each is
 * 190 MiB and roughly 150 ms of CPU per attempt, on a shared host, on an endpoint reachable
 * before authentication. That is a denial-of-service amplifier with a factor of ten built in.
 *
 * ## The alphabet
 *
 * Crockford base32 minus the letters it already excludes: no `I`, `L`, `O` or `U`. A recovery
 * code is read off a screen and typed later, sometimes from a photograph or a printout, and
 * `1`/`I`/`l` and `0`/`O` are the two mistakes that account for most failed entries. `U` is
 * dropped as well, following Crockford, because its exclusion prevents an unfortunate class
 * of accidental words.
 *
 * Verification is case-insensitive and ignores hyphens and spaces, so the grouping that makes
 * a code readable never makes it wrong.
 */

/** Crockford's alphabet: 10 digits + 22 letters, with I, L, O and U removed. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Ten codes, which is what every implementation of this feature offers and what ID-05 shows. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * Ten characters from a 32-symbol alphabet — 50 bits.
 *
 * Ten codes of 50 bits each means an attacker guessing blind faces roughly 2^47 attempts even
 * with ten valid answers in play, which is far beyond any rate limit's job to prevent.
 */
export const RECOVERY_CODE_LENGTH = 10;

export interface GeneratedRecoveryCodes {
  /**
   * Shown to the person exactly once, formatted for reading. Never stored, never logged, and
   * never returned by any later request — `ID-05` says "Regenerating invalidates the old set
   * immediately" precisely because there is no way to show these again.
   */
  readonly codes: readonly string[];
  /** What the database holds: SHA-256 hex of the normalised code, in the same order. */
  readonly hashes: readonly string[];
}

export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): GeneratedRecoveryCodes {
  const codes: string[] = [];
  const hashes: string[] = [];

  for (let index = 0; index < count; index += 1) {
    const code = generateOne();
    codes.push(format(code));
    hashes.push(hashRecoveryCode(code));
  }

  return { codes, hashes };
}

/**
 * The stored form.
 *
 * Normalised first, so that the hash of what the person types matches the hash of what they
 * were shown regardless of case, hyphens or the spaces a copy-paste picks up.
 */
export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalise(code), 'utf8').digest('hex');
}

/**
 * Find which stored hash a presented code matches, if any.
 *
 * Returns the **index**, not a boolean, because the caller has to mark that specific code used
 * — a recovery code is single-use, and a set where one code can be replayed is a set with one
 * code in it.
 *
 * Every hash is compared even after a match, and each comparison is constant-time. Returning
 * early would make the response time reveal the position of the matching code within the set,
 * which is not a catastrophic leak but is a free one to avoid.
 */
export function findRecoveryCode(code: string, hashes: readonly string[]): number | undefined {
  const normalised = normalise(code);
  if (normalised.length !== RECOVERY_CODE_LENGTH) return undefined;

  const candidate = hashRecoveryCode(normalised);
  let found: number | undefined;

  for (const [index, stored] of hashes.entries()) {
    if (constantTimeEquals(candidate, stored) && found === undefined) {
      found = index;
    }
  }

  return found;
}

/**
 * Strip the formatting and fold the case.
 *
 * Also maps the four characters the alphabet excludes onto the ones they are mistaken for:
 * `I` and `L` to `1`, `O` to `0`. Someone reading `1` off a printout and typing `l` gets in,
 * which costs nothing — those characters can never appear in a real code, so the mapping
 * cannot collide with one.
 */
function normalise(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

/** `XXXXX-XXXXX` — one hyphen, because two groups of five is the length people read reliably. */
function format(code: string): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * One code's worth of unbiased randomness.
 *
 * Rejection sampling rather than `byte % 32`. With a 32-symbol alphabet and 256 possible byte
 * values the modulo happens to be unbiased — 256 is a multiple of 32 — but relying on that
 * arithmetic coincidence means the day someone changes the alphabet length to 33 the bias
 * arrives silently. The rejection loop is correct for any alphabet.
 */
function generateOne(): string {
  let out = '';
  while (out.length < RECOVERY_CODE_LENGTH) {
    for (const byte of randomBytes(RECOVERY_CODE_LENGTH)) {
      if (byte >= 256 - (256 % ALPHABET.length)) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === RECOVERY_CODE_LENGTH) break;
    }
  }
  return out;
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
