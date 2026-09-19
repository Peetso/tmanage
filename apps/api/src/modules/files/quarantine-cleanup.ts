import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { FileAssetsRepository } from './file-assets.repository.js';
import type { FilesService } from './files.service.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * FILE-003 — the quarantine / rejected-object retention-lifecycle job.
 *
 * `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §5 and §6 step 8: a rejected or quarantined
 * object's bytes stay counted against the tenant's quota (decision F4) until this job deletes
 * the provider copy and gives the bytes back, and it may do so only after "provider deletion
 * is confirmed and retention/hold rules allow it". The rule this job adds on top of FILE-002's
 * rejection is time: an object is taken only once it has been `rejected` for longer than the
 * configured retention window (`FILE_RETENTION_REJECTED_DAYS`), so a disputed rejection has a
 * documented window to be looked at before its evidence is destroyed.
 *
 * ## Why it is a job, wired like the sweeper and the reconciler
 *
 * `apps/api/src/cleanup.ts` resolves it from the application context and runs one pass, the
 * relay's `--once` shape (`50-BOOTSTRAP` §3: the host keeps no third process alive; the
 * external tick runs it after `sweep:once` and `reconcile:once`). It is built on the same
 * `FilesService` the routes and the sweeper use, so a purge here deletes through the same
 * object store, moves the same counter, appends to the same outbox and writes the same audit a
 * route's write would — never a second copy that could move a counter nobody is told of.
 *
 * ## Why the scan is two steps
 *
 * A `TenantContext` binds one organization, so the pass first asks, unscoped, *which*
 * organizations hold a purgeable asset — through `bootstrapRead`, the audited escape hatch,
 * with a reason string that names this use (decision 2, as the sweeper and reconciler record
 * their own uses) — and then purges each under its own service context, in batches, until a
 * batch purges nothing.
 *
 * ## The clock, and idempotency
 *
 * The cutoff is taken from an injectable clock and bound as a parameter, never `NOW(3)`, so a
 * suite can drive the window deterministically. Each purge is idempotent by construction (see
 * {@link FilesService.purge}): the provider delete is confirmed before the counter is reduced,
 * and the row's one-shot `purged_at` claim means a second pass over an already-purged object is
 * counted `skipped` and moves nothing. A second run right after a first therefore finds only
 * what the first could not take.
 *
 * ## What it does not do
 *
 * It never deletes a `file_assets` / `file_versions` row (`49` §6: never delete customer data
 * automatically) — only the provider bytes, leaving the rejection and its evidence. It triggers
 * on rejection status and age alone, never on a plan change or a payment (`49` §6 last line).
 * The FILE-003 production R2/S3 driver, and the deletion of the *quarantine copy of a `ready`
 * version* (the object that exists twice after a promotion), are out of this slice's scope and
 * are recorded as carried in docs/implementation-status.md.
 */

export interface CleanupReport {
  /** Organizations that held at least one purgeable asset when the pass began. */
  readonly organizations: number;
  /** Rows the per-organization batches selected, over the whole pass. */
  readonly scanned: number;
  /** Rows this pass purged: provider bytes deleted, counter decremented, ledger + audit written. */
  readonly purged: number;
  /** Rows already purged between selection and the claim — a concurrent pass. */
  readonly skipped: number;
  /** Rows whose purge threw (a provider-delete failure among them); logged, left for the next pass. */
  readonly failed: number;
  /** Purged rows whose counter refused the decrement — recorded on their audit rows as `counter_drift`. */
  readonly counterDrift: number;
}

/** The `policyVersion` every cleanup context carries — a literal no resolved context can produce. */
export const CLEANUP_POLICY_VERSION = 'quarantine-retention-cleanup';

/** Rows per organization per batch. A batch is one select and one purge per row. */
export const CLEANUP_BATCH_SIZE = 100;

/** A ceiling on batches per organization per pass, so a row that fails every time cannot loop forever. */
const MAX_BATCHES_PER_ORGANIZATION = 100;

/** The reason string the bootstrap read records on the one cross-tenant statement it issues. */
export const CLEANUP_SCAN_REASON =
  'finding which organizations hold a rejected file asset past its retention window that has ' +
  'not yet been purged, so each can be swept under its own service context (FILE-003)';

/** The instant before which a rejected asset has outlived its retention window. Pure and total. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
}

/**
 * The context one organization is cleaned under — a service context bound to it and to nobody
 * (decision 1, as the sweeper's and the reconciler's are); every audit row on this path names
 * `actorUserId: null` explicitly, the documented system case.
 */
export function cleanupContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: CLEANUP_POLICY_VERSION,
  });
}

export class QuarantineCleanupJob {
  constructor(
    private readonly database: TenantDatabase,
    private readonly assets: FileAssetsRepository,
    private readonly files: FilesService,
    /** How many days a rejected object is kept before its bytes are deleted (`ApiConfig`). */
    private readonly retentionDays: number,
    /** Injectable for the suite; the process clock otherwise. */
    private readonly now: () => Date = () => new Date(),
    /** Where a failed purge is reported. The row is named, never its payload. */
    private readonly onFailure: (fileAssetId: string, error: unknown) => void = (id, error) =>
      console.error(`[cleanup] purging file asset ${id} failed`, describeFailure(error)),
  ) {}

  /** One pass over every organization. Safe to run again at once: a second pass finds nothing. */
  async cleanup(): Promise<CleanupReport> {
    const correlationId = uuidv7();
    const cutoff = retentionCutoff(this.now(), this.retentionDays);
    const organizations = await this.organizationsWithPurgeable(cutoff, correlationId);

    let scanned = 0;
    let purged = 0;
    let skipped = 0;
    let failed = 0;
    let counterDrift = 0;

    for (const organizationId of organizations) {
      const context = cleanupContextFor(organizationId, correlationId);
      for (let batch = 0; batch < MAX_BATCHES_PER_ORGANIZATION; batch += 1) {
        const rows = await this.database.read(context, (db) =>
          this.assets.listPurgeable(db, context, cutoff, CLEANUP_BATCH_SIZE),
        );
        scanned += rows.length;
        let purgedInBatch = 0;
        for (const row of rows) {
          try {
            const outcome = await this.files.purge(context, row.asset, row.version);
            if (outcome.purged) {
              purged += 1;
              purgedInBatch += 1;
              if (!outcome.counterMoved) counterDrift += 1;
            } else {
              skipped += 1;
            }
          } catch (error) {
            failed += 1;
            this.onFailure(row.asset.id, error);
          }
        }
        // A batch that purged nothing has only rows that failed or were taken by someone
        // else; selecting again would find the same rows.
        if (rows.length < CLEANUP_BATCH_SIZE || purgedInBatch === 0) break;
      }
    }

    return { organizations: organizations.length, scanned, purged, skipped, failed, counterDrift };
  }

  /**
   * The cross-tenant half: which organizations hold a rejected asset past the cutoff not yet
   * purged. The escape hatch is read-only, allowlisted to `file_assets`, and raises a guard
   * event carrying {@link CLEANUP_SCAN_REASON}; the statement itself is the repository's.
   */
  private organizationsWithPurgeable(
    cutoff: Date,
    correlationId: string,
  ): Promise<readonly string[]> {
    return this.database.bootstrapRead(
      { correlationId, reason: CLEANUP_SCAN_REASON, tables: ['file_assets'] },
      (db) => this.assets.organizationsWithPurgeableAssets(db, cutoff),
    );
  }
}

/** The one line a pass prints — the sweeper's idiom, distinct prefix so a harness never crosses them. */
export function describeCleanup(report: CleanupReport): string {
  return (
    `scanned ${report.scanned}, purged ${report.purged}, skipped ${report.skipped}, ` +
    `failed ${report.failed}` +
    (report.counterDrift > 0 ? `, ${report.counterDrift} with counter drift` : '') +
    ` (${report.organizations} organization(s))`
  );
}
