import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { AuditChainRepository } from '../audit/audit-chain.repository.js';
import { AuditRetentionRepository } from './audit-retention.repository.js';
import { MIN_RETENTION_DAYS } from './audit-retention.service.js';

/**
 * 56-18 follow-up (SOC 2 C1.2, GDPR Art. 5(1)(e)) — the audit-log purge, made real but kept
 * conservative. The preview (`GET …/admin/audit-retention`) is unchanged; this is the background
 * half, run by the privacy job's pass (`privacy-job.ts`). No route reaches it.
 *
 * - **Only an explicit window.** Organizations are found from `audit_retention_policy` rows; a
 *   workspace that never set a window is never visited, and one below {@link MIN_RETENTION_DAYS}
 *   is skipped. The 0358 trigger holds the same two rules at the engine for every DELETE.
 * - **One tenant only.** Each organization is purged under its own service context; every
 *   statement names it, and the trigger reads each row's own organization's window.
 * - **Oldest first, contiguous.** Chained rows go in `chain_seq` order up to the last position whose
 *   whole prefix is older than the cutoff, and every batch moves the head's purge boundary in the
 *   same transaction, so the integrity verifier starts after it (`ChainVerifier`).
 * - **Bounded.** {@link AuditPurgeOptions.batchRows} per transaction, at most
 *   {@link AuditPurgeOptions.maxRowsPerRun} per organization per pass; the next pass carries on.
 * - **Recorded.** A pass that removed anything appends one `audit.purged` entry with the count, the
 *   cutoff and the window. A refusal (trigger, missing DELETE grant) rolls the batch back and is
 *   reported, never forced.
 */

export interface AuditPurgeOptions {
  readonly batchRows: number;
  readonly maxRowsPerRun: number;
}

export const DEFAULT_AUDIT_PURGE_OPTIONS: AuditPurgeOptions = {
  batchRows: 500,
  maxRowsPerRun: 20_000,
};

export interface AuditPurgeOutcome {
  /** Audit rows removed in this pass. */
  readonly deleted: number;
  /** The cutoff used, or null when the organization has no window (nothing was considered). */
  readonly cutoff: Date | null;
  /** Why the pass stopped early: `refused` (trigger), `not_permitted` (grant), or null. */
  readonly blocked: 'refused' | 'not_permitted' | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const POLICY_VERSION = 'audit-retention-purge';
const FIND_REASON =
  'finding which organizations set an audit-log retention window, so each one past its window is ' +
  'purged under its own service context (56-18, GDPR Art. 5(1)(e))';

const BLOCKING_ERRNOS: Readonly<Record<number, 'refused' | 'not_permitted'>> = {
  1644: 'refused', // ER_SIGNAL_EXCEPTION: the 0358 trigger refused a row
  1142: 'not_permitted', // ER_TABLEACCESS_DENIED_ERROR: the credential holds no DELETE here
};

function errnoOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const errno = (current as { errno?: unknown }).errno;
    if (typeof errno === 'number') return errno;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

class PurgeBlocked extends Error {
  constructor(readonly reason: 'refused' | 'not_permitted') {
    super(reason);
  }
}

export class AuditRetentionPurge {
  constructor(
    private readonly database: TenantDatabase,
    private readonly audit: Pick<AuditService, 'record'> | undefined,
    private readonly repository: AuditRetentionRepository = new AuditRetentionRepository(),
    private readonly chain: Pick<
      AuditChainRepository,
      'readHead' | 'recordPurgeBoundary'
    > = new AuditChainRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly options: AuditPurgeOptions = DEFAULT_AUDIT_PURGE_OPTIONS,
  ) {}

  /** One pass over every organization with a window; returns how many audit rows went in total. */
  async runAll(correlationId: string): Promise<number> {
    const organizations = await this.database.bootstrapRead(
      { correlationId, reason: FIND_REASON, tables: ['audit_retention_policy'] },
      (db) => this.repository.organizationsWithPolicy(db, MIN_RETENTION_DAYS),
    );
    let deleted = 0;
    for (const organizationId of organizations) {
      const context = createServiceContext({
        organizationId,
        correlationId: uuidv7(),
        policyVersion: POLICY_VERSION,
      });
      deleted += (await this.run(context)).deleted;
    }
    return deleted;
  }

