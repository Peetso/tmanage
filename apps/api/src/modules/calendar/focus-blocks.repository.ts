import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { focusBlocks } from '../../common/database/schema.js';
import type { FocusBlockRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * CAL-04 focus blocks (x255) — a membership's own protected time over `focus_blocks` rows. It owns the
 * block insert, the self-scoped delete, and the newest-window-first list of a membership's blocks. It
 * follows the `doc_bookmarks` repository (x242) pattern and honours `25-AUTH` §6 structurally:
 *
 * 1. **No unscoped read/write.** Every method's first two parameters are the `TenantQueryRunner` and
 *    the `TenantContext`.
 * 2. **The tenant comes from the context, never the DTO.** {@link CreateFocusBlockInput} has no
 *    `organizationId`.
 * 3. **The tenant predicate is on every statement**, executed through the guard (`drizzle.ts`).
 *
 * The runner is a parameter, not a field: the service composes the resolve-then-delete on one
 * connection inside one transaction `TenantDatabase.transaction()` owns.
 */

/** What the service inserts. No `organizationId` (from the context). */
export interface CreateFocusBlockInput {
  /** The owning membership — the service passes `context.membershipId`. */
  readonly membershipId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly title: string;
}

/** A membership's blocks list is bounded so a wide window can never return an unbounded result. */
const MAX_FOCUS_BLOCKS_LISTED = 500;

export class FocusBlocksRepository {
  /** Fetch one block by id, scoped to the acting tenant AND the acting membership, or null. */
  async findOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    membershipId: string,
  ): Promise<FocusBlockRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(focusBlocks)
      .where(
        and(
          eq(focusBlocks.organizationId, context.organizationId),
          eq(focusBlocks.id, id),
          eq(focusBlocks.membershipId, membershipId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Create a focus block for a membership; returns the stored row. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateFocusBlockInput,
  ): Promise<FocusBlockRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();
    await db.insert(focusBlocks).values({
      id,
      organizationId: context.organizationId,
      membershipId: input.membershipId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      title: input.title,
      createdAt: new Date(),
    });
    const inserted = await this.findOwn(runner, context, id, input.membershipId);
    return inserted as FocusBlockRow;
  }

  /**
   * Delete one of a membership's blocks, scoped to the acting tenant and membership. Returns whether a
   * row was removed, so the service can answer 404 when the id names another member's block or none.
   */
  async deleteOwn(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    membershipId: string,
  ): Promise<boolean> {
    const existing = await this.findOwn(runner, context, id, membershipId);
    if (!existing) {
      return false;
    }
    const db = tenantDrizzle(runner);
    await db
      .delete(focusBlocks)
      .where(
        and(
          eq(focusBlocks.organizationId, context.organizationId),
          eq(focusBlocks.id, id),
          eq(focusBlocks.membershipId, membershipId),
        ),
      );
    return true;
  }

  /**
   * List one membership's blocks that start within `[from, to)`, earliest first, id breaking ties.
   * Scoped to the acting tenant and membership; bounded.
   */
  async listForMember(
    runner: TenantQueryRunner,
    context: TenantContext,
    membershipId: string,
    from: Date,
    to: Date,
  ): Promise<readonly FocusBlockRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(focusBlocks)
      .where(
        and(
          eq(focusBlocks.organizationId, context.organizationId),
          eq(focusBlocks.membershipId, membershipId),
          gte(focusBlocks.startsAt, from),
          lt(focusBlocks.startsAt, to),
        ),
      )
      .orderBy(asc(focusBlocks.startsAt), asc(focusBlocks.id))
      .limit(MAX_FOCUS_BLOCKS_LISTED);
  }
}
