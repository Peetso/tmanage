import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The realtime ticket — RT-001, `13-ENGINEERING` §6: "Socket authenticates short-lived
 * ticket."
 *
 * ## Stateless by design
 *
 * The ticket is an HMAC-signed claim — organization, user, expiry — not a row. There is no
 * Redis on the deployment target and a table for sixty-second tokens would be bookkeeping
 * for things that die faster than the sweep. The cost is stated: a ticket cannot be
 * revoked inside its TTL, which is why the TTL is seconds and why the ticket authorizes
 * only the *handshake* — every subscription is then checked against **current** rows
 * (§6's "subscription request names authorized resource"), so a suspended membership cuts
 * a socket off at the next subscribe even mid-TTL, and the fan-out never carries content
 * the reader could not refetch.
 *
 * ## Why this module is NOT exported from the package index
 *
 * It imports `node:crypto`. The index is imported by browser bundles (`RichTextBody`, the
 * role helpers), and a crypto import reachable from the index would drag a Node builtin
 * into the client graph. The subpath `@tmanage/domain/realtime-ticket` is real for the API
 * and the worker and invisible to the index, deliberately.
 *
 * ## Key derivation
 *
 * The signing key is derived from the session secret with a fixed context string, rather
 * than being a new environment variable: the ticket's authority comes from a session the
 * API already proved, and a second secret would be a second thing to rotate that grants
 * nothing the first does not. The context string keeps the derived key domain-separated —
 * a session cookie forgery and a ticket forgery stay different problems.
 */

export const REALTIME_TICKET_CONTEXT = 'tmanage.realtime.ticket.v1';

export interface RealtimeTicketClaims {
  readonly organizationId: string;
  readonly userId: string;
  /** Unix milliseconds. Past this instant the ticket verifies as nothing. */
  readonly expiresAt: number;
}

function keyFor(secret: string): Buffer {
  return createHmac('sha256', secret).update(REALTIME_TICKET_CONTEXT).digest();
}

function signaturize(payload: string, secret: string): string {
  return createHmac('sha256', keyFor(secret)).update(payload).digest('base64url');
}

/** Mint a ticket. The caller decides the TTL; sixty seconds is the intended order. */
export function signRealtimeTicket(claims: RealtimeTicketClaims, secret: string): string {
  const payload = Buffer.from(
    JSON.stringify({ o: claims.organizationId, u: claims.userId, e: claims.expiresAt }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${signaturize(payload, secret)}`;
}

/**
 * Verify a ticket. `null` for anything but a well-formed, correctly signed, unexpired
 * token — one answer for every failure, because a handshake error message is an oracle.
 */
export function verifyRealtimeTicket(
  token: string,
  secret: string,
  now: Date,
): RealtimeTicketClaims | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = signaturize(payload, secret);

  const got = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const organizationId = record['o'];
  const userId = record['u'];
  const expiresAt = record['e'];
  if (
    typeof organizationId !== 'string' ||
    typeof userId !== 'string' ||
    typeof expiresAt !== 'number'
  ) {
    return null;
  }
  if (expiresAt <= now.getTime()) return null;
  return { organizationId, userId, expiresAt };
}
