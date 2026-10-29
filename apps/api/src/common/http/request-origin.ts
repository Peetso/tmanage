import type { TenantContext } from '../database/tenant-context.js';

/**
 * Where a request came from — the IP and the device — and, inside an organization, the support
 * session it runs under (platform-admin v2, SPEC §6 0241 and §7 item 5).
 *
 * ## The IP is Fastify's, which is trust-proxy aware
 *
 * `request.ip` is the socket peer unless the peer is one of `TRUSTED_PROXY_ADDRESSES`, in which
 * case Fastify reads the forwarded chain (`fastify-adapter.ts`, D09). So this helper never reads
 * `X-Forwarded-For` itself: a header a client can type is not an address.
 *
 * ## Carried beside the tenant context, not inside it
 *
 * `TenantContextGuard` builds a fresh, frozen copy of the resolved context for each request and
 * registers this origin against that object ({@link bindAuditOrigin}). The audit append reads it
 * back ({@link auditOriginOf}) and stamps `ip`, `user_agent`, `platform_support_session_id` and
 * `effective_actor_id` on every row the request writes. A service or worker context has no
 * origin and stamps nothing, exactly as before.
 */

export interface RequestOrigin {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

/** The live support session the request's membership belongs to (PA-01 resolver field). */
export interface SupportSessionStamp {
  readonly id: string;
  readonly adminUserId: string;
  readonly expiresAt?: Date | string;
}

export interface AuditOrigin extends RequestOrigin {
  readonly supportSession: SupportSessionStamp | null;
}

interface RequestLike {
  readonly ip?: string;
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly socket?: { readonly remoteAddress?: string };
  readonly raw?: { readonly socket?: { readonly remoteAddress?: string } };
}

export const MAX_IP_LENGTH = 45;
export const MAX_USER_AGENT_LENGTH = 255;

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed.slice(0, max);
}

/** IP (≤ 45, fits IPv6 with an IPv4 suffix) and user agent (≤ 255) of one request. */
export function requestOriginOf(request: object): RequestOrigin {
  const r = request as RequestLike;
  const ip = r.ip ?? r.socket?.remoteAddress ?? r.raw?.socket?.remoteAddress;
  const agent = r.headers?.['user-agent'];
  return {
    ip: clip(ip, MAX_IP_LENGTH),
    userAgent: clip(Array.isArray(agent) ? agent[0] : agent, MAX_USER_AGENT_LENGTH),
  };
}

const ORIGINS = new WeakMap<TenantContext, AuditOrigin>();

/**
 * A per-request copy of `context` carrying `origin`. The copy matters: a context object that
 * outlived the request (a cache) must never carry one request's IP into another's audit row.
 */
export function bindAuditOrigin(context: TenantContext, origin: AuditOrigin): TenantContext {
  const bound = Object.freeze({ ...context });
  ORIGINS.set(bound, origin);
  return bound;
}

/** The origin registered for this context, or `null` for a service/worker context. */
export function auditOriginOf(context: TenantContext): AuditOrigin | null {
  return ORIGINS.get(context) ?? null;
}
