import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The invitation token — TEN-003.
 *
 * `23-ERD-AND-STATE-MACHINES` §9: "Tokens are single-use, hashed, and never recoverable."
 *
 * ## Why SHA-256 here and Argon2id for a password
 *
 * A password is chosen by a person, so it is low-entropy and guessable, and the slow hash is
 * what makes guessing expensive. This token is **32 bytes from a CSPRNG** — 256 bits with no
 * structure to attack. There is nothing to guess, so a slow hash would buy no security and
 * would only make the acceptance path slower for the invited person.
 *
 * The same reasoning is written out in `recovery-codes.ts`, and the two files reach the same
 * conclusion from the same premise rather than one copying the other.
 *
 * ## Never recoverable
 *
 * Only the hash is stored. The token exists once, in the response to the request that issued
 * it, and thereafter only in the invitee's mailbox. A database dump, a backup or somebody
 * reading the row cannot reconstruct a working link — which is what makes §9's "never
 * recoverable" a property of the system rather than a promise about behaviour. Re-sending an
 * invitation therefore issues a **new** token, and there is no "show me that link again"
 * endpoint that could be built later without changing this file first.
 */

/** 32 bytes. `base64url` so the token survives a URL, an email client and a copy-paste. */
const TOKEN_BYTES = 32;

/** SHA-256 hex is 64 characters, which is what `invitations.token_hash` is declared as. */
export const TOKEN_HASH_LENGTH = 64;

export interface IssuedToken {
  /** Shown once, to the issuer, for the link. Never stored. */
  readonly token: string;
  /** What goes in the row. */
  readonly tokenHash: string;
}

export function issueInvitationToken(): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare two hashes without leaking where they first differ.
 *
 * The lookup is by unique index, so in practice the database has already found the row and
 * this is the second, independent check — but "in practice" is exactly the phrase that stops
 * being true when somebody adds a fallback path later. `timingSafeEqual` throws on unequal
 * lengths, which would itself be an oracle, so the length is checked first and a mismatch
 * returns false rather than raising.
 */
export function invitationTokenMatches(candidateHash: string, storedHash: string): boolean {
  const left = Buffer.from(candidateHash, 'utf8');
  const right = Buffer.from(storedHash, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Is this string shaped like a token at all?
 *
 * Used to refuse an obviously malformed value before it reaches a query. It is **not** a
 * security check — a well-formed token that does not exist gets the same refusal as a
 * malformed one — it exists so that a truncated link produces a validation failure rather
 * than an index lookup on a value that cannot be there.
 */
export function looksLikeInvitationToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{40,64}$/.test(value);
}
