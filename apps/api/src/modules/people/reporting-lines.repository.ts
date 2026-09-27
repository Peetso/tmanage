import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberReportingLines } from '../../common/database/schema.js';
import type { MemberReportingLineRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The reporting-lines repository — a member's manager (People module 14, org chart, x217).
 *
 * It owns the tenant-scoped reporting-line row: at most one active row per member, keyed by
 * `(organization_id, member_id)`, whose `manager_member_id` is the member they report to. The set of
 * rows is the edge set of the tenant's reporting tree. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md`
 * §6 is honoured structurally, exactly as the capacity repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link SetReportingLineInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 */

/** What the controller upserts. No `organizationId` — it comes from the context. */
export interface SetReportingLineInput {
  /** The member whose reporting line is being set — resolved tenant-scoped by the controller. */
  readonly memberId: string;
  /** The manager they report to — resolved tenant-scoped by the controller. */
  readonly managerMemberId: string;
}

export class ReportingLinesRepository {
  /**
   * Fetch one member's current reporting line, within the acting tenant.
   *
   * A cross-tenant member id resolves to null here, which is what the controller turns into a 404.
   */
  async findByMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberId: string,
  ): Promise<MemberReportingLineRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(memberReportingLines)
      .where(
        and(
          eq(memberReportingLines.organizationId, context.organizationId),
          eq(memberReportingLines.memberId, memberId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Every reporting line in the acting tenant — the edge set the org chart draws, and the set the
   * controller walks to detect a cycle before a write. Scoped to the tenant like every read here is.
   */
  async listAll(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly MemberReportingLineRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(memberReportingLines)
      .where(eq(memberReportingLines.organizationId, context.organizationId));
  }

  /**
   * Set (create or replace) a member's manager within the acting tenant, then read it back.
   *
   * A single `INSERT ... ON DUPLICATE KEY UPDATE` against the `(organization_id, member_id)` natural
   * key: a first set INSERTs, a later revision UPDATEs the manager in place — one active row per
   * member. The `set` clause never assigns `organization_id` or `member_id` (the tenant guard rejects a
   * tenant-key assignment, and the 0095 trigger pins them immutable), so a revision cannot move a row
   * across a tenant or onto another member. `organization_id` comes from the context, never `input`.
   */
  async set(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: SetReportingLineInput,
  ): Promise<MemberReportingLineRow> {
    const db = tenantDrizzle(runner);
    await db
      .insert(memberReportingLines)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        memberId: input.memberId,
        managerMemberId: input.managerMemberId,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          managerMemberId: input.managerMemberId,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    const row = await this.findByMember(runner, context, input.memberId);
    if (!row) {
      // Unreachable: the upsert above wrote the row this reads back within the same transaction.
      throw new Error('member_reporting_lines row vanished immediately after upsert');
    }
    return row;
  }

  /**
   * Clear a member's reporting line within the acting tenant. Idempotent: clearing a member with no
   * line deletes nothing and is not an error. Scoped by `(organization_id, member_id)`, so it can only
   * ever remove this tenant's own row.
   */
  async clear(runner: TenantQueryRunner, context: TenantContext, memberId: string): Promise<void> {
    const db = tenantDrizzle(runner);
    await db
      .delete(memberReportingLines)
      .where(
        and(
          eq(memberReportingLines.organizationId, context.organizationId),
          eq(memberReportingLines.memberId, memberId),
        ),
      );
  }
}
