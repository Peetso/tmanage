import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { importRows } from '../../common/database/schema.js';
import type { ImportRowRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The `import_rows` repository — ON-09's per-row receipt (ADM-10 "receipt" at row granularity),
 * written the way every scoped repository is (`ImportJobsRepository` / `ProjectsRepository` are
 * the pattern):
 *
 * - every method's first parameter is a `TenantContext`, so there is no unscoped read or write;
 * - `organization_id` is taken from the context, never from the input — {@link CreateImportRowInput}
 *   has no field for it, so a caller cannot choose the tenant it writes into;
 * - the tenant predicate is on every statement.
 *
 * A receipt is written inside the commit's transaction, so the id is generated here (like
 * `ProjectsRepository.create`) rather than by the database.
 */

/** The per-row outcome vocabulary. `created` — the entity was created; `failed` — it was not. */
export type ImportRowOutcome = 'created' | 'failed';

/**
 * What a caller supplies to record one receipt row. No `organizationId`: it comes from the
 * context. `jobId` is the parent import job; the composite foreign key binds the pair to one
 * tenant.
 */
export interface CreateImportRowInput {
  readonly jobId: string;
  readonly sourceIndex: number;
  readonly outcome: ImportRowOutcome;
  /** The created entity id for a `created` row; omitted / null for a `failed` row. */
  readonly createdEntityId?: string | null;
  /** The error that stopped a `failed` row; omitted / null for a `created` row. */
  readonly errorDetail?: string | null;
  /**
   * R23-e (0316): the kind of `createdEntityId` (`project` | `work_item` | `document` | `phase` |
   * `label`) — what the undo reads to delete it. Omitted / null for a `failed` row.
   */
  readonly entityType?: string | null;
}

export class ImportRowsRepository {
  /** Record one receipt row within the acting tenant. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateImportRowInput,
  ): Promise<ImportRowRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(importRows).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      jobId: input.jobId,
      sourceIndex: input.sourceIndex,
      outcome: input.outcome,
      createdEntityId: input.createdEntityId ?? null,
      errorDetail: input.errorDetail ?? null,
      entityType: input.entityType ?? null,
      createdAt: sql`current_timestamp(3)`,
    });

    return this.requireById(runner, context, id);
  }

  /** One receipt row by id, within the acting tenant. Another tenant's row reads as `null`. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<ImportRowRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(importRows)
      .where(and(eq(importRows.organizationId, context.organizationId), eq(importRows.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<ImportRowRow> {
    const found = await this.findById(runner, context, id);
    if (!found) throw new Error(`Import row ${id} was not found`);
    return found;
  }

  /** One job's receipt (with each row's `entityType`), in source order, within the acting tenant. */
  async listByJob(
    runner: TenantQueryRunner,
    context: TenantContext,
    jobId: string,
  ): Promise<readonly ImportRowRow[]> {
    const db = tenantDrizzle(runner);
    return db
      .select()
      .from(importRows)
      .where(
        and(eq(importRows.organizationId, context.organizationId), eq(importRows.jobId, jobId)),
      )
      .orderBy(asc(importRows.sourceIndex));
  }
}
