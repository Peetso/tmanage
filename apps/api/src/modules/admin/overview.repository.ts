import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { auditEvents, memberships, usageCounters } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The admin-overview read seam — Administration module 18 (x175, audit rank #9 "Admin Partial").
 *
 * The audit named a consolidated admin overview absent: the sub-screens exist (audit viewer x115,
 * members x116, offboarding x121, org settings x153) but nothing rolls their org-level facts into one
 * health read. This is that read, and nothing more — a pure, tenant-scoped aggregation over tables
 * other modules own (`memberships`, `usage_counters`, `audit_events`). It owns no table and adds no
 * column, no write, no schedule, no migration: the org-level counterpart, for administration, of the
 * INS-06 adoption roll-up (x133) whose shape it follows deliberately.
 *
 * ## Read-only over existing data, tenancy enforced in SQL and re-checked above
 *
 * Each read is a tenant-scoped `SELECT` filtered on `organization_id = context.organizationId`, so a
 * cross-tenant row is never returned in production. The reads carry **no policy** — the org-level
 * `org.manage` gate and the belt-and-braces tenant re-check live in the controller, exactly as
 * INS-06 keeps `authorize()` out of its repository — and every row still carries its `organizationId`
 * so the controller can drop a foreign row before it contributes to a count (the FAST-PROTOCOL
 * Known-trap: scope before the count). The audit window is `created_at >= now(3) - 30 days` computed
 * in SQL against the server clock, so no client clock or session time zone enters the count and the
 * window can never be widened by the caller.
 *
 * There is no organization-id parameter anywhere here: the only organization these reads can name is
 * the one the request was already proven to belong to (`04-SECURITY-PRIVACY` §4).
 */

/** The audit roll-up window, in days. Fixed (not a query parameter): a 30-day admin health window. */
export const OVERVIEW_AUDIT_WINDOW_DAYS = 30;

/**
 * The membership statuses that consume a seat — everything but the terminal `offboarded`. `active`
 * and `suspended` are current members (suspended access is still a held seat); `invited` is a pending
 * seat. An offboarded membership is a closed record and holds no seat.
 */
const SEAT_STATUSES = ['invited', 'active', 'suspended'] as const;

/** One membership row the roll-up counts — the org it belongs to, its id, and its status. No `View` suffix: not a wire projection. */
export interface OverviewMembershipRow {
  readonly organizationId: string;
  readonly membershipId: string;
  readonly status: string;
}

/** The organization's storage counter — the org it belongs to and the bytes used. Null-safe: an org with no counter row contributes zero. */
export interface OverviewStorageRow {
  readonly organizationId: string;
  readonly usedBytes: number;
}

/** One audit event inside the window — the org it belongs to and the event id. */
export interface OverviewAuditRow {
  readonly organizationId: string;
  readonly auditEventId: string;
}

export class AdminOverviewRepository {
  /**
   * The organization's seat-holding memberships — one row per membership that is not `offboarded`,
   * tenant-scoped. The controller counts `active` for the active-member figure and every returned
   * row for seats used, and counts `suspended` as offboardings in progress, so a single read serves
   * three of the five metrics without three round trips.
   */
  async listSeatMemberships(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OverviewMembershipRow[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: memberships.organizationId,
        membershipId: memberships.id,
        status: memberships.status,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          inArray(memberships.status, [...SEAT_STATUSES]),
        ),
      );
  }

  /**
   * The organization's storage-bytes counter — at most one row (the unique key is
   * `(organization_id, metric_key)`), tenant-scoped. An organization that has never stored a file has
   * no counter row and the controller reads that absence as zero.
   */
  async listStorageCounter(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OverviewStorageRow[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: usageCounters.organizationId,
        usedBytes: usageCounters.usedValue,
      })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, 'storage.bytes'),
        ),
      );
  }

  /**
   * The audit events recorded in the last {@link OVERVIEW_AUDIT_WINDOW_DAYS} days — tenant-scoped,
   * the window boundary computed in SQL against `now(3)` so no client clock enters the count. One row
   * per event; the controller counts them after the belt-and-braces tenant filter.
   */
  async listRecentAuditEvents(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly OverviewAuditRow[]> {
    return tenantDrizzle(runner)
      .select({
        organizationId: auditEvents.organizationId,
        auditEventId: auditEvents.id,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.organizationId, context.organizationId),
          gte(
            auditEvents.createdAt,
            sql`date_sub(now(3), interval ${OVERVIEW_AUDIT_WINDOW_DAYS} day)`,
          ),
        ),
      );
  }
}
