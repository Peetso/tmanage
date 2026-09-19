import { sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { usageLedgerEntries } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * The append-only usage ledger — USAGE-001 slice 2, `49-PRICING-ENTITLEMENTS-AND-STORAGE-POLICY`
 * §5's "append-only usage ledger plus reconciled counters".
 *
 * One immutable row per counter move. The caller ({@link ../files/files.service.ts}) records
 * a row inside the same transaction that moved {@link ./usage-counters.repository.ts}'s
 * counter and appended the producing outbox event, passing that event's id as
 * `sourceEventId`. Like the outbox writer, this repository takes the caller's
 * `TenantQueryRunner` and never opens a transaction of its own, so a ledger row can only ever
 * commit with the counter move it explains — migration 0021's header states the property.
 *
 * There is no read, no update, no delete: the reconciliation slice reads the ledger, the
 * runtime credential may only append (`scripts/db/users.sql`), and a ledger row is history.
 */

/** The two dimensions of `usage_counters` a move can touch — migration 0021's `counter` enum. */
export const USAGE_LEDGER_COUNTERS = ['used', 'reserved'] as const;
export type UsageLedgerCounter = (typeof USAGE_LEDGER_COUNTERS)[number];

/**
 * Why a counter moved. Closed today; a later slice adds a value, not a column.
 * - `reserve` — bytes reserved when an upload session opens (`+reserved`).
 * - `commit` — the reservation becomes used bytes on completion (`+used`).
 * - `commit_release` — the reservation retired by that same completion (`-reserved`).
 * - `cancelled` / `expired` / `failed` — the reservation given back (`-reserved`), named by
 *   the cause so a completion and a release of one session never share an idempotency key.
 */
export const USAGE_LEDGER_REASON = {
  reserve: 'reserve',
  commit: 'commit',
  commitRelease: 'commit_release',
} as const;

/**
 * The idempotency key for a counter move: `<uploadSessionId>:<reason>`, unique per tenant
 * (migration 0021). Pure and total, so the one unit test this slice adds covers it directly
 * rather than through the database.
 */
export function usageLedgerIdempotencyKey(uploadSessionId: string, reason: string): string {
  return `${uploadSessionId}:${reason}`;
}

export interface RecordUsageLedgerEntryInput {
  /** The upload session the move belongs to — the first half of the idempotency key. */
  readonly uploadSessionId: string;
  /** Which counter dimension moved. */
  readonly counter: UsageLedgerCounter;
  /** Signed bytes: positive to add, negative to give back. */
  readonly deltaBytes: number;
  /** Why it moved — the second half of the idempotency key. */
  readonly reason: string;
  /** The `outbox_events` row this move produced. */
  readonly sourceEventId: string;
}

export class UsageLedgerRepository {
  /**
   * Append one ledger row inside the caller's unit of work. A replay — the same
   * `(uploadSessionId, reason)` for this tenant — inserts nothing and does not raise, so an
   * at-least-once retry upstream cannot double-count a move. The `ON DUPLICATE KEY` branch is
   * a no-op (`id = id`), the same shape `usage_counters.ensure` uses.
   */
  async record(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: RecordUsageLedgerEntryInput,
  ): Promise<void> {
    await tenantDrizzle(runner)
      .insert(usageLedgerEntries)
      .values({
        id: uuidv7(),
        organizationId: context.organizationId,
        counter: input.counter,
        delta: input.deltaBytes,
        reason: input.reason,
        idempotencyKey: usageLedgerIdempotencyKey(input.uploadSessionId, input.reason),
        sourceEventId: input.sourceEventId,
        createdAt: sql`current_timestamp(3)`,
      })
      .onDuplicateKeyUpdate({ set: { id: sql`id` } });
  }
}
