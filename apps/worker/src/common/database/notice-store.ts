import { computeBacklog } from './outbox-store.js';
import type { OutboxBacklog } from './outbox-store.js';
import type { WorkerTransaction } from './worker-database.js';
import type { ClaimOptions } from './outbox-store.js';
import type { ParkedQueueRow, QueueStore } from '../../outbox/dispatcher.js';

/**
 * The credential-change notice queue's statements — x31's half of `D05d`.
 *
 * `credential_change_notices` (migration 0020) is `outbox_events` with the tenant column
 * removed, for the reason that migration states at length: a credential is not tenant-owned,
 * and the identity transaction that changes one cannot write a tenant table at all. So the
 * notice has its own table, and this file is the same four statements the relay already
 * issues, over that table.
 *
 * ## Why the SQL is written out rather than generated from `outbox-store.ts`
 *
 * MySQL cannot bind a table name, so "table-parameterised" can only mean one of two things:
 * a statement builder that interpolates an identifier, or a second set of literals. The
 * builder is the worse trade here — it puts string interpolation into the one directory
 * allowed to spell SQL, to save four short statements — so the *loop* is what is
 * parameterised (`QueueStore` in `dispatcher.ts`) and the statements are literal. Every
 * semantic the relay was reviewed for — the two-phase claim, the committed attempt, the
 * refund, parking by arithmetic, the backlog aggregate — belongs to the dispatcher and is
 * reused, not re-implemented.
 *
 * ## Tenancy
 *
 * There is no `organization_id` to scope by and no way to pass one: every statement here
 * selects by primary key or by the queue predicate, exactly as the relay's do, and the
 * process runs as `tmanage_worker` — a system role, granted SELECT and UPDATE on this table
 * and nothing else new (`scripts/db/users.sql`). The row carries a `user_id`, and the
 * recipient is re-resolved from it at delivery rather than trusted from the notice.
 *
 * ## What this credential may read, and what it deliberately may not
 *
 * The notice carries no secret and no address (0020's header). The relay still holds nothing
 * on `user_passwords`, `user_mfa_factors`, `user_recovery_codes` or `authentication_events`,
 * which `least-privilege.db.test.ts` pins — so a queue the relay *can* read must not become a
 * way back to the tables it cannot.
 */

/**
 * The dispatch key every notice is handled under. A constant rather than a column: the table
 * has exactly one row shape, and `action` selects a *template*, not a consumer. Registering
 * one handler for one key keeps `registry.ts` honest about how many consumers exist.
 */
export const CREDENTIAL_CHANGE_NOTICE_TYPE = 'credential_change.notice.v1';

