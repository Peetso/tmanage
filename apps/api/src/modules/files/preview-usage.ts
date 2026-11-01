import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';
import type { OutboxEventsRepository } from '../platform/outbox-events.repository.js';
import { STORAGE_BYTES_METRIC } from './usage-counters.repository.js';
import type { UsageCountersRepository } from './usage-counters.repository.js';
import { USAGE_LEDGER_REASON } from './usage-ledger.repository.js';
import type { UsageLedgerRepository } from './usage-ledger.repository.js';
import type { FilePreviewsRepository, OrphanPreview } from './file-previews.repository.js';

/**
 * R4 follow-up (SPEC R4 decision 13) — preview derivatives count against the organization's
 * storage quota, under the existing `storage.bytes` metric, through the usage ledger.
 *
 * Every move is the upload path's shape, in the caller's transaction: the counter moves, an
 * outbox event names the move, and a ledger row keyed on the `file_previews` row records it, so
 * the reconciler's ledger-vs-counter check stays whole.
 *
 * - **Counting only, never blocking.** {@link count} adds `used` with no limit in the predicate
 *   (`UsageCountersRepository.addUsed`): the file the derivative is made from already passed the
 *   quota on upload, and refusing its preview would leave the viewer empty while the original's
 *   bytes still count. A quota the previews filled refuses the *next* upload's reservation.
 * - **Once per row.** A count is skipped when the ledger already holds the row's
 *   `preview_derivative` move; a release only gives back bytes that were counted and not yet
 *   given back, so a derivative made before counting existed is never subtracted.
 * - **Bands.** The threshold band is not evaluated here; the hourly reconciler re-evaluates it
 *   under its own lock (USAGE-001 slice 4), which is soon enough for derivative bytes.
 */

/** What a move reads of a `file_previews` row. */
export type CountablePreview = Pick<
  OrphanPreview,
  'id' | 'fileAssetId' | 'fileVersionId' | 'kind' | 'sizeBytes'
>;

/** What {@link PreviewUsageMeter.release} did. */
export type ReleaseOutcome = 'released' | 'not_counted' | 'drift';

/** Uncounted derivatives the reconciler counts per organization per pass. */
export const PREVIEW_BACKFILL_BATCH = 500;

export class PreviewUsageMeter {
  constructor(
    private readonly counters: UsageCountersRepository,
    private readonly ledger: UsageLedgerRepository,
    private readonly outbox: OutboxEventsRepository,
  ) {}

  /** Count the row's stored bytes as `used`. `true` when this call counted them. */
  async count(
    tx: TenantQueryRunner,
    context: TenantContext,
    preview: CountablePreview,
  ): Promise<boolean> {
    const bytes = preview.sizeBytes ?? 0;
    if (bytes <= 0) return false;
    const reason = USAGE_LEDGER_REASON.previewDerivative;
    if (await this.ledger.hasEntry(tx, context, preview.id, reason)) return false;
    await this.counters.ensure(tx, context, STORAGE_BYTES_METRIC);
    if (!(await this.counters.addUsed(tx, context, STORAGE_BYTES_METRIC, bytes))) return false;
    const eventId = await this.outbox.append(tx, context, {
      type: 'file.preview_ready.v1',
      aggregateId: preview.fileAssetId,
      payload: payloadOf(preview, bytes),
    });
    await this.ledger.record(tx, context, {
      uploadSessionId: preview.id,
      counter: 'used',
      deltaBytes: bytes,
      reason,
      sourceEventId: eventId,
    });
    return true;
  }

  /**
   * Give a removed row's counted bytes back. A drifted counter that holds fewer bytes refuses
   * the decrement (`drift`) and no ledger row is written, as FILE-003's purge does.
   */
  async release(
    tx: TenantQueryRunner,
    context: TenantContext,
    preview: CountablePreview,
  ): Promise<ReleaseOutcome> {
    const bytes = preview.sizeBytes ?? 0;
    if (bytes <= 0) return 'not_counted';
    const counted = await this.ledger.hasEntry(
      tx,
      context,
      preview.id,
      USAGE_LEDGER_REASON.previewDerivative,
    );
    if (!counted) return 'not_counted';
    const reason = USAGE_LEDGER_REASON.previewRemoved;
    if (await this.ledger.hasEntry(tx, context, preview.id, reason)) return 'not_counted';
    const moved = await this.counters.releaseUsed(tx, context, STORAGE_BYTES_METRIC, bytes);
    const eventId = await this.outbox.append(tx, context, {
      type: 'file.preview_removed.v1',
      aggregateId: preview.fileAssetId,
      payload: payloadOf(preview, bytes),
    });
    if (!moved) return 'drift';
    await this.ledger.record(tx, context, {
      uploadSessionId: preview.id,
      counter: 'used',
      deltaBytes: -bytes,
      reason,
      sourceEventId: eventId,
    });
    return 'released';
  }

  /**
   * The reconciler's half: count every `ready` derivative the ledger has no move for (made before
   * counting existed, or by a pass that lost its count), in the reconciler's transaction and
   * before it locks the counter, so its version read is the one after these moves.
   */
  async backfill(
    tx: TenantQueryRunner,
    context: TenantContext,
    previews: FilePreviewsRepository,
  ): Promise<number> {
    const rows = await previews.listUncounted(
      tx,
      context,
      USAGE_LEDGER_REASON.previewDerivative,
      PREVIEW_BACKFILL_BATCH,
    );
    let counted = 0;
    for (const row of rows) if (await this.count(tx, context, row)) counted += 1;
    return counted;
  }
}

function payloadOf(preview: CountablePreview, bytes: number) {
  return {
    fileAssetId: preview.fileAssetId,
    fileVersionId: preview.fileVersionId,
    previewId: preview.id,
    kind: preview.kind,
    metricKey: STORAGE_BYTES_METRIC,
    deltaBytes: bytes,
  };
}
