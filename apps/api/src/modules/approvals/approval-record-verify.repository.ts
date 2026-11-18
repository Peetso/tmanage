import { and, eq } from 'drizzle-orm';
import type { RowDataPacket } from 'mysql2';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvalRecords, organizations } from '../../common/database/schema.js';
import type { ApprovalRecordRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';

/**
 * 52-19 (web half) — the public verify check's reads. SELECT only.
 *
 * The single unscoped read is {@link findRecordForVerify}: a stranger has no session, so the
 * record ID is looked up on `bootstrapRead` with `approval_records` as its only table, and it
 * returns the organization and the stored hash only. Everything shown afterwards is re-read inside
 * that organization's scope.
 */

export interface RecordVerifyLookup {
  readonly organizationId: string;
  readonly recordHash: string;
}

export type FindRecordForVerify = (
  recordId: string,
  correlationId: string,
) => Promise<RecordVerifyLookup | null>;

export function findRecordForVerify(database: TenantDatabase): FindRecordForVerify {
  return async (recordId, correlationId) => {
    const rows = await database.bootstrapRead(
      {
        correlationId,
        reason:
          'the public approval-record check has no session: finding the one record a printed ' +
          'record ID names, to compare its hash and learn the organization later reads are scoped to',
        tables: ['approval_records'],
      },
      (runner) =>
        runner.query<RowDataPacket[]>(
          'select organization_id, record_hash from approval_records where id = ? limit 1',
          [recordId],
        ),
    );
    const row = rows[0];
    return row
      ? { organizationId: String(row['organization_id']), recordHash: String(row['record_hash']) }
      : null;
  };
}

export class ApprovalRecordVerifyRepository {
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    recordId: string,
  ): Promise<ApprovalRecordRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(approvalRecords)
      .where(
        and(
          eq(approvalRecords.organizationId, context.organizationId),
          eq(approvalRecords.id, recordId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async organizationName(runner: TenantQueryRunner, context: TenantContext): Promise<string> {
    const rows = await tenantDrizzle(runner)
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, context.organizationId))
      .limit(1);
    return rows[0]?.name ?? '';
  }
}
