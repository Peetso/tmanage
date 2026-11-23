import { createHash, randomBytes } from 'node:crypto';

/**
 * **The one-time internal grant — MCP connector S6, architecture B1 / B3.**
 *
 * The hosted MCP endpoint executes each tool call as an ordinary in-process API request
 * (`fastify.inject`) so it passes the same guard chain as the website. The confused-deputy
 * mitigation (architecture B1) is that the AI client's own credential — its personal access
 * token or OAuth access token — is **never forwarded** onto that inner request. Instead the
 * endpoint mints a short-lived, single-use *internal grant*: a 256-bit nonce that stands in for
 * the already-authenticated principal for exactly one inner call.
 *
 * The nonce is meaningless on its own. It is a key into this in-process map, which holds the
 * verified principal the outer request established. Three properties make it safe to trust
 * (architecture B3, tests `T-B3-*`):
 *
 *  1. **Memory only.** It is never written to the database, a log, or the wire, so it cannot be
 *     stolen at rest and there is nothing to revoke later — it is gone in 30 seconds regardless.
 *  2. **Single use.** {@link InternalGrantStore.consume} deletes the entry before it returns, so a
 *     replay of the same nonce finds nothing (`T-B3-02`).
 *  3. **30-second lifetime.** An entry past {@link INTERNAL_GRANT_TTL_MS} is refused and dropped,
 *     so a nonce that escaped somehow is useless almost immediately (`T-B3-02`).
 *
 * The fourth property is enforced by the guard, not the store: the header is accepted **only on
 * an in-process inject**, never on a request that arrived over the network (`T-B3-01`). See
 * {@link isInProcessRequest}.
 */

/** The request header that carries the nonce on the inner inject. Stripped at the edge (B3). */
export const INTERNAL_GRANT_HEADER = 'x-tmanage-internal-grant';

/** A grant lives 30 seconds. One inner call completes in well under that; a replay does not. */
export const INTERNAL_GRANT_TTL_MS = 30_000;

/**
 * The verified principal an internal grant stands in for.
 *
 * Every identifier here was proved by the *outer* request's authentication (a personal access
 * token or an OAuth access token) before the grant was minted. The inner request trusts them
 * because they came from this map, which only the endpoint can write to, never off the request.
 */
export interface InternalGrantPayload {
  /** The grant (OAuth) or token (PAT) the outer request authenticated with — for attribution. */
  readonly grantId: string;
  readonly userId: string;
  readonly membershipId: string;
  readonly organizationId: string;
  /** The AI client the call is attributed to in the audit trail (`pat:<id>` or an OAuth client). */
  readonly clientId: string;
  /** A human name for the client, shown in the audit trail and activity feed ("via <client>"). */
  readonly clientName: string;
  /** The registry op id, or `<METHOD> <path>` for the raw REST calls the tools make. */
  readonly opId: string;
  /**
   * The outer token's space-delimited OAuth scopes (a PAT carries every scope). The endpoint has
   * already checked the call against them; they ride along for attribution and later checks.
   * Absent only on a grant minted by the approve page, where the member approved in person.
   */
  readonly scopes?: string;
  /**
   * ADR-0015 part 2 (point 7b, review F2/F3). The browser session the person stepped up in, set by
   * the server from request state only — never from a header, a body or model output:
   * - the in-app chat: the chat request's own cookie session;
   * - the approve page and a card confirm: the **approving** request's cookie session;
   * - an OAuth grant holding `tmanage:platform`: the session recorded at consent.
   * A personal access token never sets it. Without it `PlatformAdminGuard` refuses the grant, and
   * `TenantContextGuard` keeps the bound-token refusal on every `@NoTenant()` platform route.
   */
  readonly stepUpSessionId?: string;
  /**
   * F1. The end of an external grant's platform window (epoch ms, `PLATFORM_AI_SCOPE_MINUTES`
   * after consent). Absent for the in-app chat and the approve page, which act inside the
   * person's own live request.
   */
  readonly platformUntil?: number;
  /** F10. The pending AI action an approved run executes, for the platform audit row. */
  readonly pendingActionId?: string;
}