/** One claimed notice, as its consumer receives it. */
export interface ClaimedCredentialNotice {
  readonly id: string;
  /** Always {@link CREDENTIAL_CHANGE_NOTICE_TYPE} — see above. */
  readonly type: string;
  /** The account holder the change was made on. Re-resolved at delivery, never trusted. */
  readonly userId: string;
  /** One of the API's `CREDENTIAL_CHANGE_ACTIONS`; an unknown value is not mailed. */
  readonly action: string;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  /** Deliveries started, including this one — `reserveDueNotices` counts it before the send. */
  readonly attempts: number;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/** Phase one of the claim, over the notice table. See {@link QueueStore} and `outbox-store.ts`. */
export async function reserveDueNotices(
  tx: WorkerTransaction,
  options: ClaimOptions,
): Promise<readonly string[]> {
  const rows = await tx.query<readonly { readonly id: string }[]>(
    `SELECT id
       FROM credential_change_notices
      WHERE published_at IS NULL
        AND available_at <= NOW(3)
        AND attempts < ?
      ORDER BY available_at, id
      LIMIT ?
      FOR UPDATE SKIP LOCKED`,
    [options.maxAttempts, options.limit],
  );
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return ids;
  await tx.query(
    `UPDATE credential_change_notices
        SET attempts = attempts + 1
      WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
  return ids;
}

/** Phase two: take the reserved rows into the batch transaction, under their own locks. */
export async function claimReservedNotices(
  tx: WorkerTransaction,
  ids: readonly string[],
): Promise<readonly ClaimedCredentialNotice[]> {
  if (ids.length === 0) return [];
  interface NoticeRow {
    readonly id: string;
    readonly user_id: string;
    readonly action: string;
    readonly correlation_id: string | null;
    readonly occurred_at: Date;
    readonly attempts: number;
  }
  const rows = await tx.query<readonly NoticeRow[]>(
    `SELECT id, user_id, action, correlation_id, occurred_at, attempts
       FROM credential_change_notices
      WHERE id IN (${placeholders(ids.length)})
        AND published_at IS NULL
      ORDER BY available_at, id
      FOR UPDATE SKIP LOCKED`,
    [...ids],
  );
  return rows.map((row) => ({
    id: row.id,
    type: CREDENTIAL_CHANGE_NOTICE_TYPE,
    userId: row.user_id,
    action: row.action,
    correlationId: row.correlation_id,
    occurredAt: row.occurred_at,
    attempts: Number(row.attempts),
  }));
}

export async function markNoticePublished(tx: WorkerTransaction, id: string): Promise<void> {
  await tx.query(`UPDATE credential_change_notices SET published_at = NOW(3) WHERE id = ?`, [id]);
}

export async function recordNoticeFailure(
  tx: WorkerTransaction,
  id: string,
  error: string,
  nextAvailableAt: Date,
): Promise<void> {
  await tx.query(
    `UPDATE credential_change_notices
        SET last_error = ?, available_at = ?
      WHERE id = ?`,
    // VARCHAR(1000), truncated here rather than by the driver — `recordFailure`'s rule.
    [error.slice(0, 1000), nextAvailableAt, id],
  );
}

/** CRITICAL-B's refund, over the notice table. Never below zero, never on a drained row. */
export async function releaseReservedNoticeAttempts(
  tx: WorkerTransaction,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  await tx.query(
    `UPDATE credential_change_notices
        SET attempts = attempts - 1
      WHERE id IN (${placeholders(ids.length)})
        AND published_at IS NULL
        AND attempts > 0`,
    [...ids],
  );
}

/**
 * The parked notices, in the shape every report names — `organizationId` is `null` because
 * this queue has no organization, not because one could not be read.
 */
export async function listParkedNotices(
  tx: WorkerTransaction,
  maxAttempts: number,
  limit: number,
): Promise<readonly ParkedQueueRow[]> {
  interface ParkedRow {
    readonly id: string;
    readonly action: string;
    readonly attempts: number;
    readonly last_error: string | null;
  }
  const rows = await tx.query<readonly ParkedRow[]>(
    `SELECT id, action, attempts, last_error
       FROM credential_change_notices
      WHERE published_at IS NULL AND attempts >= ?
      ORDER BY id
      LIMIT ?`,
    [maxAttempts, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    organizationId: null,
    // The action, not the constant dispatch key: a parked row's report is for a person
    // deciding what broke, and "which of the four changes" is the only distinguishing fact
    // this queue has. It is a closed vocabulary, never a secret and never something typed.
    type: `${CREDENTIAL_CHANGE_NOTICE_TYPE}:${row.action}`,
    attempts: Number(row.attempts),
    lastError: row.last_error,
  }));
}

/** CRITICAL-2's measurement, over the notice table. Same aggregate, same meaning — age from
 * `LEAST(occurred_at, available_at)` per IMPORTANT-E, computed in `computeBacklog`. */
export async function readNoticeBacklog(
  tx: WorkerTransaction,
  maxAttempts: number,
): Promise<OutboxBacklog> {
  interface BacklogRow {
    readonly attempts: unknown;
    readonly occurred_at: unknown;
    readonly available_at: unknown;
    readonly now_at: unknown;
  }
  const rows = await tx.query<readonly BacklogRow[]>(
    `SELECT attempts, occurred_at, available_at, NOW(3) AS now_at
       FROM credential_change_notices
      WHERE published_at IS NULL`,
  );
  const asDate = (value: unknown): Date =>
    value instanceof Date ? value : new Date(String(value));
  const first = rows[0];
  const now = first === undefined ? new Date() : asDate(first.now_at);
  return computeBacklog(
    rows.map((row) => ({
      attempts: Number(row.attempts),
      occurredAt: asDate(row.occurred_at),
      availableAt: asDate(row.available_at),
    })),
    now,
    maxAttempts,
  );
}

/**
 * `relay:unpark` over the notice table — the way out of parking, for the same reason
 * `unparkEvents` exists: an alarm whose only stand-down is hand-written SQL is an alarm
 * somebody silences instead. Primary key or every parked row, nothing in between.
 */
export async function unparkNotices(
  tx: WorkerTransaction,
  maxAttempts: number,
  noticeId: string | null,
): Promise<readonly ParkedQueueRow[]> {
  interface ParkedRow {
    readonly id: string;
    readonly action: string;
    readonly attempts: number;
    readonly last_error: string | null;
  }
  const rows = await tx.query<readonly ParkedRow[]>(
    `SELECT id, action, attempts, last_error
       FROM credential_change_notices
      WHERE published_at IS NULL
        AND attempts >= ?${noticeId === null ? '' : '\n        AND id = ?'}
      ORDER BY id
      FOR UPDATE`,
    noticeId === null ? [maxAttempts] : [maxAttempts, noticeId],
  );
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  await tx.query(
    `UPDATE credential_change_notices
        SET attempts = 0, available_at = NOW(3), last_error = NULL
      WHERE id IN (${placeholders(ids.length)})`,
    ids,
  );
  return rows.map((row) => ({
    id: row.id,
    organizationId: null,
    type: `${CREDENTIAL_CHANGE_NOTICE_TYPE}:${row.action}`,
    attempts: Number(row.attempts),
    lastError: row.last_error,
  }));
}

/** Where a notice is delivered, resolved at delivery time. */
export interface CredentialNoticeRecipient {
  readonly email: string;
  readonly displayName: string;
}

/**
 * The account holder's address, by primary key, read inside the batch transaction.
 *
 * Re-resolved rather than carried on the notice, which is `24-EVENT-CATALOG` §6's rule and
 * matters more here than anywhere: the row may have been queued days ago, and an address
 * changed since is the address the owner actually reads. `null` — no such user — is answered
 * with silence by the consumer, never a throw: the row would otherwise fail its way to
 * parking and raise a page about an account that no longer exists.
 */
export async function findCredentialNoticeRecipient(
  tx: WorkerTransaction,
  userId: string,
): Promise<CredentialNoticeRecipient | null> {
  interface Row {
    readonly email: string;
    readonly display_name: string;
  }
  const rows = await tx.query<readonly Row[]>(
    `SELECT email, display_name FROM users WHERE id = ?`,
    [userId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  return { email: row.email, displayName: row.display_name };
}

/** `credential_change_notices`, bound to the dispatcher's queue port. */
export const CREDENTIAL_NOTICE_QUEUE: QueueStore<ClaimedCredentialNotice> = {
  name: 'credential-change-notices',
  reserveDue: reserveDueNotices,
  claimReserved: claimReservedNotices,
  markPublished: markNoticePublished,
  recordFailure: recordNoticeFailure,
  releaseReserved: releaseReservedNoticeAttempts,
  listParked: listParkedNotices,
  readBacklog: readNoticeBacklog,
};
