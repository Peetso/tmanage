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
}