interface StoredGrant {
  readonly payload: InternalGrantPayload;
  readonly expiresAt: number;
}

/**
 * The in-process store. One instance is shared by the endpoint (which mints) and the guard
 * (which consumes) — see {@link internalGrants}. `now` is injectable so the TTL can be tested
 * without real time.
 */
export class InternalGrantStore {
  private readonly grants = new Map<string, StoredGrant>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Mint a nonce for `payload`. The nonce is 256 bits of entropy, hex-encoded. */
  mint(payload: InternalGrantPayload): string {
    this.sweep();
    const nonce = randomBytes(32).toString('hex');
    this.grants.set(nonce, { payload, expiresAt: this.now() + INTERNAL_GRANT_TTL_MS });
    return nonce;
  }

  /**
   * Redeem a nonce **once**. Returns the principal, or `undefined` for an unknown, already-used
   * or expired nonce. The entry is deleted before the expiry check, so a known-but-expired nonce
   * is both refused *and* cannot be retried (`T-B3-02`).
   */
  consume(nonce: string): InternalGrantPayload | undefined {
    const found = this.grants.get(nonce);
    if (found === undefined) return undefined;
    this.grants.delete(nonce);
    if (found.expiresAt <= this.now()) return undefined;
    return found.payload;
  }

  /** The number of live (unconsumed) grants. Tests only; nothing in the app reads it. */
  get size(): number {
    return this.grants.size;
  }

  /** Drop expired entries so an idle process does not accumulate dead nonces. */
  private sweep(): void {
    const cutoff = this.now();
    for (const [nonce, grant] of this.grants) {
      if (grant.expiresAt <= cutoff) this.grants.delete(nonce);
    }
  }
}

/**
 * The single process-wide store. Minted by {@link McpEndpointController} on each inner call and
 * consumed by `SessionAuthGuard`'s internal-grant branch. A module singleton *is* the "memory
 * only" store the architecture asks for; there is deliberately no database or DI seam behind it.
 */
export const internalGrants = new InternalGrantStore();

/**
 * Whether this request is an in-process inject rather than a request from the network (B3).
 *
 * `fastify.inject` (light-my-request) drives the route with a **`MockSocket`**; a real TCP or TLS
 * connection presents a Node `Socket` / `TLSSocket`. The socket's `remoteAddress` is `127.0.0.1`
 * in *both* cases — light-my-request fills it in — so the remote address cannot tell them apart;
 * the socket's constructor name can, and is the signal used here.
 *
 * **Fail-closed:** anything that is not unmistakably a `MockSocket` is treated as "from the
 * network", so an unrecognised shape refuses the grant rather than trusting it. This is the
 * guard-side half of the edge's header strip (`T-B3-01`): even if the edge missed one, a forged
 * `x-tmanage-internal-grant` on a real request is rejected here because its socket is real.
 */
export function isInProcessRequest(raw: unknown): boolean {
  const socket = (raw as { socket?: { constructor?: { name?: string } } } | null | undefined)
    ?.socket;
  return socket?.constructor?.name === 'MockSocket';
}

/**
 * A stable, order-independent JSON serialisation of tool arguments, so the same arguments always
 * hash to the same value regardless of key order. Used only to build {@link argsSha256}; the
 * canonical form itself is never stored.
 */
export function canonicalizeArgs(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * A SHA-256 of the canonical arguments — what the audit trail records *instead of* the arguments
 * themselves (architecture B6). It proves two calls carried the same input without ever storing a
 * body, a token, or any workspace content.
 */
export function argsSha256(value: unknown): string {
  return createHash('sha256').update(canonicalizeArgs(value)).digest('hex');
}
