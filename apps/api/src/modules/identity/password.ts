import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { Algorithm, Version } from '@node-rs/argon2';
import { PASSWORD_POLICY, passwordLength } from '@tmanage/domain';
import { COMMON_PASSWORDS } from './common-passwords.js';

/**
 * Password credentials — `04-SECURITY-PRIVACY.md` §3:
 *
 *   "Passwords, if supported, use **Argon2id** with tuned parameters and **breached-password
 *    screening**."
 *
 * Pure, in the same sense as `session-token.ts`: no database, no request, no framework. What
 * it needs from the outside is a clock (none) and a password (given), so every rule below is
 * testable without a server.
 *
 * ## The parameters, and why these numbers
 *
 * Argon2id at **m = 19 MiB, t = 2, p = 1**. That is the OWASP Password Storage Cheat Sheet's
 * first recommended configuration for Argon2id, and it is chosen over the higher-memory
 * variants for a reason specific to this deployment: `50-BOOTSTRAP` targets a shared host,
 * where a sign-in burst that allocated 64 MiB per concurrent hash would exhaust the plan's
 * memory long before it exhausted an attacker's. 19 MiB × a realistic concurrency is
 * affordable there; 64 MiB is not.
 *
 * Measured on the development machine: **15 ms** per hash. That is the honest number — it is
 * fast because the machine is fast, and the same parameters on the shared host will be
 * slower. The parameters are a floor rather than a target, which is what `needsRehash` is for.
 *
 * ## Why the encoded hash carries its own parameters
 *
 * `@node-rs/argon2` returns the PHC string form — `$argon2id$v=19$m=19456,t=2,p=1$salt$hash`.
 * The salt and every parameter travel with the digest, so raising the cost later does not
 * invalidate a single existing credential: `needsRehash` notices the old parameters on the
 * next successful sign-in, which is the one moment the plaintext is legitimately in memory,
 * and the caller re-hashes then. No migration, no forced reset, no window in which old
 * credentials are stored at the old strength while nobody is looking.
 *
 * ## What screening this file does and does not do
 *
 * §3 asks for breached-password screening. A real one is a query against a corpus of hundreds
 * of millions of leaked passwords — Have I Been Pwned's range API does it without disclosing
 * the password, using a k-anonymity prefix. **That integration is not built**: it is a network
 * call to a third party, it cannot be exercised on this machine, and a screen that silently
 * passes everything when the network is down is worse than no screen at all because it looks
 * like one.
 *
 * What is here instead is a small bundled list of the passwords that actually appear at the
 * top of every breach corpus, plus the structural checks that need no corpus. It is a floor,
 * it is stated as a floor in `docs/implementation-status.md`, and `screenPassword` takes an
 * optional async screen so the HIBP call slots in without changing a caller.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Parameters
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The current cost. Raising any of these is safe at any time — existing hashes keep working
 * and are upgraded on next sign-in by {@link needsRehash}.
 */
export const ARGON2_PARAMETERS = {
  // `Algorithm.Argon2id` and `Version.V0x13` are `declare const enum`s, which
  // `verbatimModuleSyntax` refuses to read at a value position — the declaration exists only
  // in the `.d.ts`, so there is nothing to import at runtime. The two numeric members are
  // spelled out with their names beside them rather than the option being turned off for one
  // dependency; the casts keep the field types exactly what the library expects, so a member
  // renumbered upstream is a type error here rather than a silently different algorithm.
  /** `Algorithm.Argon2id` */
  algorithm: 2 as Algorithm,
  /** `Version.V0x13` — Argon2 version 19, the current one. */
  version: 1 as Version,
  /** KiB. 19456 = 19 MiB, OWASP's first recommended Argon2id configuration. */
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  /** 32 bytes, matching the SHA-256 used elsewhere in this module. */
  outputLen: 32,
} as const;

/**
 * AR-8 / DC-2: the length policy is decided once, in `@tmanage/domain` (`PASSWORD_POLICY`, cited
 * to NIST SP 800-63B-4 §3.1.1.2: 15 for a password that may be the only factor, and a
 * **maximum that exists only to stop a denial-of-service** through a megabyte password), and
 * the web forms read the same value. No composition rules at all.
 *
 * No "must contain an uppercase, a digit and a symbol". Those rules are why `Password1!`
 * exists. 800-63B removed them deliberately, and screening against real breach data does the
 * job they were pretending to do.
 */
export const PASSWORD_MIN_LENGTH = PASSWORD_POLICY.minLength;
export const PASSWORD_MAX_LENGTH = PASSWORD_POLICY.maxLength;

// ─────────────────────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────────────────────

/** Hash a password for storage. The result is a PHC string carrying salt and parameters. */
export async function hashPassword(password: string): Promise<string> {
  return argonHash(normalise(password), ARGON2_PARAMETERS);
}

/**
 * Verify a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed or unrecognised hash. A stored value
 * this function cannot parse is a corrupt row, and the correct behaviour for a corrupt
 * credential is to refuse the sign-in — not to raise a 500 that tells the caller their
 * account is in an unusual state.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(storedHash, normalise(password));
  } catch {
    return false;
  }
}

/**
 * Whether a stored hash was produced with weaker parameters than the current ones.
 *
 * Parsed from the PHC string rather than by re-hashing, because re-hashing to compare would
 * cost a second Argon2 run on every sign-in. An unparseable hash returns `true`: if we cannot
 * tell how strong it is, treating it as weak is the safe direction, and the re-hash that
 * follows a *successful* verify replaces it with one we can read.
 */