  /** Purge one organization's audit rows past its own stored window. */
  async run(context: TenantContext): Promise<AuditPurgeOutcome> {
    const policy = await this.database.read(context, (runner) =>
      this.repository.find(runner, context),
    );
    if (!policy || policy.retentionDays < MIN_RETENTION_DAYS) {
      return { deleted: 0, cutoff: null, blocked: null };
    }
    const at = this.now();
    const cutoff = new Date(at.getTime() - policy.retentionDays * DAY_MS);
    let deleted = 0;
    let blocked: AuditPurgeOutcome['blocked'] = null;
    try {
      deleted += await this.purgeChained(context, cutoff, at);
      deleted += await this.purgeLegacy(context, cutoff, this.options.maxRowsPerRun - deleted);
    } catch (error) {
      if (!(error instanceof PurgeBlocked)) throw error;
      blocked = error.reason;
    }
    if (deleted > 0) await this.recordPurge(context, deleted, cutoff, policy.retentionDays);
    return { deleted, cutoff, blocked };
  }

  private async purgeChained(context: TenantContext, cutoff: Date, at: Date): Promise<number> {
    let deleted = 0;
    for (;;) {
      const limit = Math.min(this.options.batchRows, this.options.maxRowsPerRun - deleted);
      if (limit <= 0) return deleted;
      const count = await this.batch(context, async (tx) => {
        const head = await this.chain.readHead(tx, context);
        if (head === null) return 0;
        const throughSeq = await this.repository.purgeableThrough(tx, context, cutoff);
        const afterSeq = Number(head.purgedThroughSeq ?? 0);
        if (throughSeq <= afterSeq) return 0;
        const rows = await this.repository.chainedBatch(
          tx,
          context,
          { afterSeq, throughSeq, cutoff },
          limit,
        );
        const last = rows[rows.length - 1];
        if (last === undefined) return 0;
        const removed = await this.repository.deleteEvents(
          tx,
          context,
          rows.map((row) => row.id),
          cutoff,
        );
        // A row that did not go would leave a hole under the boundary: undo the whole batch.
        if (removed !== rows.length) throw new PurgeBlocked('refused');
        await this.chain.recordPurgeBoundary(tx, context, {
          chainSeq: last.chainSeq,
          rowHash: last.rowHash,
          at,
        });
        return removed;
      });
      deleted += count;
      if (count < limit) return deleted;
    }
  }

  private async purgeLegacy(context: TenantContext, cutoff: Date, budget: number): Promise<number> {
    let deleted = 0;
    for (;;) {
      const limit = Math.min(this.options.batchRows, budget - deleted);
      if (limit <= 0) return deleted;
      const count = await this.batch(context, async (tx) => {
        const ids = await this.repository.legacyBatch(tx, context, cutoff, limit);
        return this.repository.deleteEvents(tx, context, ids, cutoff);
      });
      deleted += count;
      if (count < limit) return deleted;
    }
  }

  /** One batch in its own transaction; a refusal by the engine becomes {@link PurgeBlocked}. */
  private async batch(
    context: TenantContext,
    work: (tx: TenantQueryRunner) => Promise<number>,
  ): Promise<number> {
    try {
      return await this.database.transaction(context, work);
    } catch (error) {
      if (error instanceof PurgeBlocked) throw error;
      const errno = errnoOf(error);
      const reason = errno === undefined ? undefined : BLOCKING_ERRNOS[errno];
      if (reason !== undefined) throw new PurgeBlocked(reason);
      throw error;
    }
  }

  private async recordPurge(
    context: TenantContext,
    deleted: number,
    cutoff: Date,
    retentionDays: number,
  ): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.audit?.record(tx, context, {
        action: 'audit.purged',
        objectId: context.organizationId,
        result: 'allowed',
        actorUserId: null,
        metadata: { deleted, cutoff: cutoff.toISOString(), retention_days: retentionDays },
      });
    });
  }
}
