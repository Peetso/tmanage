import { and, asc, eq } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { memberAvailability } from '../../common/database/schema.js';
import type { MemberAvailabilityRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The member-availability repository — per-member out-of-office windows (People module 14, x218).
 *
 * It owns the tenant-scoped window rows: a *list* keyed by `(organization_id, member_id)`, unlike the
 * one-row-per-member capacity table. `25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §6 is honoured
 * structurally, the way every sibling repository honours it:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` for
 *    the current unit of work and the `TenantContext`. There is no overload without a context.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateAvailabilityInput} has no
 *    `organizationId`, so a request body cannot choose the tenant it writes into.
 * 3. **The tenant predicate is on every statement**, built with Drizzle and executed through the
 *    guard (`drizzle.ts`), so a forgotten predicate throws rather than leaking rows.
 *
 * A window is added (INSERT) and removed (DELETE), never edited — the 0096 trigger pins rows immutable
 * and the runtime credential holds no UPDATE.
 */

/** What the controller inserts. No `organizationId` — it comes from the context. */
export interface CreateAvailabilityInput {
  /** The member whose window this is — the acting principal's membership, never a body value. */
  readonly memberId: string;
  /** Inclusive window bounds, ISO-8601 dates (`YYYY-MM-DD`); the controller enforces start ≤ end. */
  readonly startDate: string;
  readonly endDate: string;
  /** A value from the fixed `AVAILABILITY_KINDS` allowlist — the controller validates it. */
  readonly kind: string;
  readonly note: string | null;
}

export class MemberAvailabilityRepository {
  /**
   * List one member's windows within the acting tenant, in start-date (then id) order.
   *
   * No listing without a context: on MySQL that would return other studios' windows. A cross-tenant
   * member id resolves to an empty list here.
   */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberId: string,
  ): Promise<MemberAvailabilityRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(memberAvailability)
      .where(
        and(
          eq(memberAvailability.organizationId, context.organizationId),
          eq(memberAvailability.memberId, memberId),
        ),
      )
      .orderBy(asc(memberAvailability.startDate), asc(memberAvailability.id));
  }

  /** Fetch one window by id within the acting tenant (used to read back an insert). */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<MemberAvailabilityRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(memberAvailability)
      .where(
        and(
          eq(memberAvailability.organizationId, context.organizationId),
          eq(memberAvailability.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Insert a window within the acting tenant, then read it back. `organization_id` comes from the
   * context, never `input`; the `(organization_id, member_id)` composite FK refuses a member of
   * another studio at the engine, the other half of the controller's cross-tenant guard.
   */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateAvailabilityInput,
  ): Promise<MemberAvailabilityRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(memberAvailability).values({
      id,
      organizationId: context.organizationId,
      memberId: input.memberId,
      startDate: input.startDate,
      endDate: input.endDate,
      kind: input.kind,
      note: input.note,
      createdAt: new Date(),
    });
    const row = await this.findById(runner, context, id);
    if (!row) {
      // Unreachable: the insert above wrote the row this reads back within the same transaction.
      throw new Error(`member_availability ${id} vanished immediately after insert`);
    }
    return row;
  }

  /**
   * Remove a window, scoped to the acting tenant and the owning member. Returns whether a row was
   * removed, so the controller can 404 an id that is unknown, cross-tenant, or another member's with
   * no write having happened — a member deletes only their own windows.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    memberId: string,
    id: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .delete(memberAvailability)
      .where(
        and(
          eq(memberAvailability.organizationId, context.organizationId),
          eq(memberAvailability.memberId, memberId),
          eq(memberAvailability.id, id),
        ),
      );
    return result[0].affectedRows > 0;
  }
}
