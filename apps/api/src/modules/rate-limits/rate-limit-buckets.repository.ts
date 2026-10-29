import type { RowDataPacket } from 'mysql2';
import type { TenantDatabase } from '../../common/database/tenant-context.js';
import type { BucketCharge, BucketChargeResult, BucketStore } from './durable-rate-limiter.js';

/**
 * 56-05 — the MariaDB half of the durable limiter: `rate_limit_buckets` (0250).
 *
 * The table is GLOBAL (no `organization_id`): an anonymous caller has no organization, and the
 * keys are peppered hashes of addresses and link tokens, never tenant data. It is therefore in the
 * tenant guard's `NON_TENANT_TABLES` and reached only through `identityTransaction`.
 *
 * ## One transaction per decision, all or nothing
 *
 * Each bucket is charged with one `INSERT … ON DUPLICATE KEY UPDATE` that either starts the
 * window (`hit_count = 1`) or adds one to it, in bucket-key order so two requests charging the
 * same buckets always lock them in the same order and cannot deadlock each other. The counts are
 * then read back under the row locks the upserts hold; if any is over its ceiling the transaction
 * is rolled back, so a refused request charges nothing (the two-phase rule) and the next request
 * sees exactly the counts the last admitted one left.
 *
 * `VALUES(col)` rather than MySQL 8's row alias: the alias form does not parse on MariaDB, which
 * is what the live host runs. In the update list the assignments run left to right and a later one
 * sees an earlier one's result, so `hit_count` is decided before `window_start` moves.
 *
 * The window instants come from the application clock, not `current_timestamp`: they are aligned
 * boundaries every process on the one host computes identically, and the unit tests pin them.
 */
const TABLES = ['rate_limit_buckets'] as const;

const CHARGE_SQL = `insert into rate_limit_buckets (bucket_key, window_start, hit_count, updated_at)
  values (?, ?, 1, ?)
  on duplicate key update
    hit_count = if(window_start = values(window_start), hit_count + 1, 1),
    window_start = values(window_start),
    updated_at = values(updated_at)`;

const SWEEP_SQL = `delete from rate_limit_buckets where updated_at < ? order by updated_at limit ?`;

/** Thrown inside the transaction to roll a refused decision back; never leaves this file. */
class RefusedCharge extends Error {
  constructor(readonly counts: readonly number[]) {
    super('rate limit refused');
  }
}

export class RateLimitBucketsRepository implements BucketStore {
  constructor(
    private readonly database: TenantDatabase,
    private readonly correlationId: () => string = () => 'rate-limit',
  ) {}

  async chargeAll(charges: readonly BucketCharge[], at: Date): Promise<BucketChargeResult> {
    if (charges.length === 0) return { admitted: true, counts: [] };
    const ordered = [...charges].sort((a, b) => (a.bucketKey < b.bucketKey ? -1 : 1));
    try {
      return await this.database.identityTransaction(
        { correlationId: this.correlationId(), tables: [...TABLES] },
        async (tx) => {
          for (const charge of ordered) {
            await tx.query(CHARGE_SQL, [charge.bucketKey, charge.windowStart, at]);
          }
          const placeholders = charges.map(() => '?').join(', ');
          const rows = await tx.query<RowDataPacket[]>(
            `select bucket_key, hit_count from rate_limit_buckets where bucket_key in (${placeholders})`,
            charges.map((charge) => charge.bucketKey),
          );
          const byKey = new Map(
            rows.map((row) => [String(row['bucket_key']), Number(row['hit_count'])]),
          );
          const counts = charges.map((charge) => byKey.get(charge.bucketKey) ?? 1);
          if (charges.some((charge, index) => (counts[index] ?? 0) > charge.max)) {
            throw new RefusedCharge(counts);
          }
          return { admitted: true, counts };
        },
      );
    } catch (error) {
      if (error instanceof RefusedCharge) return { admitted: false, counts: error.counts };
      throw error;
    }
  }

  async sweep(before: Date, limit: number): Promise<number> {
    return this.database.identityTransaction(
      { correlationId: this.correlationId(), tables: [...TABLES] },
      async (tx) => {
        const result = await tx.query(SWEEP_SQL, [before, Math.max(1, Math.floor(limit))]);
        return Number((result as { affectedRows?: unknown }).affectedRows ?? 0);
      },
    );
  }
}
