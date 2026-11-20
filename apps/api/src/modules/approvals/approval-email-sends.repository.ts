import { and, desc, eq, inArray } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvalEmailSends } from '../../common/database/schema.js';
import type { ApprovalEmailSendRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * QA-FIX-O H1 — the one file holding a driver handle for `approval_email_sends` (0387, TENANT).
 *
 * The API only ever inserts `queued` rows (one per approver per send, in the transaction that
 * writes the `approval.requested.v1` outbox event) and reads them back for the deliverable page.
 * Settling a row is the worker's alone (`approval-email-send-store.ts`).
 */

export interface NewApprovalEmailSend {
  readonly id: string;
  readonly approvalId: string;
  readonly sendId: string;
  readonly recipientUserId: string;
  readonly requestedByUserId: string;
  readonly createdAt: Date;
}

/** At most this many rows are read per page: a resend is rate-limited, so far fewer exist. */
const MAX_ROWS = 200;

export class ApprovalEmailSendsRepository {
  async insertQueued(
    runner: TenantQueryRunner,
    context: TenantContext,
    rows: readonly NewApprovalEmailSend[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await tenantDrizzle(runner)
      .insert(approvalEmailSends)
      .values(
        rows.map((row) => ({
          ...row,
          organizationId: context.organizationId,
          state: 'queued' as const,
          cause: null,
          settledAt: null,
        })),
      );
  }

  /** The rows of these approvals, newest first. */
  async listForApprovals(
    runner: TenantQueryRunner,
    context: TenantContext,
    approvalIds: readonly string[],
  ): Promise<readonly ApprovalEmailSendRow[]> {
    if (approvalIds.length === 0) return [];
    return tenantDrizzle(runner)
      .select()
      .from(approvalEmailSends)
      .where(
        and(
          eq(approvalEmailSends.organizationId, context.organizationId),
          inArray(approvalEmailSends.approvalId, [...approvalIds]),
        ),
      )
      .orderBy(desc(approvalEmailSends.createdAt), desc(approvalEmailSends.id))
      .limit(MAX_ROWS);
  }
}
