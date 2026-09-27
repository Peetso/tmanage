import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { workBoardColumns } from '../../common/database/schema.js';
import type { WorkBoardColumnRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * Work board columns — x308's storage half (Work module 7).
 *
 * An org-scoped, ordered list of board columns (see `0176_work_board_columns.sql`). Every read and
 * write is bound to `(organization_id, …)`, so a caller in the wrong tenant sees nothing rather
 * than a leak, and the repository holds no policy — the service decides who may read or write, and
 * resolves a column by `(organization_id, id)` before it authorizes a write, so a cross-tenant id
 * is a non-existent row rather than a leak.
 */

/** The largest column page a single read returns; a board has far fewer, but the bound is explicit. */
export const MAX_BOARD_COLUMNS_PAGE = 200;

export interface CreateBoardColumnInput {
  readonly label: string;
  readonly stateKey: string;
  readonly position: number;
}

export interface UpdateBoardColumnInput {
  readonly label: string;
  readonly stateKey: string;
  readonly position: number;
}

export class WorkBoardColumnsRepository {
  /** The tenant's board columns, position-ascending, bounded to one page. */
  async list(
    runner: TenantQueryRunner,
    context: TenantContext,
    limit: number = MAX_BOARD_COLUMNS_PAGE,
  ): Promise<readonly WorkBoardColumnRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(workBoardColumns)
      .where(eq(workBoardColumns.organizationId, context.organizationId))
      .orderBy(asc(workBoardColumns.position), asc(workBoardColumns.id))
      .limit(Math.min(Math.max(1, Math.trunc(limit)), MAX_BOARD_COLUMNS_PAGE));
  }

  /** One column, scoped to the tenant; `null` if absent (or if the id names another studio's row). */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<WorkBoardColumnRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workBoardColumns)
      .where(
        and(
          eq(workBoardColumns.organizationId, context.organizationId),
          eq(workBoardColumns.id, id),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** A column occupying this slot in the tenant; `null` if the slot is free. */
  async findByPosition(
    runner: TenantQueryRunner,
    context: TenantContext,
    position: number,
  ): Promise<WorkBoardColumnRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(workBoardColumns)
      .where(
        and(
          eq(workBoardColumns.organizationId, context.organizationId),
          eq(workBoardColumns.position, position),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /** Define a column. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateBoardColumnInput,
  ): Promise<WorkBoardColumnRow> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(workBoardColumns)
      .values({
        id,
        organizationId: context.organizationId,
        label: input.label,
        stateKey: input.stateKey,
        position: input.position,
        createdAt: sql`current_timestamp(3)`,
      });

    const created = await this.findById(runner, context, id);
    if (!created) {
      // Unreachable: the insert above committed this row in this transaction.
      throw new Error('board column vanished immediately after insert');
    }
    return created;
  }

  /** Rewrite a column's label / state key / position in place. */
  async update(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: UpdateBoardColumnInput,
  ): Promise<WorkBoardColumnRow> {
    await tenantDrizzle(runner)
      .update(workBoardColumns)
      .set({ label: input.label, stateKey: input.stateKey, position: input.position })
      .where(
        and(
          eq(workBoardColumns.organizationId, context.organizationId),
          eq(workBoardColumns.id, id),
        ),
      );

    const updated = await this.findById(runner, context, id);
    if (!updated) {
      // Unreachable: the caller resolved this row in this transaction before updating it.
      throw new Error('board column vanished immediately after update');
    }
    return updated;
  }

  /** Remove a column. `true` if a row was removed. */
  async delete(runner: TenantQueryRunner, context: TenantContext, id: string): Promise<boolean> {
    const existing = await this.findById(runner, context, id);
    if (!existing) return false;
    await tenantDrizzle(runner)
      .delete(workBoardColumns)
      .where(
        and(
          eq(workBoardColumns.organizationId, context.organizationId),
          eq(workBoardColumns.id, id),
        ),
      );
    return true;
  }
}
