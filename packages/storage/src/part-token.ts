import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The token that authorizes one PUT of one part — ADR-0002's "locally HMAC-signed tokens
 * served by the API, not S3 signatures".
 *
 * Shape, after `apps/api`'s CSRF token and session token:
 *
 *     pu1.{expiresAtMs}.{signature}
 *     signature = base64url(HMAC-SHA256(key, "pu1.{providerUploadId}.{partNumber}.{expiresAtMs}"))
 *     key       = HMAC-SHA256(STORAGE_LOCAL_SIGNING_SECRET, "tmanage.storage.local-part.v1")
 *
 * The upload handle and the part number are in the URL's path and in the signed input, and
 * **not** in the token — the verifier parses exactly one integer, and re-validates it. The
 * version label is inside the signed input so a future scheme cannot be produced by
 * re-labelling this one. The key is derived from the secret with a context string, so the
 * same secret could sign something else later without the two being interchangeable.
 *
 * What the token does not carry: the object key, the tenant, the project, the session. The
 * store never learns a tenant (`object-store.ts`), and the route that receives the PUT has no
 * session to bind to. Possession of the token is the authority; the upload still existing in
 * the store is the revocation (`filesystem-object-store.ts`).
 *
 * Every failure is `false`. A verifier that said *why* — bad signature, expired, malformed —
 * would tell a prober which handles exist, which is the oracle `packages/domain`'s realtime
 * ticket already refuses to be.
 */

const VERSION = 'pu1';
const KEY_CONTEXT = 'tmanage.storage.local-part.v1';
const DIGITS = /^\d+$/;
const HANDLE = /^[0-9a-f]{32}$/;

export interface PartTokenClaims {
  readonly providerUploadId: string;
  readonly partNumber: number;
  readonly expiresAtMs: number;
}

/** Derive the signing key once; the secret itself never touches a message. */
export function derivePartSigningKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_CONTEXT, 'utf8').digest();
}

function signedInput(claims: PartTokenClaims): string {
  return `${VERSION}.${claims.providerUploadId}.${claims.partNumber}.${claims.expiresAtMs}`;
}

function signature(key: Buffer, claims: PartTokenClaims): Buffer {
  return createHmac('sha256', key).update(signedInput(claims), 'utf8').digest();
}

export function mintPartToken(key: Buffer, claims: PartTokenClaims): string {
  if (!HANDLE.test(claims.providerUploadId)) throw new Error('providerUploadId is not a handle');
  if (!Number.isSafeInteger(claims.partNumber) || claims.partNumber < 1) {
    throw new Error('partNumber is not a positive integer');
  }
  if (!Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs < 0) {
    throw new Error('expiresAtMs is not a timestamp');
  }
  return `${VERSION}.${claims.expiresAtMs}.${signature(key, claims).toString('base64url')}`;
}

/**
 * `true` only for a token this key minted for exactly this handle and part, and not yet
 * expired at `nowMs`. The signature is checked before the expiry, so an expired token and a
 * forged one are indistinguishable from the outside — and both are simply `false`.
 */
export function verifyPartToken(
  key: Buffer,
  token: string | undefined,
  providerUploadId: string,
  partNumber: number,
  nowMs: number,
): boolean {
  if (typeof token !== 'string' || token.length > 256) return false;
  if (!HANDLE.test(providerUploadId)) return false;
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) return false;

  const segments = token.split('.');
  if (segments.length !== 3) return false;
  const [version, expiry, presented] = segments as [string, string, string];
  if (version !== VERSION) return false;
  if (!DIGITS.test(expiry) || expiry.length > 15) return false;
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs)) return false;

  const expected = signature(key, { providerUploadId, partNumber, expiresAtMs });
  const given = Buffer.from(presented, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  return expiresAtMs > nowMs;
}
