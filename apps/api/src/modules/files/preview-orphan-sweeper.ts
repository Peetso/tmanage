import { uuidv7 } from '@tmanage/domain';
import type { ObjectStore } from '@tmanage/storage';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FilePreviewsRepository, OrphanPreview } from './file-previews.repository.js';
import type { PreviewUsageMeter } from './preview-usage.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * R4 follow-up — the orphan-preview sweep: SPEC R4 §5.4's "orphan-derivative sweep".
 *
 * A `file_previews` row outlives its source when the file asset is deleted, purged (FILE-003's
 * retention job removes a rejected object an `unscanned` preview was made of), rejected, or its
 * asset / version row is gone. Its bytes in the `derived` zone then serve nobody and still count
 * against the quota. One pass finds those rows in every organization and removes each:
 *
 * 1. the derived object is deleted first (idempotent — a re-run after a crash finds it gone);
 * 2. then, in one transaction, the row is deleted and, only when that delete took the row, its
 *    counted bytes are given back through the ledger ({@link PreviewUsageMeter.release}).
 *
 * The upload sweeper's shape: the cross-tenant half — which organizations hold an orphan — is a
 * `bootstrapRead` with its own reason, then each organization is swept under a service context
 * bound to it, in batches, until a batch removes nothing. A pending row a live preview pass holds
 * (claimed after the stale bound) is never taken. Runs hourly beside the reconciler in the one
 * Hostinger process (`apps/server/scheduled-sweeps.mjs`).
 */
export const PREVIEW_ORPHAN_SWEEPER = Symbol.for('tmanage.PreviewOrphanSweeper');

export const PREVIEW_ORPHAN_POLICY_VERSION = 'file-preview-orphan-sweep';

export const PREVIEW_ORPHAN_SCAN_REASON =
  'finding which organizations hold preview derivatives whose source file is deleted, purged, ' +
  'rejected or missing, so each can be swept under its own service context (R4 follow-up)';

/** Rows per organization per batch. */
export const PREVIEW_ORPHAN_BATCH_SIZE = 100;

const MAX_BATCHES_PER_ORGANIZATION = 50;

/** A pending row claimed more recently than this belongs to a live preview pass. */
export const PREVIEW_ORPHAN_CLAIM_STALE_MS = 15 * 60_000;

export interface OrphanSweepReport {
  readonly organizations: number;
  readonly scanned: number;
  /** Rows removed (object and row). */
  readonly removed: number;
  /** Bytes given back to the quota. */
  readonly releasedBytes: number;
  /** Rows another pass removed between selection and delete. */
  readonly skipped: number;
  /** Rows whose removal threw; logged, left for the next pass. */
  readonly failed: number;
  /** Removed rows whose counter refused the decrement. */
  readonly counterDrift: number;
}

export function orphanSweepContextFor(
  organizationId: string,
  correlationId: string,
): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: PREVIEW_ORPHAN_POLICY_VERSION,
  });
}

export class PreviewOrphanSweeper {
  constructor(
    private readonly database: TenantDatabase,
    private readonly previews: FilePreviewsRepository,
    private readonly store: ObjectStore,
    private readonly usage: PreviewUsageMeter,
    private readonly now: () => Date = () => new Date(),
    private readonly onFailure: (previewId: string, error: unknown) => void = (id, error) =>
      console.error(`[preview-orphans] removing preview ${id} failed`, describeFailure(error)),
  ) {}

  /** One pass over every organization. Safe to run again at once: a second pass finds nothing. */
  async sweep(): Promise<OrphanSweepReport> {
    const correlationId = uuidv7();
    const staleBefore = new Date(this.now().getTime() - PREVIEW_ORPHAN_CLAIM_STALE_MS);
    const organizations = await this.database.bootstrapRead(
      {
        correlationId,
        reason: PREVIEW_ORPHAN_SCAN_REASON,
        tables: ['file_previews', 'file_assets', 'file_versions'],
      },
      (db) => this.previews.organizationsWithOrphans(db, staleBefore),
    );
    const tally = {
      scanned: 0,
      removed: 0,
      releasedBytes: 0,
      skipped: 0,
      failed: 0,
      counterDrift: 0,
    };
    for (const organizationId of organizations) {
      const context = orphanSweepContextFor(organizationId, correlationId);
      for (let batch = 0; batch < MAX_BATCHES_PER_ORGANIZATION; batch += 1) {
        const rows = await this.database.read(context, (db) =>
          this.previews.listOrphans(db, context, staleBefore, PREVIEW_ORPHAN_BATCH_SIZE),
        );
        tally.scanned += rows.length;
        let removedInBatch = 0;
        for (const row of rows) {
          try {
            const outcome = await this.remove(context, row);
            if (outcome === 'skipped') {
              tally.skipped += 1;
              continue;
            }
            tally.removed += 1;
            removedInBatch += 1;
            if (outcome === 'released') tally.releasedBytes += row.sizeBytes ?? 0;
            if (outcome === 'drift') tally.counterDrift += 1;
          } catch (error) {
            tally.failed += 1;
            this.onFailure(row.id, error);
          }
        }
        if (rows.length < PREVIEW_ORPHAN_BATCH_SIZE || removedInBatch === 0) break;
      }
    }
    return { organizations: organizations.length, ...tally };
  }

  private async remove(
    context: TenantContext,
    row: OrphanPreview,
  ): Promise<'skipped' | 'released' | 'not_counted' | 'drift'> {
    // The bytes first, as FILE-003's purge: a delete that fails leaves the row (and the count).
    if (row.objectKey !== null) {
      await this.store.remove({ zone: 'derived', objectKey: row.objectKey });
    }
    return this.database.transaction(context, async (tx) => {
      const deleted = await this.previews.deleteByIds(tx, context, [row.id]);
      if (deleted !== 1) return 'skipped';
      return this.usage.release(tx, context, row);
    });
  }
}

/** The one line a pass prints. */
export function describeOrphanSweep(report: OrphanSweepReport): string {
  return (
    `scanned ${report.scanned}, removed ${report.removed}, released ${report.releasedBytes} byte(s), ` +
    `skipped ${report.skipped}, failed ${report.failed}` +
    (report.counterDrift > 0 ? `, ${report.counterDrift} with counter drift` : '') +
    ` (${report.organizations} organization(s))`
  );
}
