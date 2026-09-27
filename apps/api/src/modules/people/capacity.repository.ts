import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { personCapacity } from '../../common/database/schema.js';
import type { PersonCapacityRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The people-capacity repository — per-member weekly capacity (People module 14, x170).
 *
 * It owns the tenant-scoped capacity row: one active row per member, keyed by
 * `(organization_id, membership_id)`. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured
 * structurally, exactly as the work-forms repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link SetCapacityInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 */

/** What the controller upserts. No `organizationId` — it comes from the context. */
export interface SetCapacityInput {
  /** The member whose capacity is being set — resolved tenant-scoped by the controller. */
  readonly membershipId: string;
  readonly weeklyHours: number;
  /** An ISO-8601 date (`YYYY-MM-DD`) — the day the figure takes effect. */
  readonly effectiveFrom: string;
}

export class PersonCapacityRepository {
  /**
   * Fetch one member's current capacity, within the acting tenant.
   *
   * No `findByMembership(id)` without a context: on MySQL that would return another customer's row.
   * A cross-tenant membership id resolves to null here, which is what the controller turns into a 404.
   */
  async findByMembership(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
  ): Promise<PersonCapacityRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(personCapacity)
      .where(
        and(
          eq(personCapacity.organizationId, context.organizationId),
          eq(personCapacity.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Set (create or replace) a member's capacity within the acting tenant, then read it back.
   *
   * A single `INSERT ... ON DUPLICATE KEY UPDATE` against the `(organization_id, membership_id)`
   * natural key: a first set INSERTs, a later revision UPDATEs in place — one active row per member.
   * The `set` clause never assigns `organization_id` or `membership_id` (the tenant guard rejects a
   * tenant-key assignment, and the 0068 trigger pins them immutable), so a revision cannot move a row
   * across a tenant or onto another member. `organization_id` comes from the context, never `input`.
   */
  async set(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: SetCapacityInput,
  ): Promise<PersonCapacityRow> {
    const db = tenantDrizzle(runner);
    await db
      .insert(personCapacity)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        membershipId: input.membershipId,
        weeklyHours: input.weeklyHours,
        effectiveFrom: input.effectiveFrom,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({
        set: {
          weeklyHours: input.weeklyHours,
          effectiveFrom: input.effectiveFrom,
          updatedAt: sql`current_timestamp(3)`,
        },
      });

    const row = await this.findByMembership(runner, context, input.membershipId);
    if (!row) {
      // Unreachable: the upsert above wrote the row this reads back within the same transaction.
      throw new Error('person_capacity row vanished immediately after upsert');
    }
    return row;
  }
}
