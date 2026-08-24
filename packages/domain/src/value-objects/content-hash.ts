/**
 * Content hash — the immutable identity of a governed deliverable version.
 *
 * `23-ERD §4`: "Approval references exactly one immutable deliverable version and its
 * content hash." `25-AUTH-AND-TENANT-ISOLATION` §8: a decision is permitted only when "content hash
 * equals governed version".
 *
 * This is the mechanism that makes an approval mean something specific. Without it,
 * "Youssef approved Homepage Concept v2" is a claim about a mutable row; with it, it is a
 * claim about exact bytes.
 */

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** A validated lowercase hex SHA-256 digest. */
export type ContentHash = string & { readonly __brand: 'ContentHash' };

export function isContentHash(value: string): value is ContentHash {
  return SHA256_HEX.test(value);
}

export function assertContentHash(value: string): ContentHash {
  if (!isContentHash(value)) {
    throw new TypeError('content hash must be a lowercase hex SHA-256 digest');
  }
  return value;
}

/**
 * Constant-time comparison of two content hashes.
 *
 * These are not secrets, so timing analysis is not the threat. The reason to use a
 * length-independent loop is different and more mundane: it removes any temptation to
 * compare with `startsWith` or a truncated display form. The UI shows an abbreviated
 * `8f2c·d41a`; the authorization check must always compare the full digest, and a function
 * that visibly consumes every character makes a truncated comparison harder to introduce.
 */
export function contentHashEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The abbreviated form shown in the UI, e.g. `8f2c·d41a`.
 *
 * Matches the seed world in `19-SEED-DATA-AND-COPY.md` and the Geist Mono metadata
 * treatment in the design system. Display only — never compare against this.
 */
export function abbreviateContentHash(hash: ContentHash): string {
  return `${hash.slice(0, 4)}·${hash.slice(-4)}`;
}
