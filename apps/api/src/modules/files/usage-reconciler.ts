import { uuidv7 } from '@tmanage/domain';
import { createServiceContext } from '../../common/database/tenant-context.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { AuditService } from '../audit/audit.service.js';
import { STORAGE_BYTES_METRIC } from './usage-counters.repository.js';
import type { UsageCountersRepository } from './usage-counters.repository.js';
import type { UsageLedgerRepository } from './usage-ledger.repository.js';
import type { UsageThresholdEvaluator } from './usage-thresholds.js';
import { describeFailure } from './upload-session-sweeper.js';

/**
 * USAGE-001, slice 3 — the reconciler: `49-PRICING` §6's "append-only usage ledger plus
 * reconciled counters", the half that closes the loop the ledger (slice 2) opened.
 *
 * The ledger is the source of truth. Every counter move writes a signed row keyed on the
 * move that caused it, in the move's own transaction, so the per-counter sum of
 * `usage_ledger_entries` is what the organization's storage actually is. `usage_counters`
 * is the fast read the reservation guard consults, and a fast read can drift: a row repaired
 * by hand, a bug in a mover, a crash between two statements a migration once did without a
 * transaction. This pass finds that drift and repairs the counter *towards the ledger* — it
 * never writes the ledger, because the ledger is what it is checking against (slice brief §c;
 * the pre-build note's "correcting ledger row" is superseded — a correction to the source of
 * truth would make the check circular).
 *
 * ## What a pass does, per organization
 *
 * Under the counter row's own lock (`SELECT … FOR UPDATE`, so no move can interleave between
 * the read and the repair — CONC-06), it sums the ledger per counter, compares, and then:
 *
 * - **on drift** — corrects `used_value`/`reserved_value` to the ledger sums, bumps `version`
 *   (a value change), stamps `reconciled_at`, and records one `usage_counter.drift_corrected`
 *   audit row with the before/after and the deltas, `actorUserId: null` (nobody acted — the
 *   documented system case, as the expiry sweeper's row is). Audit and repair commit together.
 * - **no drift** — stamps `reconciled_at` alone (no value change, no version bump).
 *
 * `reconciled_at` is written on **every** run either way (slice brief §b; the column exists
 * since migration 0015 and nothing wrote it until now), so an operator can see the last time
 * a counter was proven against its ledger.
 *
 * ## Why it is a job, wired like the sweeper
 *
 * `apps/api/src/reconcile.ts` resolves it from the application context and runs one pass, the
 * relay's `--once` shape (`50-BOOTSTRAP` §3: the host keeps no third process alive; the
 * external tick runs it after `sweep:once`). It is built on the same repositories the routes
 * use. The cross-tenant half — which organizations even have a counter row — is the audited
 * escape hatch the sweeper uses, read-only, allowlisted to `usage_counters`.
 *
 * ## What it does not do
 *
 * Provider-inventory reconciliation (comparing the counter to what the object store actually
 * holds) is out of scope: `ObjectStore` has no list or head yet. This pass reconciles the
 * counter against the ledger only — the two numbers the system already keeps.
 */

// ── The pure diff ────────────────────────────────────────────────────────────

/** A counter's two dimensions, or the ledger's per-counter sums — the same shape. */
export interface CounterState {
  readonly used: number;
  readonly reserved: number;
}

/** What {@link reconcileCounter} decides about one counter against its ledger sums. */
export interface CounterReconciliation {
  /** Whether either dimension differs from the ledger. */
  readonly drifted: boolean;
  /** `ledger.used - counter.used`; positive when the counter under-counts used bytes. */
  readonly usedDelta: number;
  /** `ledger.reserved - counter.reserved`. */
  readonly reservedDelta: number;
  /** The value the counter should hold: the ledger sums, unconditionally. */
  readonly expected: CounterState;
}

/**
 * Compare a counter to its ledger sums. Pure and total: the ledger is the truth, so the
 * expected value is always the ledger sums and drift is any non-zero difference. Kept out of
 * the class so the one unit test this slice adds can drive the arithmetic directly, the way
 * the ledger slice unit-tests its idempotency-key builder.
 */
export function reconcileCounter(
  counter: CounterState,
  ledger: CounterState,
): CounterReconciliation {
  const usedDelta = ledger.used - counter.used;
  const reservedDelta = ledger.reserved - counter.reserved;
  return {
    drifted: usedDelta !== 0 || reservedDelta !== 0,
    usedDelta,
    reservedDelta,
    expected: { used: ledger.used, reserved: ledger.reserved },
  };
}

// ── The pass ───────────────────────────────────────────────────────────────

export interface ReconciliationReport {
  /** Organizations that held a counter row for the metric when the pass began. */
  readonly organizations: number;
  /** Counter rows this pass examined (one per organization for the storage metric). */
  readonly counters: number;
  /** Counters this pass stamped `reconciled_at` on — every one it examined. */
  readonly reconciled: number;
  /** Counters this pass found drifted and corrected to the ledger sums. */
  readonly drifted: number;
  /** Counters whose reconciliation threw. Logged by the pass; the row is left for the next. */
  readonly failed: number;
}

/** The `policyVersion` every reconciler context carries — a literal no resolved context makes. */
export const RECONCILE_POLICY_VERSION = 'usage-counter-reconcile';

/** The reason string the bootstrap read records on the one cross-tenant statement it issues. */
export const RECONCILE_SCAN_REASON =
  'finding which organizations hold a usage counter, so each can be reconciled against its ' +
  'append-only ledger under its own service context (USAGE-001 slice 3)';

