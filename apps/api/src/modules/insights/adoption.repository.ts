import { and, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { meetings, memberships, workItems } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * INS-06's read seam — the org-wide adoption roll-up.
 *
 * "Adoption" is the audit's plain question: is the studio actually using the product? INS-06 answers
 * it with three org-level facts, all already stored — how many people hold an active membership, how
 * many of them have created any work lately, and how many meetings the studio has held lately. It is
 * the org-level counterpart to INS-05's per-project workload roll-up (x123), and like it owns no
 * table and adds no column: a pure read, computed on demand, no write, no schedule, no migration.
 *
 * ## Read-only over existing data
 *
 * Each read is a tenant-scoped `SELECT` over a table another module owns — `memberships` (tenancy),
 * `work_items` (work, x88's), `meetings` (calendar, x90's) — and nothing here writes. The reads
 * carry **no policy**: the org-level `work.read` gate and the belt-and-braces tenant re-check live in
 * the controller, exactly as INS-05 keeps `authorize()` out of `WorkloadRepository`. The two
 * activity reads take a `windowDays` bound the controller has already clamped to `[1, 90]`; the
 * window boundary is computed in SQL against `now(3)` so no client clock or session time zone enters
 * the count.
 *
 * ## Tenancy is enforced in SQL, and re-checked above
 *
 * Every read filters on `organization_id = context.organizationId`, so a cross-tenant row is never
 * returned in production. Each row still carries its `organizationId` so the controller can drop a
 * foreign row belt-and-braces before it contributes to a count — the FAST-PROTOCOL Known-trap
 * (scope before the count), the same defence INS-05 applies per project.
 */

/** One active membership — the org it belongs to and the user it names. No `View` suffix: not a wire projection. */
export interface AdoptionMemberRow {
  readonly organizationId: string;
  readonly userId: string;
}

/** One recent work item's owner — the org it belongs to and the user who owns it. */
export interface AdoptionWorkOwnerRow {
  readonly organizationId: string;
  readonly ownerUserId: string | null;
}

/** One meeting held in the window — the org it belongs to and its id. */
export interface AdoptionMeetingRow {
  readonly organizationId: string;
  readonly meetingId: string;
}

export class InsightsAdoptionRepository {
  /**
   * The organization's active memberships — one row per active member, tenant-scoped. Suspended,
   * invited and offboarded memberships are not active use and are excluded in SQL. Distinct-by-user
   * counting is the controller's (a member has at most one membership per org by the
   * `uq_memberships_org_user` unique index, but the controller counts distinct users anyway so a
   * duplicated row could never inflate the figure).
   */
  async listActiveMembers(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly AdoptionMemberRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: memberships.organizationId, userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, context.organizationId),
          eq(memberships.status, 'active'),
        ),
      );
  }

  /**
   * The owners of work items created within the window — tenant-scoped, owner present, not
   * soft-deleted. One row per matching item; the controller counts distinct owners, so a person who
   * created several items in the window is one adopting member, not several. The window is
   * `created_at >= now(3) - windowDays` in SQL.
   */
  async listRecentWorkOwners(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionWorkOwnerRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: workItems.organizationId, ownerUserId: workItems.ownerUserId })
      .from(workItems)
      .where(
        and(
          eq(workItems.organizationId, context.organizationId),
          isNotNull(workItems.ownerUserId),
          isNull(workItems.deletedAt),
          gte(workItems.createdAt, sql`date_sub(now(3), interval ${windowDays} day)`),
        ),
      );
  }

  /**
   * The meetings held within the window — tenant-scoped, `starts_at` in `[now(3) - windowDays,
   * now(3)]`. A meeting scheduled in the future has not been held and is excluded by the upper
   * bound. One row per meeting; the controller counts them.
   */
  async listMeetingsHeld(
    runner: TenantQueryRunner,
    context: TenantContext,
    windowDays: number,
  ): Promise<readonly AdoptionMeetingRow[]> {
    return tenantDrizzle(runner)
      .select({ organizationId: meetings.organizationId, meetingId: meetings.id })
      .from(meetings)
      .where(
        and(
          eq(meetings.organizationId, context.organizationId),
          gte(meetings.startsAt, sql`date_sub(now(3), interval ${windowDays} day)`),
          lte(meetings.startsAt, sql`now(3)`),
        ),
      );
  }
}
