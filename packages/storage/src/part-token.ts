import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The token that authorizes one PUT of one part — ADR-0002's "locally HMAC-signed tokens
 * served by the API, not S3 signatures".
 *
 * Shape, after `apps/api`'s CSRF token and session token:
 *
 *     pu2.{organizationId}.{expiresAtMs}.{signature}
 *     signature = base64url(HMAC-SHA256(key,
 *                   "pu2.{organizationId}.{providerUploadId}.{partNumber}.{expiresAtMs}"))
 *     key       = HMAC-SHA256(STORAGE_LOCAL_SIGNING_SECRET, "tmanage.storage.local-part.v1")
 *
 * The upload handle and the part number are in the URL's path and in the signed input, and
 * **not** in the token — the verifier parses exactly one integer, and re-validates it. The
 * version label is inside the signed input so a future scheme cannot be produced by
 * re-labelling this one (`pu1` tokens, which carried no tenant, are refused). The key is
 * derived from the secret with a context string, so the same secret could sign something
 * else later without the two being interchangeable.
 *
 * The token carries the tenant: the organization id is in the clear and inside the
 * signature, so it cannot be swapped. A verified token says only "this key minted it for
 * this org, handle and part"; the store then binds it to the upload by comparing
 * `partTokenOrganization(token)` with the tenant prefix of the upload's manifest, so a token
 * minted for one tenant can never write into another tenant's upload. It is still
 * short-lived, still carries no object key, project or session, and the upload still existing
 * in the store is the revocation (`filesystem-object-store.ts`).
 *
 * Every failure is `false`. A verifier that said *why* — bad signature, expired, malformed —
 * would tell a prober which handles exist, which is the oracle `packages/domain`'s realtime
 * ticket already refuses to be.
 */

const VERSION = 'pu2';
const KEY_CONTEXT = 'tmanage.storage.local-part.v1';
const DIGITS = /^\d+$/;
const HANDLE = /^[0-9a-f]{32}$/;
const ORGANIZATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface PartTokenClaims {
  /** The tenant the upload belongs to; a lowercase UUID. */
  readonly organizationId: string;
  readonly providerUploadId: string;
  readonly partNumber: number;
  readonly expiresAtMs: number;
}

/** Derive the signing key once; the secret itself never touches a message. */
export function derivePartSigningKey(secret: string): Buffer {
  return createHmac('sha256', secret).update(KEY_CONTEXT, 'utf8').digest();
}

function signedInput(claims: PartTokenClaims): string {
  return `${VERSION}.${claims.organizationId}.${claims.providerUploadId}.${claims.partNumber}.${claims.expiresAtMs}`;
}

function signature(key: Buffer, claims: PartTokenClaims): Buffer {
  return createHmac('sha256', key).update(signedInput(claims), 'utf8').digest();
}

export function mintPartToken(key: Buffer, claims: PartTokenClaims): string {
  if (!ORGANIZATION.test(claims.organizationId)) throw new Error('organizationId is not a uuid');
  if (!HANDLE.test(claims.providerUploadId)) throw new Error('providerUploadId is not a handle');
  if (!Number.isSafeInteger(claims.partNumber) || claims.partNumber < 1) {
    throw new Error('partNumber is not a positive integer');
  }
  if (!Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs < 0) {
    throw new Error('expiresAtMs is not a timestamp');
  }
  return `${VERSION}.${claims.organizationId}.${claims.expiresAtMs}.${signature(key, claims).toString('base64url')}`;
}

/**
 * `true` only for a token this key minted for exactly this handle and part (and for the
 * organization the token names — see `partTokenOrganization`), and not yet
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
  if (segments.length !== 4) return false;
  const [version, organizationId, expiry, presented] = segments as [string, string, string, string];
  if (version !== VERSION) return false;
  if (!ORGANIZATION.test(organizationId)) return false;
  if (!DIGITS.test(expiry) || expiry.length > 15) return false;
  const expiresAtMs = Number(expiry);
  if (!Number.isSafeInteger(expiresAtMs)) return false;

  const expected = signature(key, { organizationId, providerUploadId, partNumber, expiresAtMs });
  const given = Buffer.from(presented, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;

  return expiresAtMs > nowMs;
}

/**
 * The organization a well-formed `pu2` token names, or `null`. Purely syntactic: it checks
 * no signature and no expiry, so it is only meaningful after `verifyPartToken` returned
 * `true` for the same token. The store compares it with the tenant of the upload's manifest.
 */
export function partTokenOrganization(token: string | undefined): string | null {
  if (typeof token !== 'string' || token.length > 256) return null;
  const segments = token.split('.');
  if (segments.length !== 4) return null;
  const [version, organizationId, expiry] = segments as [string, string, string, string];
  if (version !== VERSION || !ORGANIZATION.test(organizationId)) return null;
  if (!DIGITS.test(expiry) || expiry.length > 15) return null;
  return organizationId;
}

/** What the transport asks before it reads a body: may this handle, part and token be read? */
export type PartAdmission = (
  providerUploadId: string,
  partNumber: number,
  token: string | undefined,
) => boolean;

/**
 * The admission the API's octet-stream parser consults **before** buffering a part body
 * (security review, 2026-09-04: without it any anonymous caller could hold a part-sized
 * buffer per connection with a token that verified nothing). The same key derivation and
 * the same verifier as `putPart`, so what the parser admits is exactly what the sink would
 * accept — the manifest's own refusals (aborted, completed, out of range) still follow.
 */
export function createPartAdmission(secret: string, now: () => number = Date.now): PartAdmission {
  const key = derivePartSigningKey(secret);
  return (providerUploadId, partNumber, token) =>
    verifyPartToken(key, token, providerUploadId, partNumber, now());
}
