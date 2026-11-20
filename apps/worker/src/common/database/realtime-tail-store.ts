import type { ClaimedOutboxEvent } from './outbox-store.js';
import { parsePayload } from './outbox-store.js';
import type { WorkerTransaction } from './worker-database.js';

/**
 * DC-3 / RT-2 — the reads of the realtime tail: every copy of the app follows the outbox's
 * **published** rows to frame its own sockets, without claiming, locking or writing anything.
 *
 * Claiming stays with the leader's relay (the side effects: mail, notifications, projections).
 * A published row is immutable from here on, so any number of copies can read it at once.
 * Both reads walk `ix_outbox_events_unpublished (published_at, available_at)` from the left:
 * `MAX(published_at)` is one index dive, and the window read is a range scan on the same
 * prefix. Every time compared is a value this store read back from `published_at` itself — the
 * relay's `NOW(3)` on the session's UTC clock — so no JS clock is ever compared to a DB clock.
 */

export const TAIL_START_SQL = `SELECT MAX(published_at) AS published_at FROM outbox_events`;

/**
 * One page of published rows of the framed types, strictly after the `(published_at, id)`
 * position given. The keyset form (`>` on the time, or the same time and a later id) lets a
 * window wider than one page be read in pages without skipping or repeating a row.
 */
export function tailPageSql(typeCount: number): string {
  const types = Array.from({ length: typeCount }, () => '?').join(', ');
  return `SELECT id, organization_id, type, schema_version, aggregate_type, aggregate_id,
            payload_json, correlation_id, occurred_at, attempts, published_at
       FROM outbox_events
      WHERE (published_at > ? OR (published_at = ? AND id > ?))
        AND type IN (${types})
      ORDER BY published_at, id
      LIMIT ?`;
}

interface TailRow {
  readonly id: string;
  readonly organization_id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly payload_json: unknown;
  readonly correlation_id: string | null;
  readonly occurred_at: Date;
  readonly attempts: number;
  readonly published_at: Date;
}

/** A published event as the fan-out handlers read it, with the time the relay published it. */
export interface PublishedOutboxEvent extends ClaimedOutboxEvent {
  readonly publishedAt: Date;
}

/** The newest publish time in the outbox, or `null` while nothing was ever published. */
export async function readTailStart(tx: WorkerTransaction): Promise<Date | null> {
  const rows = await tx.query<readonly { readonly published_at: Date | null }[]>(TAIL_START_SQL);
  return rows[0]?.published_at ?? null;
}

export interface TailPosition {
  readonly publishedAt: Date;
  /**
   * The id tie-break inside one millisecond. `null` means "strictly after the time": `id > NULL`
   * is never true in SQL, so the OR's second arm drops out.
   */
  readonly id: string | null;
}

export async function readPublishedPage(
  tx: WorkerTransaction,
  after: TailPosition,
  types: readonly string[],
  limit: number,
): Promise<readonly PublishedOutboxEvent[]> {
  if (types.length === 0) return [];
  const rows = await tx.query<readonly TailRow[]>(tailPageSql(types.length), [
    after.publishedAt,
    after.publishedAt,
    after.id,
    ...types,
    limit,
  ]);
  return rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    type: row.type,
    schemaVersion: Number(row.schema_version),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: parsePayload(row.payload_json),
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    attempts: Number(row.attempts),
    publishedAt: row.published_at,
  }));
}