export function needsRehash(storedHash: string): boolean {
  const parsed = parsePhc(storedHash);
  if (!parsed) return true;
  if (parsed.algorithm !== 'argon2id') return true;
  return (
    parsed.memoryCost < ARGON2_PARAMETERS.memoryCost ||
    parsed.timeCost < ARGON2_PARAMETERS.timeCost ||
    parsed.parallelism < ARGON2_PARAMETERS.parallelism
  );
}

interface ParsedPhc {
  readonly algorithm: string;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/** `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>` */
function parsePhc(encoded: string): ParsedPhc | undefined {
  const parts = encoded.split('$');
  // ['', 'argon2id', 'v=19', 'm=…,t=…,p=…', salt, hash]
  if (parts.length < 5 || parts[0] !== '') return undefined;

  const algorithm = parts[1];
  const parameters = parts[3];
  if (algorithm === undefined || parameters === undefined) return undefined;

  const byName = new Map<string, number>();
  for (const pair of parameters.split(',')) {
    const [name, value] = pair.split('=');
    if (name === undefined || value === undefined) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) continue;
    byName.set(name, parsed);
  }

  const memoryCost = byName.get('m');
  const timeCost = byName.get('t');
  const parallelism = byName.get('p');
  if (memoryCost === undefined || timeCost === undefined || parallelism === undefined) {
    return undefined;
  }

  return { algorithm, memoryCost, timeCost, parallelism };
}

// ─────────────────────────────────────────────────────────────────────────────
// Screening
// ─────────────────────────────────────────────────────────────────────────────

export type PasswordRejection =
  'too_short' | 'too_long' | 'commonly_breached' | 'contains_identifier';

/**
 * A breached-password corpus. `screenPassword` calls it when one is supplied.
 *
 * `undefined` from the implementation means **"could not check"**, and is treated differently
 * from `false`: `screenPassword` propagates the uncertainty to the caller rather than
 * silently accepting the password. A screen that fails open without saying so is the failure
 * mode this signature exists to prevent.
 */
export interface BreachedPasswordScreen {
  isBreached(password: string): Promise<boolean | undefined>;
}

export interface ScreenPasswordInput {
  readonly password: string;
  /**
   * Values the password must not contain — the person's email local part, their display name,
   * the organization slug. 800-63B calls these "context-specific words"; they are the reason
   * `northstar2026` is a bad password at Northstar and an unremarkable one anywhere else.
   */
  readonly identifiers?: readonly string[];
  readonly remoteScreen?: BreachedPasswordScreen;
}

export interface ScreenPasswordResult {
  readonly rejections: readonly PasswordRejection[];
  /**
   * True when a remote screen was asked and could not answer. The caller decides what to do —
   * this module will not decide on its behalf, because "reject every password while HIBP is
   * down" and "accept anything while HIBP is down" are both defensible and both wrong as a
   * silent default.
   */
  readonly remoteScreenUnavailable: boolean;
}

export async function screenPassword({
  password,
  identifiers = [],
  remoteScreen,
}: ScreenPasswordInput): Promise<ScreenPasswordResult> {
  const candidate = normalise(password);
  const rejections: PasswordRejection[] = [];

  // Length is measured in code points, not UTF-16 units, so an eight-emoji password is eight
  // characters rather than sixteen — and so a two-character password of astral glyphs is not
  // accepted as four.
  const length = passwordLength(candidate);
  if (length < PASSWORD_MIN_LENGTH) rejections.push('too_short');
  if (length > PASSWORD_MAX_LENGTH) rejections.push('too_long');

  const lowered = candidate.toLowerCase();

  if (COMMON_PASSWORDS.has(lowered)) rejections.push('commonly_breached');

  for (const identifier of identifiers) {
    const needle = identifier.trim().toLowerCase();
    // Below four characters an identifier match is noise: a two-letter initial appears in
    // almost every password by chance, and rejecting on it would train people to append
    // digits until the check gives up.
    if (needle.length < 4) continue;
    if (lowered.includes(needle)) {
      rejections.push('contains_identifier');
      break;
    }
  }

  let remoteScreenUnavailable = false;
  if (remoteScreen) {
    const breached = await remoteScreen.isBreached(candidate);
    if (breached === undefined) {
      remoteScreenUnavailable = true;
    } else if (breached && !rejections.includes('commonly_breached')) {
      rejections.push('commonly_breached');
    }
  }

  return { rejections, remoteScreenUnavailable };
}

/** One sentence per rejection, written for the person choosing the password. */
export function describePasswordRejection(rejection: PasswordRejection): string {
  switch (rejection) {
    case 'too_short':
      return `Use at least ${PASSWORD_MIN_LENGTH} characters. Length matters more than symbols.`;
    case 'too_long':
      return `Keep it under ${PASSWORD_MAX_LENGTH} characters.`;
    case 'commonly_breached':
      return 'That password appears in known breaches. Choose one that does not.';
    case 'contains_identifier':
      return 'That contains your name, email or organization. Choose something unrelated.';
  }
}

/**
 * Unicode normalisation, and nothing else.
 *
 * NFKC so that a password typed with a composed `é` verifies against one stored with a
 * decomposed `é` — the same keystrokes on two keyboards can produce different bytes, and a
 * person locked out by their own accent has no way to discover why.
 *
 * Deliberately **no trimming and no case folding**. A leading space is a character the person
 * chose; silently removing it means the password they typed is not the password we stored.
 */
function normalise(password: string): string {
  return password.normalize('NFKC');
}
