import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * R13 slice 2 (54-03 §4.1) — how an outbound webhook is signed.
 *
 * - `X-TManage-Signature: v1=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>` — and, during the
 *   24 h after a rotation, a second `v1=` signed with the previous secret, comma-separated, so a
 *   receiver that has not yet switched keeps verifying.
 * - `X-TManage-Timestamp` (unix seconds; a receiver refuses one more than 5 minutes off),
 *   `X-TManage-Delivery-Id`, `X-TManage-Event`, `X-TManage-Org`.
 * - The body is canonical JSON (keys sorted at every depth, no whitespace), so the bytes signed are
 *   the bytes a receiver can rebuild from the parsed object.
 *
 * Secrets: `whsec_` + 32 random bytes (base64url). At rest the plaintext is a FieldCipher envelope
 * (`webhook_secret`) and its SHA-256 is `secret_hash`; the plaintext is returned exactly twice in
 * its life — on create and on rotate — and never read back by any route.
 *
 * The worker (`apps/worker/src/consumers/webhook-deliveries.ts`) mirrors {@link signWebhook} and
 * {@link canonicalJson}; both unit suites pin the same test vector.
 */

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** How long the previous secret keeps signing after a rotation. */
export const WEBHOOK_SECRET_OVERLAP_MS = 24 * 60 * 60 * 1000;
/** A receiver should refuse a timestamp further than this from its clock. */
export const WEBHOOK_TIMESTAMP_TOLERANCE_S = 300;

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** SHA-256 (hex) — what `secret_hash` stores. */
export function hashWebhookSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** The key id a delivery row records: the first 8 hex chars of the secret's hash. */
export function signatureKeyId(secretHash: string): string {
  return secretHash.slice(0, 8);
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) sorted[key] = canonicalValue(record[key]);
    }
    return sorted;
  }
  return value;
}

/** Keys sorted at every depth, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

/** One `v1=` value. */
export function signatureFor(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac('sha256', secret)
    .update(`${String(timestamp)}.${body}`, 'utf8')
    .digest('hex')}`;
}

export interface SignWebhookInput {
  readonly secret: string;
  /** The previous secret, only while its overlap has not expired. */
  readonly previousSecret?: string | null;
  readonly timestamp: number;
  readonly body: string;
  readonly deliveryId: string;
  readonly eventKind: string;
  readonly organizationId: string;
}

/** The five headers a delivery carries. */
export function signWebhook(input: SignWebhookInput): Readonly<Record<string, string>> {
  const signatures = [signatureFor(input.secret, input.timestamp, input.body)];
  if (input.previousSecret) {
    signatures.push(signatureFor(input.previousSecret, input.timestamp, input.body));
  }
  return {
    'X-TManage-Signature': signatures.join(','),
    'X-TManage-Timestamp': String(input.timestamp),
    'X-TManage-Delivery-Id': input.deliveryId,
    'X-TManage-Event': input.eventKind,
    'X-TManage-Org': input.organizationId,
  };
}

/**
 * The receiver's check, for documentation and the tests: any `v1=` in the header matches the
 * secret, and the timestamp is within tolerance. Constant-time per comparison.
 */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly header: string;
  readonly timestamp: number;
  readonly body: string;
  readonly nowSeconds: number;
}): boolean {
  if (Math.abs(input.nowSeconds - input.timestamp) > WEBHOOK_TIMESTAMP_TOLERANCE_S) return false;
  const expected = Buffer.from(signatureFor(input.secret, input.timestamp, input.body));
  return input.header.split(',').some((part) => {
    const candidate = Buffer.from(part.trim());
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}

/** Whether the previous secret still signs at `now`. */
export function previousSecretActive(expiresAt: Date | null | undefined, now: Date): boolean {
  return expiresAt !== null && expiresAt !== undefined && expiresAt.getTime() > now.getTime();
}
