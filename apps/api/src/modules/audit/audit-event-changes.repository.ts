import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { auditEventChanges } from '../../common/database/schema.js';
import type { AuditEventChangeRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { redactChanges } from './audit-redaction.js';
import type { AuditChangeInput } from './audit-redaction.js';

/**
 * `audit_event_changes` (0241) — the before/after rows of one org audit event.
 *
 * Tenant-owned and INSERT-only for the app, like `audit_events`: written in the same transaction
 * as the event it describes, read back only through the tenant path for one organization (the
 * C2 detail drawer). Every value has been through {@link redactChanges} before it gets here.
 */
export class AuditEventChangesRepository {
  /** Insert the redacted rows for one event. Returns how many were written. */
  async appendFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    auditEventId: string,
    changes: readonly AuditChangeInput[],
  ): Promise<number> {
    const rows = redactChanges(changes);
    if (rows.length === 0) return 0;
    await tenantDrizzle(runner)
      .insert(auditEventChanges)
      .values(
        rows.map((row) => ({
          id: uuidv7(),
          organizationId: context.organizationId,
          auditEventId,
          field: row.field,
          beforeValue: row.before,
          afterValue: row.after,
          redacted: row.redacted,
          createdAt: sql`current_timestamp(3)`,
        })),
      );
    return rows.length;
  }

  async listFor(
    runner: TenantQueryRunner,
    context: TenantContext,
    auditEventId: string,
  ): Promise<readonly AuditEventChangeRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(auditEventChanges)
      .where(
        and(
          eq(auditEventChanges.organizationId, context.organizationId),
          eq(auditEventChanges.auditEventId, auditEventId),
        ),
      )
      .orderBy(asc(auditEventChanges.id));
  }
}
