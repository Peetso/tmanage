import type { Principal } from '@tmanage/domain';
import type { TenantContext } from '../database/tenant-context.js';
import type { AuthenticatedSession } from '../../modules/identity/session.service.js';
import type { ResolvedMembership } from '../../modules/tenancy/membership-resolver.repository.js';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation.js';

/**
 * The per-request state the pipeline builds up, and the only place it lives.
 *
 * `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §2 is emphatic about where trusted values
 * may come from:
 *
 *   "Never accept trusted tenant or role values from arbitrary headers, request bodies, query
 *    strings, background-job payload content, or browser storage."
 *
 * Every field below is therefore **produced by a guard from a verified source**, never read
 * off the request. They are attached to one symbol-keyed slot on the Fastify request so that
 * a controller reaching for `request.body.organizationId` gets a value that authorises
 * nothing, while the value that does authorise is only reachable through the accessors here.
 *
 * The fields fill in strictly in pipeline order, and the types say so: `tenant` is absent
 * until `TenantContextGuard` has run, so a controller that reads it without the guard having
 * run is a type error rather than an `undefined` that silently means "no tenant".
 */

/**
 * Symbol-keyed so it cannot collide with a Fastify plugin's own decoration and cannot be set
 * from a JSON body. A string key on a request object is reachable by anything that can spell
 * it; a module-private symbol is not.
 */
const STATE = Symbol('tmanage.requestState');

export interface RequestState {
  /**
   * Present on every request, including unauthenticated ones — it is what ties a refusal in
   * the log to the response the caller saw.
   */
  readonly correlationId: string;
  /** Set by `SessionAuthGuard` (spec §3 step 1). Absent on `@Public()` routes. */
  session?: AuthenticatedSession;
  /**
   * How `SessionAuthGuard` authenticated this request (0202). `'cookie'` for the session cookie,
   * `'personal_access_token'` only for the successful Bearer path, which runs exclusively when
   * there is no cookie. `CsrfGuard` reads it to skip CSRF for bearer tokens — which are not
   * ambient credentials — and must trust it only because a guard, not the request, sets it.
   */
  authScheme?: 'cookie' | 'personal_access_token';
  /** Set by `TenantContextGuard` (steps 2–3). */
  tenant?: TenantContext;
  /** Set by `TenantContextGuard` alongside the context; carries role and client organization. */
  membership?: ResolvedMembership;
  /** Set by `TenantContextGuard` (step 4), assembled on the scoped path. */
  principal?: Principal;
}

/** The minimal shape this module needs. Avoids importing Fastify types into every consumer. */
type Carrier = Record<symbol, unknown>;

/**
 * Get the state for this request, creating it on first touch.
 *
 * Lazy and idempotent, and that is a correction rather than a convenience. An earlier version
 * created the state in a global **interceptor** and every guard then assumed it existed. Nest
 * runs guards *before* interceptors, so it never did: `requireRequestState` threw a plain
 * `Error`, the filter mapped it to 500, and every guarded route returned 500 instead of its
 * intended 401, 403 or 404. The suite caught it; nothing about the symptom pointed at
 * lifecycle order.
 *
 * Creating on first access removes the ordering question entirely — whichever of the guard,
 * the interceptor or the exception filter touches the request first, they all get the same
 * object and therefore the same correlation id.
 */
export function ensureRequestState(request: object): RequestState {
  const existing = (request as Carrier)[STATE] as RequestState | undefined;
  if (existing) return existing;

  const headers = (request as { headers?: Record<string, string | string[] | undefined> }).headers;
  const state: RequestState = {
    correlationId: resolveCorrelationId(headers?.[CORRELATION_HEADER]),
  };
  (request as Carrier)[STATE] = state;
  return state;
}

export function requestState(request: object): RequestState | undefined {
  return (request as Carrier)[STATE] as RequestState | undefined;
}

/** Alias kept for call sites that read better as an assertion than as a constructor. */
export const requireRequestState = ensureRequestState;

export function requireTenantContext(request: object): TenantContext {
  const tenant = requireRequestState(request).tenant;
  if (!tenant) {
    throw new Error(
      'No TenantContext on this request: TenantContextGuard did not run. A route that needs a ' +
        'tenant must not be marked @Public() or @NoTenant().',
    );
  }
  return tenant;
}

export function requirePrincipal(request: object): Principal {
  const principal = requireRequestState(request).principal;
  if (!principal) {
    throw new Error('No Principal on this request: TenantContextGuard did not run.');
  }
  return principal;
}

export function requireSession(request: object): AuthenticatedSession {
  const session = requireRequestState(request).session;
  if (!session) {
    throw new Error('No session on this request: SessionAuthGuard did not run.');
  }
  return session;
}