/** The context one organization is reconciled under — bound to it and to nobody (decision 1). */
export function reconcilerContextFor(organizationId: string, correlationId: string): TenantContext {
  return createServiceContext({
    organizationId,
    correlationId,
    policyVersion: RECONCILE_POLICY_VERSION,
  });
}

export class UsageReconciler {
  constructor(
    private readonly database: TenantDatabase,
    private readonly counters: UsageCountersRepository,
    private readonly ledger: UsageLedgerRepository,
    private readonly audit: AuditService,
    /**
     * USAGE-001 slice 4. Re-evaluates the band under the same lock this pass already holds, so a
     * counter whose usage rose without the reserve/commit path emitting (a drift the pass just
     * corrected, or a band left stale by an earlier code path) still crosses its threshold. The
     * quota it evaluates against is {@link quotaBytes}. Nullable so the slice-3 constructor
     * signature still builds a reconciler that reconciles but does not evaluate bands.
     */
    private readonly thresholds: UsageThresholdEvaluator | null = null,
    /** The effective storage quota the band is a percentage of (`49-PRICING` §5's seam). */
    private readonly quotaBytes: number = 0,
    /** Where a failed reconciliation is reported. The organization is named, never its payload. */
    private readonly onFailure: (organizationId: string, error: unknown) => void = (id, error) =>
      console.error(`[reconciler] reconciling organization ${id} failed`, describeFailure(error)),
  ) {}

  /** One pass over every organization that holds a storage counter. Safe to run again at once. */
  async reconcile(): Promise<ReconciliationReport> {
    const correlationId = uuidv7();
    const organizations = await this.organizationsWithCounter(correlationId);

    let counters = 0;
    let reconciled = 0;
    let drifted = 0;
    let failed = 0;

    for (const organizationId of organizations) {
      const context = reconcilerContextFor(organizationId, correlationId);
      try {
        const outcome = await this.reconcileOrganization(context);
        if (outcome === 'absent') continue;
        counters += 1;
        reconciled += 1;
        if (outcome === 'corrected') drifted += 1;
      } catch (error) {
        failed += 1;
        this.onFailure(organizationId, error);
      }
    }

    return { organizations: organizations.length, counters, reconciled, drifted, failed };
  }

  /**
   * Reconcile one organization's storage counter in one transaction. `absent` when the
   * organization has no counter row for the metric (nothing to do); `corrected` when the
   * counter drifted and was repaired; `clean` when it already matched. The row is locked
   * for the whole transaction so no reserve/commit/release can move it underneath the read.
   */
  private async reconcileOrganization(
    context: TenantContext,
  ): Promise<'absent' | 'clean' | 'corrected'> {
    return this.database.transaction(context, async (tx) => {
      const locked = await this.counters.lockForReconcile(tx, context, STORAGE_BYTES_METRIC);
      if (!locked) return 'absent';

      const sums = await this.ledger.sumByCounter(tx, context);
      const diff = reconcileCounter(
        { used: locked.usedValue, reserved: locked.reservedValue },
        sums,
      );

      if (!diff.drifted) {
        await this.counters.touchReconciledAt(tx, context, STORAGE_BYTES_METRIC);
        // Re-evaluate the band under the lock, in case an earlier path left it stale (slice 4).
        await this.thresholds?.evaluate(tx, context, STORAGE_BYTES_METRIC, this.quotaBytes);
        return 'clean';
      }

      const corrected = await this.counters.correct(tx, context, {
        metricKey: STORAGE_BYTES_METRIC,
        usedValue: diff.expected.used,
        reservedValue: diff.expected.reserved,
        expectedVersion: locked.version,
      });
      // Under the row lock the version cannot have moved since {@link lockForReconcile}, so a
      // refused correction is an anomaly, not a race. Throwing lets the pass count it `failed`
      // and name the organization rather than stamp a `reconciled_at` on an unrepaired row.
      if (!corrected) {
        throw new Error(
          `usage counter for ${context.organizationId} was not corrected: version moved under the lock`,
        );
      }

      await this.audit.record(tx, context, {
        action: 'usage_counter.drift_corrected',
        objectId: locked.id,
        result: 'allowed',
        actorUserId: null,
        metadata: {
          metric_key: STORAGE_BYTES_METRIC,
          used_before: locked.usedValue,
          used_after: diff.expected.used,
          used_drift: diff.usedDelta,
          reserved_before: locked.reservedValue,
          reserved_after: diff.expected.reserved,
          reserved_drift: diff.reservedDelta,
        },
      });
      // The corrected counter may have crossed a band the drifting path never emitted for
      // (USAGE-001 slice 4): re-evaluate under the same lock and emit if it rose.
      await this.thresholds?.evaluate(tx, context, STORAGE_BYTES_METRIC, this.quotaBytes);
      return 'corrected';
    });
  }

  /**
   * The cross-tenant half: which organizations hold a counter row for the metric. The escape
   * hatch is read-only, allowlisted to `usage_counters`, and raises a guard event carrying
   * {@link RECONCILE_SCAN_REASON}; the statement itself is the repository's.
   */
  private organizationsWithCounter(correlationId: string): Promise<readonly string[]> {
    return this.database.bootstrapRead(
      { correlationId, reason: RECONCILE_SCAN_REASON, tables: ['usage_counters'] },
      (db) => this.counters.organizationsWithCounter(db, STORAGE_BYTES_METRIC),
    );
  }
}

/** The one line a pass prints — the sweeper's idiom, distinct prefix so a harness never crosses them. */
export function describeReconciliation(report: ReconciliationReport): string {
  return (
    `examined ${report.counters}, reconciled ${report.reconciled}, ` +
    `drifted ${report.drifted}, failed ${report.failed} ` +
    `(${report.organizations} organization(s))`
  );
}
