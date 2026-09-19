import { and, asc, eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { usageCounters } from '../../common/database/schema.js';
import type { UsageCounterRow } from '../../common/database/schema.js';
import type {
  BootstrapQueryRunner,
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import type { ThresholdBand } from './usage-thresholds.js';

/** What {@link UsageCountersRepository.loadThresholdState} reads for the band evaluation (slice 4). */
export interface ThresholdCounterState {
  readonly id: string;
  readonly used: number;
  readonly reserved: number;
  readonly band: ThresholdBand;
  /** The counter's version after the move — the third part of the crossing's idempotency key. */
  readonly version: number;
}

/** What {@link UsageCountersRepository.lockForReconcile} reads under the row lock. */
export interface LockedCounter {
  readonly id: string;
  readonly usedValue: number;
  readonly reservedValue: number;
  readonly version: number;
}

/** The correction {@link UsageCountersRepository.correct} applies on drift. */
export interface CorrectCounterInput {
  readonly metricKey: string;
  readonly usedValue: number;
  readonly reservedValue: number;
  /** The version read under the lock; the repair is refused if it moved (CONC-06). */
  readonly expectedVersion: number;
}

/**
 * The quota counter — `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY` §6, as four statements.
 *
 * Every method here is one conditional UPDATE whose `WHERE` clause *is* the rule, and whose
 * answer is "did a row change". There is no read-then-write anywhere in this file, and that
 * is the whole design: InnoDB holds the row lock for the statement and re-evaluates the
 * predicate after the lock is granted, so two reservations racing for the last megabyte
 * serialise on the row and exactly one of them sees a predicate that still holds. The
 * database suite proves that with concurrent callers rather than asserting it.
 *
 * `BIGINT UNSIGNED` on both counter columns is the second half: a release that exceeds what
 * was reserved would underflow, and the engine refuses the statement instead of writing a
 * negative reservation. The `reserved_value >= ?` guard in {@link release} and
 * {@link commit} turns that refusal into a `false` a caller can reason about, but the column
 * type is what makes "counters never go negative" (27-TEST-CATALOG CONC-06) true even for a
 * statement this file did not write.
 *
 * ## Where the limit comes from is not this file's business
 *
 * The effective quota is a parameter. `storageLimitsFor` in the service reads it from
 * configuration today and from `organization_entitlements` once ENT-001 exists; this
 * repository only ever compares against the number it is handed.
 */

/** The one metric this slice meters. USAGE-001 adds the rest as rows, not as a schema change. */
export const STORAGE_BYTES_METRIC = 'storage.bytes';

export class UsageCountersRepository {
  /**
   * Make sure the organization has a counter row for the metric. Idempotent: the unique key
   * on `(organization_id, metric_key)` turns a second seed into a no-op, so the reservation
   * statement that follows can rely on the row existing and read "zero rows" as "would
   * exceed" and nothing else.
   */
  async ensure(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(usageCounters)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        metricKey,
        usedValue: 0,
        reservedValue: 0,
        version: 1,
        createdAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { version: sql`version` } });
  }

  async find(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
  ): Promise<UsageCounterRow | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, metricKey),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * §6 step 3: reserve `bytes` if `used + reserved + bytes <= limit`. `true` when reserved.
   *
   * Call {@link ensure} first in the same transaction. Without the row this answers `false`
   * for a reason that is not the quota, and the caller would report a full quota to an
   * organization that has never uploaded anything.
   */
  async reserve(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
    bytes: number,
    limitBytes: number,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(usageCounters)
      .set({
        reservedValue: sql`reserved_value + ${bytes}`,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, metricKey),
          sql`used_value + reserved_value + ${bytes} <= ${limitBytes}`,
        ),
      );
    return result[0].affectedRows === 1;
  }

  /**
   * §6 step 6: the reservation becomes used bytes — the provider's count, not the
   * declaration. `false` when less than `reservedBytes` is outstanding, which is the
   * double-completion the caller must treat as already done rather than as a second commit.
   */
  async commit(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
    reservedBytes: number,
    committedBytes: number,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(usageCounters)
      .set({
        reservedValue: sql`reserved_value - ${reservedBytes}`,
        usedValue: sql`used_value + ${committedBytes}`,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, metricKey),
          sql`reserved_value >= ${reservedBytes}`,
        ),
      );
    return result[0].affectedRows === 1;
  }

  /** §6 step 7: cancel, failure or expiry gives the bytes back. Same guard as {@link commit}. */
  async release(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
    reservedBytes: number,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(usageCounters)
      .set({
        reservedValue: sql`reserved_value - ${reservedBytes}`,
        version: sql`version + 1`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, metricKey),
          sql`reserved_value >= ${reservedBytes}`,
        ),
      );
    return result[0].affectedRows === 1;
  }

  // ── USAGE-001 slice 3: reconciliation ──────────────────────────────────────

  /**
   * Which organizations hold a counter row for the metric — the reconciler's cross-tenant
   * scan. The one read on this table with no tenant predicate, so it takes a
   * {@link BootstrapQueryRunner}: the caller declares the reason and the `usage_counters`
   * allowlist, and the escape hatch refuses anything but a select. Ordered so a pass is
   * deterministic.
   */
  async organizationsWithCounter(
    runner: BootstrapQueryRunner,
    metricKey: string,
  ): Promise<readonly string[]> {
    const rows = await tenantDrizzle(runner)
      .selectDistinct({ organizationId: usageCounters.organizationId })
      .from(usageCounters)
      .where(eq(usageCounters.metricKey, metricKey))
      .orderBy(asc(usageCounters.organizationId));
    return rows.map((row) => row.organizationId);
  }

  /**
   * Read the counter under its own row lock — USAGE-001 slice 3, CONC-06. Drizzle's proxy
   * dialect has no `.for('update')` and the lock is the point of the statement (no reserve,
   * commit or release may move the row between this read and the repair), so it is written
   * out. **Must be called inside a transaction**; on an autocommit connection the lock would
   * be released at once, reopening the race it exists to close. `null` when the organization
   * has no row for the metric.
   */
  async lockForReconcile(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
  ): Promise<LockedCounter | null> {
    const rows = await runner.execute<QueryRows>(
      `select id, used_value, reserved_value, version from usage_counters
        where organization_id = ? and metric_key = ?
        for update`,
      [context.organizationId, metricKey],
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row['id'] as string,
      usedValue: Number(row['used_value']),
      reservedValue: Number(row['reserved_value']),
      version: Number(row['version']),
    };
  }

  /**
   * Correct a drifted counter to the ledger sums — USAGE-001 slice 3. Version-conditional
   * (CONC-06): the `version` read under {@link lockForReconcile} must still hold, so a move
   * that somehow slipped between the lock and here cannot be silently overwritten. Bumps
   * `version` (this is a value change) and stamps `reconciled_at`. `true` when the one locked
   * row was corrected.
   */
  async correct(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: CorrectCounterInput,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(usageCounters)
      .set({
        usedValue: input.usedValue,
        reservedValue: input.reservedValue,
        version: sql`version + 1`,
        reconciledAt: sql`current_timestamp(3)`,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, input.metricKey),
          eq(usageCounters.version, input.expectedVersion),
        ),
      );
    return result[0].affectedRows === 1;
  }

  // ── USAGE-001 slice 4: threshold bands ──────────────────────────────────────

  /**
   * Read what the band evaluation needs — the counter's id, its used and reserved bytes, its
   * current band and its version — for the storage metric. Called inside the move's own
   * transaction, after the reserve/commit/correct that changed the row, so it sees that row's
   * own uncommitted values under the lock the move already holds. `null` when the organization
   * has no counter row for the metric (nothing was moved, nothing to evaluate).
   */
  async loadThresholdState(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
  ): Promise<ThresholdCounterState | null> {
    const rows = await tenantDrizzle(runner)
      .select({
        id: usageCounters.id,
        usedValue: usageCounters.usedValue,
        reservedValue: usageCounters.reservedValue,
        thresholdBand: usageCounters.thresholdBand,
        version: usageCounters.version,
      })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, metricKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      used: Number(row.usedValue),
      reserved: Number(row.reservedValue),
      band: row.thresholdBand as ThresholdBand,
      version: Number(row.version),
    };
  }

  /**
   * Set the stored band. No `version` bump: the band is not part of the used/reserved
   * optimistic-lock value the reconciler guards on (it moves on a band change, not a byte
   * change). No version guard either: the caller has already moved this row in the same
   * transaction, so it holds the row lock and nothing else can interleave.
   */
  async setThresholdBand(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
    band: ThresholdBand,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(usageCounters)
      .set({ thresholdBand: band, updatedAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, metricKey),
        ),
      );
  }

  /**
   * Stamp `reconciled_at` on a counter the reconciler proved already matched its ledger —
   * USAGE-001 slice 3 §b, so the column records the last time the row was checked whether or
   * not it drifted. No `version` bump: nothing about the counter's value changed. Called under
   * the same lock {@link lockForReconcile} took, so it needs no version guard of its own.
   */
  async touchReconciledAt(
    runner: TenantQueryRunner,
    context: TenantContext,
    metricKey: string,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .update(usageCounters)
      .set({ reconciledAt: sql`current_timestamp(3)` })
      .where(
        and(
          eq(usageCounters.organizationId, context.organizationId),
          eq(usageCounters.metricKey, metricKey),
        ),
      );
  }
}
