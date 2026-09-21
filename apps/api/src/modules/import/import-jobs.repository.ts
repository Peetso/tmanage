import { and, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { importJobs } from '../../common/database/schema.js';
import type { ImportJobRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The `import_jobs` repository — ON-09's durable anchor, written the way every scoped
 * repository is (`ProjectsRepository` is the pattern):
 *
 * - every method's first parameter is a `TenantContext`, so there is no unscoped read or write;
 * - `organization_id` is taken from the context, never from the input — {@link CreateImportJobInput}
 *   has no field for it, so a caller cannot choose the tenant it writes into;
 * - the tenant predicate is on every statement.
 */

/**
 * What a caller supplies to record a validation attempt. No `organizationId`: it comes from the
 * context. The counts and status are the report's own — the service does not recompute them here.
 */
export interface CreateImportJobInput {
  readonly createdByUserId: string;
  readonly sourceKind: string;
  readonly status: string;
  readonly totalCount: number;
  readonly validCount: number;
  readonly invalidCount: number;
}

/**
 * The commit half's terminal transition. `status` moves to `committed` /
 * `committed_with_errors`, and the receipt summary (`committedAt`, `committedCount`,
 * `failedCount`) is stamped in the same statement. No `organizationId`: it is the tenant
 * predicate, not a value the caller supplies.
 */
export interface CommitImportJobInput {
  readonly status: string;
  readonly committedCount: number;
  readonly failedCount: number;
}

export class ImportJobsRepository {
  /** Record one import attempt and read it back with its server-generated timestamp. */
  async create(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CreateImportJobInput,
  ): Promise<ImportJobRow> {
    const db = tenantDrizzle(runner);
    const id = uuidv7();

    await db.insert(importJobs).values({
      id,
      // From the context. Not from `input` — there is no such field.
      organizationId: context.organizationId,
      createdByUserId: input.createdByUserId,
      sourceKind: input.sourceKind,
      status: input.status,
      totalCount: input.totalCount,
      validCount: input.validCount,
      invalidCount: input.invalidCount,
      createdAt: sql`current_timestamp(3)`,
    });

    return this.requireById(runner, context, id);
  }

  /** One job by id, within the acting tenant. A job of another tenant reads as `null`. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<ImportJobRow | null> {
    const db = tenantDrizzle(runner);
    const rows = await db
      .select()
      .from(importJobs)
      .where(and(eq(importJobs.organizationId, context.organizationId), eq(importJobs.id, id)))
      .limit(1);
    return rows[0] ?? null;
  }

  async requireById(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
  ): Promise<ImportJobRow> {
    const found = await this.findById(runner, context, id);
    if (!found) throw new Error(`Import job ${id} was not found`);
    return found;
  }

  /**
   * Transition a validated job to its terminal committed state, within the acting tenant.
   *
   * The `status IS NULL`-style guard is a status predicate, not an existence one: the update
   * only touches a job whose current `status` is one of the validate-half outcomes, so a job
   * that has already been committed matches zero rows and the caller learns it cannot be
   * committed twice. The tenant predicate is on the statement, so a job of another tenant
   * matches nothing here either.
   */
  async markCommitted(
    runner: TenantQueryRunner,
    context: TenantContext,
    id: string,
    input: CommitImportJobInput,
  ): Promise<ImportJobRow> {
    const db = tenantDrizzle(runner);

    const result = await db
      .update(importJobs)
      .set({
        status: input.status,
        committedCount: input.committedCount,
        failedCount: input.failedCount,
        committedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(importJobs.organizationId, context.organizationId),
          eq(importJobs.id, id),
          // Only a job still in a validate-half state can be committed. An already-committed
          // job (status 'committed' / 'committed_with_errors') matches nothing.
          sql`${importJobs.status} in ('validated', 'validated_with_errors')`,
        ),
      );

    if (result[0].affectedRows === 0) {
      throw new Error(`Import job ${id} is not in a committable state`);
    }

    return this.requireById(runner, context, id);
  }
}
