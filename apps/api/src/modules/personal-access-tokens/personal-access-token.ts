import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Personal access tokens — the credential an MCP client (Claude Desktop/Code, ChatGPT's
 * developer-mode connectors, any MCP-capable assistant) presents as `Authorization: Bearer
 * <token>` to act as the member who created it, with that member's own permissions and
 * nothing more (`25-AUTHORIZATION-AND-TENANT-ISOLATION` §3).
 *
 * This module is the pure half: minting, hashing, shape-checking, and the revocation/expiry
 * verdict. It touches no database and no framework, so it is exercised entirely by fast unit
 * tests — the same split the session-token module keeps.
 *
 * ## Why only the hash is stored
 *
 * A personal access token is a bearer credential: whoever holds the string can act as the
 * member until it is revoked. So the plaintext is shown to its creator exactly once, at
 * creation, and never again — the database keeps only a SHA-256 hash, exactly as
 * `session_refresh_tokens` does. A database read, a backup, or a leaked dump therefore yields
 * no usable token. Lookup is by hash, which the unique index on `token_hash` makes O(1), so
 * there is no need to store any reversible part of the secret.
 *
 * SHA-256 (not a slow KDF) is correct here for the same reason it is correct for refresh
 * tokens: the secret is 32 bytes of CSPRNG output, so there is no low-entropy password to
 * grind — a brute-force search is a 2^256 space, and a slow hash would only tax the login
 * path it protects nothing extra.
 */

/**
 * The visible marker every token carries. A leading human-readable prefix lets a secret
 * scanner (and a person who finds one in a log) recognise it instantly, and lets the creator
 * tell a TManage token apart from the dozen others a developer pastes into a config.
 */
export const TOKEN_PREFIX = 'tmanage_pat_';

/** 32 bytes of CSPRNG output, base64url-encoded — 256 bits of entropy in the secret. */
const SECRET_BYTES = 32;

/**
 * base64url of 32 bytes is always 43 characters (no padding). The full token is the prefix
 * plus those 43 characters; the shape check below holds callers to exactly that.
 */
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * How much of the token the UI may show after creation. The prefix plus the first six secret
 * characters identifies a token in a list ("tmanage_pat_a1b2c3…") without being enough to
 * reconstruct it — 2^36 of the 2^256 space, which reverses nothing.
 */
const DISPLAY_SECRET_CHARS = 6;

export interface MintedPersonalAccessToken {
  /** The plaintext. Returned to the creator once, never stored, never logged. */
  readonly token: string;
  /** SHA-256 hex of the plaintext — the only form that reaches the database. */
  readonly tokenHash: string;
  /** The safe-to-store, safe-to-show hint, e.g. `tmanage_pat_a1b2c3…`. */
  readonly displayPrefix: string;
}

/** Mint a fresh token: a random secret, its hash, and the display hint, in one place. */
export function mintPersonalAccessToken(): MintedPersonalAccessToken {
  const token = TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
  return {
    token,
    tokenHash: hashPersonalAccessToken(token),
    displayPrefix: displayPrefixOf(token),
  };
}

/** SHA-256 hex of a token string. The stored and looked-up form; see the module note. */
export function hashPersonalAccessToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Whether a presented string could be one of our tokens at all.
 *
 * A fast structural reject before the database is touched: a Bearer header carrying anything
 * that is not `tmanage_pat_` + 43 base64url characters cannot match a row, so it is refused
 * without a query. This is shape, not authorization — a well-formed token still has to be
 * found, live, and unexpired.
 */
export function isWellFormedPersonalAccessToken(token: string): boolean {
  if (!token.startsWith(TOKEN_PREFIX)) return false;
  return SECRET_PATTERN.test(token.slice(TOKEN_PREFIX.length));
}

/** The safe display hint for a token, e.g. `tmanage_pat_a1b2c3…`. */
export function displayPrefixOf(token: string): string {
  const secret = token.slice(TOKEN_PREFIX.length);
  return TOKEN_PREFIX + secret.slice(0, DISPLAY_SECRET_CHARS) + '…';
}

/**
 * Constant-time comparison of two already-computed hashes.
 *
 * Lookup is by the unique `token_hash` index, so this is not on the hot path — but when a
 * caller does compare a presented hash against a stored one, it must not leak how many leading
 * characters matched through timing. Lengths are compared first (a length mismatch is not a
 * secret), then the bytes in constant time.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** Why a looked-up token may not be used. `null` means it is usable. */
export type TokenUnusableReason = 'revoked' | 'expired';

export interface TokenLifecycle {
  /** When the token was revoked, or `null` if it never was. */
  readonly revokedAt: Date | null;
  /** The optional expiry the creator chose, or `null` for a token that does not expire. */
  readonly expiresAt: Date | null;
}

export interface TokenUsability {
  readonly usable: boolean;
  readonly reason: TokenUnusableReason | null;
}

/**
 * The revocation/expiry verdict, as a pure function of the row and the clock.
 *
 * Kept separate from the lookup so the rule is tested without a database and cannot drift
 * between the authentication path and any admin view that wants to show a token's state.
 * Revocation is checked before expiry: a revoked token is revoked whatever its expiry says,
 * and the distinction only affects which word the audit trail records.
 */
export function evaluateTokenUsability(lifecycle: TokenLifecycle, now: Date): TokenUsability {
  if (lifecycle.revokedAt !== null) return { usable: false, reason: 'revoked' };
  if (lifecycle.expiresAt !== null && lifecycle.expiresAt.getTime() <= now.getTime()) {
    return { usable: false, reason: 'expired' };
  }
  return { usable: true, reason: null };
}
