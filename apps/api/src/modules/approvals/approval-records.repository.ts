import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { approvalRecords } from '../../common/database/schema.js';
import type { ApprovalRecordRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import { recordGenesisHash, sealRecord } from './approval-records.js';
import type { ApprovalEvidence } from './approval-records.js';
import type { AnchorSigner } from '../audit/audit-anchor-signer.js';

/**
 * 0349 (52-19) — the approval records' storage. INSERT and SELECT only, matching the grant: a
 * record is never updated or deleted by the API. Every query carries the context's tenant.
 */

const ER_DUP_ENTRY = 1062;
const ER_LOCK_DEADLOCK = 1213;

/** Two decisions in one organization raced for the same chain position; the loser rolls back. */
export class ApprovalRecordRaceError extends Error {
  constructor() {
    super('Another approval record took this chain position');
    this.name = 'ApprovalRecordRaceError';
  }
}

function isRace(error: unknown): boolean {
  const marks = (candidate: unknown): boolean => {
    if (typeof candidate !== 'object' || candidate === null) return false;
    const errno = (candidate as { errno?: number }).errno;
    return errno === ER_DUP_ENTRY || errno === ER_LOCK_DEADLOCK;
  };
  return (
    marks(error) ||
    (typeof error === 'object' && error !== null && marks((error as { cause?: unknown }).cause))
  );
}

export class ApprovalRecordsRepository {
  /**
   * Seal and append the organization's next record, inside the caller's transaction. The last
   * record is read `FOR UPDATE`, so a concurrent decision waits for this one; when two first
   * records race on an empty chain the unique `(organization_id, record_no)` refuses the second.
   */
  async append(
    runner: TenantQueryRunner,
    context: TenantContext,
    evidence: Omit<ApprovalEvidence, 'recordNo' | 'previousRecordHash' | 'organizationId'>,
    signer: AnchorSigner,
  ): Promise<ApprovalRecordRow> {
    const db = tenantDrizzle(runner);
    try {
      const last = await db
        .select({ recordNo: approvalRecords.recordNo, recordHash: approvalRecords.recordHash })
        .from(approvalRecords)
        .where(eq(approvalRecords.organizationId, context.organizationId))
        .orderBy(desc(approvalRecords.recordNo))
        .limit(1)
        .for('update');
      const previous = last[0];
      const sealed = sealRecord(
        {
          ...evidence,
          organizationId: context.organizationId,
          recordNo: previous === undefined ? 1 : previous.recordNo + 1,
          previousRecordHash:
            previous === undefined
              ? recordGenesisHash(context.organizationId)
              : previous.recordHash,
        },
        signer,
      );
      const row: ApprovalRecordRow = {
        id: uuidv7(),
        organizationId: context.organizationId,
        approvalId: sealed.evidence.approvalId,
        deliverableVersionId: sealed.evidence.deliverableVersionId,
        recordNo: sealed.evidence.recordNo,
        approverUserId: sealed.evidence.approver.userId,
        approverKind: sealed.evidence.approver.kind,
        decision: sealed.evidence.decision,
        recordJson: sealed.recordJson,
        recordHash: sealed.recordHash,
        previousRecordHash: sealed.evidence.previousRecordHash,
        signature: sealed.signature,
        createdAt: new Date(),
      };
      await db.insert(approvalRecords).values(row);
      return row;
    } catch (error) {
      if (isRace(error)) throw new ApprovalRecordRaceError();
      throw error;
    }
  }

  /** One approval's records, in chain order. */
  async listByApproval(
    runner: TenantQueryRunner,
    context: TenantContext,
    approvalId: string,
  ): Promise<readonly ApprovalRecordRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(approvalRecords)
      .where(
        and(
          eq(approvalRecords.organizationId, context.organizationId),
          eq(approvalRecords.approvalId, approvalId),
        ),
      )
      .orderBy(asc(approvalRecords.recordNo));
  }

  /** The stored hash of each named chain position that exists, keyed by `record_no`. */
  async hashesByNumber(
    runner: TenantQueryRunner,
    context: TenantContext,
    recordNos: readonly number[],
  ): Promise<ReadonlyMap<number, string>> {
    if (recordNos.length === 0) return new Map();
    const rows = await tenantDrizzle(runner)
      .select({ recordNo: approvalRecords.recordNo, recordHash: approvalRecords.recordHash })
      .from(approvalRecords)
      .where(
        and(
          eq(approvalRecords.organizationId, context.organizationId),
          inArray(approvalRecords.recordNo, [...recordNos]),
        ),
      );
    return new Map(rows.map((r) => [r.recordNo, r.recordHash]));
  }
}
