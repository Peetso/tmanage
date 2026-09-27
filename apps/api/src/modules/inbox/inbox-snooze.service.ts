import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InboxSnoozeRepository, SnoozeObjectType } from './inbox-snooze.repository.js';

/**
 * IN-01/IN-02's response projection (x259) — the caller's snoozes, each row inlined, so the API↔web
 * pairing is this single shape. Dates are ISO strings, the shape `JSON.stringify` emits on the wire.
 */
export interface InboxSnoozeView {
  readonly snoozes: readonly {
    readonly bundleId: string;
    readonly snoozedUntil: string;
    readonly createdAt: string;
  }[];
}

/**
 * INBOX snooze (IN-01/IN-02, x259) — snooze an inbox bundle until a chosen time so it drops out of
 * the active inbox until then, un-snooze it, and list the caller's snoozes.
 *
 * ## The two safety rules this service is
 *
 * 1. **Ownership is resolved BEFORE authorize.** A bundle is `objectType:objectId`; the object is
 *    resolved tenant-scoped first (an unknown or cross-tenant id is a 404 with no write, the Known
 *    trap), then the caller's reach is relation-checked against the object's project with the same
 *    reused `work.read` the inbox list applies — a bundle the caller cannot reach is a 404, never a
 *    403 that would confirm it exists. This mirrors the inbox's own reauthorize-at-execution: a
 *    member snoozes only a bundle that is theirs to see.
 * 2. **`until` must be a valid future instant, checked against a bound Date.** A past, missing or
 *    unparseable `until` is a 400 with no upsert — and the comparison is against a `Date` bound in
 *    this process, never the database clock, so the admin connection's `CURRENT_TIMESTAMP` can never
 *    decide whether a snooze is in the future (`admin-pool-clock` safe).
 *
 * Snoozes are private to a membership: every read, the upsert and the delete are scoped by the acting
 * `membershipId`, which is `TenantContextGuard`'s and never a value a route supplies.
 */
export class InboxSnoozeService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: InboxSnoozeRepository,
  ) {}

  /**
   * Snooze one bundle until `until`. Resolves the bundle tenant-scoped and relation-checks BEFORE any
   * write (404), then requires a valid future `until` (400), then upserts. Returns the caller's
   * snoozes after the write. `until` arrives as `unknown` and is validated here.
   */
  async snooze(
    context: TenantContext,
    principal: Principal,
    bundleId: string,
    until: unknown,
  ): Promise<InboxSnoozeView> {
    const parsed = parseBundleId(bundleId);
    if (!parsed) throw new ApiError(404, 'not_found', MESSAGES.notFound);

    // Bound once, in this process — never the database clock (admin-pool-clock safe).
    const now = new Date();

    await this.database.transaction(context, async (tx) => {
      // 1. Resolve tenant-scoped, BEFORE authorize (Known trap): unknown/cross-tenant → 404.
      const target = await this.repository.resolveBundle(
        tx,
        context,
        parsed.objectType,
        parsed.objectId,
      );
      if (!target) throw new ApiError(404, 'not_found', MESSAGES.notFound);

      // 2. The relation gate — reused `work.read` against the resolved project, existence-hiding on
      // denial (404, not 403), so a bundle the caller cannot reach is indistinguishable from absent.
      if (!this.mayReadProject(principal, target.projectId)) {
        throw new ApiError(404, 'not_found', MESSAGES.notFound);
      }

      // 3. `until` must be a valid future instant, or a 400 with no upsert (the refusal this slice
      // proves). Checked after ownership so it cannot be used to probe a bundle the caller cannot see.
      const snoozedUntil = parseFutureUntil(until, now);

      // 4. Own-membership upsert; a re-snooze moves the time in place rather than a second row.
      await this.repository.upsert(tx, context, context.membershipId, bundleId, snoozedUntil);
    });

    return this.listOwn(context);
  }

  /**
   * Un-snooze one bundle (200 — nothing new was created). Own-membership: the delete is scoped by the
   * acting membership, so a bundle another member snoozed (or one nobody snoozed) removes nothing and
   * answers 404 — a snooze is private, so this hides the existence of one that is not the caller's.
   */
  async unsnooze(context: TenantContext, bundleId: string): Promise<InboxSnoozeView> {
    if (!parseBundleId(bundleId)) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const removed = await this.database.transaction(context, (tx) =>
      this.repository.deleteOwn(tx, context, context.membershipId, bundleId),
    );
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return this.listOwn(context);
  }

  /** The acting membership's snoozes (200). */
  async list(context: TenantContext): Promise<InboxSnoozeView> {
    return this.listOwn(context);
  }

  private async listOwn(context: TenantContext): Promise<InboxSnoozeView> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listForMembership(runner, context, context.membershipId),
    );
    return {
      snoozes: rows.map((row) => ({
        bundleId: row.bundleId,
        snoozedUntil: row.snoozedUntil.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /**
   * The reused `work.read` relation gate against a project — the same `authorize()` the inbox list
   * applies. `audience: 'internal'`: the snooze surface is the internal inbox's. An org-wide role
   * passes the relation by scope, a project member by membership, anyone else is denied.
   */
  private mayReadProject(principal: Principal, projectId: string): boolean {
    return authorize({
      principal,
      capability: 'work.read',
      resource: {
        organizationId: principal.organizationId,
        projectId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * A bundle id is `objectType:objectId`, as `markBundleRead` takes it. Only the two object bundles are
 * snoozeable — a `work_item` or a `client_request`; the `organization_usage` notice is not a bundle a
 * member snoozes, so it (and any other prefix, or a malformed id) is `null` and the service 404s.
 */
function parseBundleId(
  bundleId: string,
): { readonly objectType: SnoozeObjectType; readonly objectId: string } | null {
  const separator = bundleId.indexOf(':');
  if (separator <= 0) return null;
  const objectType = bundleId.slice(0, separator);
  const objectId = bundleId.slice(separator + 1);
  if (objectType !== 'work_item' && objectType !== 'client_request') return null;
  if (objectId === '') return null;
  return { objectType, objectId };
}

/**
 * `until` as a future instant, or a 400. It must be a string that parses to a real date strictly
 * after `now` (the bound Date). A missing, non-string, unparseable or past/now value is rejected with
 * no write — the refusal this slice proves.
 */
function parseFutureUntil(until: unknown, now: Date): Date {
  const invalid = (message: string): never => {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'until', message },
    ]);
  };
  if (typeof until !== 'string') return invalid('must be an ISO-8601 date-time string');
  const when = new Date(until);
  if (Number.isNaN(when.getTime())) return invalid('must be a valid ISO-8601 date-time');
  if (when.getTime() <= now.getTime()) return invalid('must be in the future');
  return when;
}
