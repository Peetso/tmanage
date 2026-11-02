import type { Principal } from '@tmanage/domain';
import type { TimePeriodLockRow } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { AuditService } from '../audit/audit.service.js';
import type { NotificationsRepository } from '../inbox/notifications.repository.js';
import { requireInternal } from './time-capabilities.js';
import { optionalId } from './time-rules.js';
import {
  financeManagers,
  LOCK_BATCH_SIZE,
  parseLockPageLimit,
  parseLockWindow,
  parseUnlockReason,
  UNLOCK_REQUEST_NOTICE,
  UNLOCK_REQUEST_WINDOW_MS,
} from './locks-rules.js';
import type { LockWindow } from './locks-rules.js';
import { unlockRequestKeyPrefix } from './locks.repository.js';
import type { TimeLocksRepository } from './locks.repository.js';

/**
 * 52-03 — period locks, the lock half (approvals wait for 52-02 timesheets).
 *
 * - **Lock** (`finance.manage`): a window of whole calendar months that overlaps no open lock (409
 *   `period_overlaps`). The lock row is written first, in its own transaction, so a racing
 *   overlapping lock is refused there; then every unlocked entry with `spent_on` in the window gets
 *   `locked_at = now`, {@link LOCK_BATCH_SIZE} ids per transaction; the count lands on the row.
 * - **Unlock** (`finance.manage`, a why of 3..500 characters): the window's entries are cleared in
 *   batches first and the row is stamped reopened last, so a failure part-way leaves the lock open
 *   and the unlock can simply be sent again. The 52-09 rule (reopen only what is not yet invoiced)
 *   is not applied: no invoice exists yet.
 * - **Unlock request** (any internal member who tracks time): one inbox notice per `finance.manage`
 *   holder (the requester excepted), at most once per member per lock per 24 hours (else 429).
 *
 * Org-internal: client principals are refused before anything is read. Audit metadata holds the
 * window and counts only; the typed why lives on the lock row.
 */

export interface TimeLockView {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly open: boolean;
  readonly lockedBy: string;
  readonly lockedAt: string;
  readonly unlockedBy: string | null;
  readonly unlockedAt: string | null;
  readonly reason: string | null;
  readonly entriesLocked: number;
}

export interface TimeLockPage {
  readonly locks: readonly TimeLockView[];
  readonly nextCursor: string | null;
}

export interface TimeLocksServiceOptions {
  readonly database: Pick<TenantDatabase, 'transaction' | 'read'>;
  readonly repository: Pick<
    TimeLocksRepository,
    | 'list'
    | 'findById'
    | 'findOverlappingOpen'
    | 'findByStart'
    | 'insert'
    | 'reopenAsLocked'
    | 'setEntriesLocked'
    | 'markUnlocked'
    | 'stampBatch'
    | 'clearBatch'
    | 'financeCandidates'
    | 'unlockRequestedSince'
  >;
  readonly notifications: Pick<NotificationsRepository, 'insertForRecipient'>;
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

/** A batch loop never runs longer than this many rounds (5 M entries at 500). */
const MAX_BATCHES = 10_000;
const ER_DUP_ENTRY = 1062;
const ER_LOCK_DEADLOCK = 1213;

function errno(error: unknown): number | undefined {
  const of = (c: unknown): number | undefined =>
    typeof c === 'object' && c !== null ? (c as { errno?: number }).errno : undefined;
  return (
    of(error) ??
    (typeof error === 'object' && error !== null
      ? of((error as { cause?: unknown }).cause)
      : undefined)
  );
}

const overlaps = (): ApiError =>
  new ApiError(409, 'conflict', 'This period overlaps a locked period.', [
    { field: 'periodStart', message: 'period_overlaps' },
  ]);
const notOpen = (): ApiError =>
  new ApiError(409, 'conflict', 'This period is not locked.', [
    { field: 'lockId', message: 'lock_not_open' },
  ]);
const notFound = (): ApiError => new ApiError(404, 'not_found', MESSAGES.notFound);

function record(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
}

function lockId(raw: string): string {
  const id = optionalId(raw, 'lockId');
  if (id === null) throw notFound();
  return id;
}

export class TimeLocksService {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(private readonly options: TimeLocksServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? LOCK_BATCH_SIZE;
  }

  async list(
    context: TenantContext,
    principal: Principal,
    cursorRaw: string | undefined,
    limitRaw: string | undefined,
  ): Promise<TimeLockPage> {
    requireInternal(principal);
    const cursor = optionalId(cursorRaw, 'cursor');
    const limit = parseLockPageLimit(limitRaw);
    const rows = await this.options.database.read(context, (r) =>
      this.options.repository.list(r, context, cursor, limit + 1),
    );
    const page = rows.slice(0, limit);
    return {
      locks: page.map(lockView),
      nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  async lock(context: TenantContext, principal: Principal, body: unknown): Promise<TimeLockView> {
    requireInternal(principal);
    const input = record(body);
    const at = this.now();
    const window = parseLockWindow(input['periodStart'], input['periodEnd'], at);
    const repo = this.options.repository;

    let id: string;
    try {
      id = await this.options.database.transaction(context, async (tx) => {
        if ((await repo.findOverlappingOpen(tx, context, window)).length > 0) throw overlaps();
        const lock = { ...window, lockedBy: context.membershipId, lockedAt: at };
        const existing = await repo.findByStart(tx, context, window.periodStart);
        if (existing !== null) {
          // Only a reopened row can share the start: an open one overlaps and was refused above.
          await repo.reopenAsLocked(tx, context, existing.id, lock);
          return existing.id;
        }
        return repo.insert(tx, context, lock);
      });
    } catch (error) {
      const code = errno(error);
      if (code === ER_DUP_ENTRY || code === ER_LOCK_DEADLOCK) throw overlaps();
      throw error;
    }

    const entries = await this.inBatches(context, (tx) =>
      repo.stampBatch(tx, context, window, at, this.batchSize),
    );

    return this.options.database.transaction(context, async (tx) => {
      await repo.setEntriesLocked(tx, context, id, entries);
      await this.audit(tx, context, 'time_period.locked', id, window, {
        entries_locked: entries,
      });
      const row = await repo.findById(tx, context, id);
      if (row === null) throw new Error('time period lock vanished after it was written');
      return lockView(row);
    });
  }

  async unlock(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<TimeLockView> {
    requireInternal(principal);
    const id = lockId(idRaw);
    const reason = parseUnlockReason(record(body)['reason']);
    const repo = this.options.repository;
    const row = await this.options.database.read(context, (r) => repo.findById(r, context, id));
    if (row === null) throw notFound();
    if (row.unlockedAt !== null) throw notOpen();
    const window: LockWindow = { periodStart: row.periodStart, periodEnd: row.periodEnd };

    // 52-09 (later): only entries not yet invoiced may be reopened. No invoice exists yet.
    const cleared = await this.inBatches(context, (tx) =>
      repo.clearBatch(tx, context, window, this.batchSize),
    );

    const at = this.now();
    return this.options.database.transaction(context, async (tx) => {
      if ((await repo.markUnlocked(tx, context, id, context.membershipId, at, reason)) === 0) {
        throw notOpen();
      }
      await this.audit(tx, context, 'time_period.unlocked', id, window, {
        entries_unlocked: cleared,
      });
      const updated = await repo.findById(tx, context, id);
      if (updated === null) throw new Error('time period lock vanished after it was written');
      return lockView(updated);
    });
  }

  async requestUnlock(
    context: TenantContext,
    principal: Principal,
    idRaw: string,
    body: unknown,
  ): Promise<{ readonly notified: number }> {
    requireInternal(principal);
    const id = lockId(idRaw);
    // Validated so the request carries a why; the notice itself holds ids only (no text column).
    parseUnlockReason(record(body)['reason']);
    const at = this.now();
    const repo = this.options.repository;
    return this.options.database.transaction(context, async (tx) => {
      const row = await repo.findById(tx, context, id);
      if (row === null) throw notFound();
      if (row.unlockedAt !== null) throw notOpen();
      const since = new Date(at.getTime() - UNLOCK_REQUEST_WINDOW_MS);
      if (
        await repo.unlockRequestedSince(
          tx,
          context,
          UNLOCK_REQUEST_NOTICE,
          id,
          context.membershipId,
          since,
        )
      ) {
        throw new ApiError(429, 'rate_limited', 'You already asked to reopen this period today.');
      }
      const recipients = financeManagers(await repo.financeCandidates(tx, context)).filter(
        (userId) => userId !== context.userId,
      );
      const dedupeKey = `${unlockRequestKeyPrefix(id, context.membershipId)}${at.getTime()}`;
      for (const recipientUserId of recipients) {
        await this.options.notifications.insertForRecipient(tx, context, {
          recipientUserId,
          type: UNLOCK_REQUEST_NOTICE,
          objectType: 'time_period_lock',
          objectId: id,
          dedupeKey,
        });
      }
      await this.audit(
        tx,
        context,
        'time_period.unlock_requested',
        id,
        { periodStart: row.periodStart, periodEnd: row.periodEnd },
        { recipients: recipients.length },
      );
      return { notified: recipients.length };
    });
  }

  /** Run `step` in its own transaction until a batch comes back short; the changed rows summed. */
  private async inBatches(
    context: TenantContext,
    step: (tx: TenantQueryRunner) => Promise<{ readonly picked: number; readonly changed: number }>,
  ): Promise<number> {
    let total = 0;
    for (let round = 0; round < MAX_BATCHES; round += 1) {
      const { picked, changed } = await this.options.database.transaction(context, step);
      total += changed;
      if (picked < this.batchSize) break;
    }
    return total;
  }

  private audit(
    tx: TenantQueryRunner,
    context: TenantContext,
    action: 'time_period.locked' | 'time_period.unlocked' | 'time_period.unlock_requested',
    objectId: string,
    window: LockWindow,
    counts: Record<string, number>,
  ): Promise<unknown> {
    return this.options.audit.record(tx, context, {
      action,
      result: 'allowed',
      objectId,
      actorUserId: context.userId,
      metadata: { period_start: window.periodStart, period_end: window.periodEnd, ...counts },
    });
  }
}

function lockView(row: TimePeriodLockRow): TimeLockView {
  return {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    open: row.unlockedAt === null,
    lockedBy: row.lockedBy,
    lockedAt: row.lockedAt.toISOString(),
    unlockedBy: row.unlockedBy,
    unlockedAt: row.unlockedAt?.toISOString() ?? null,
    reason: row.reason,
    entriesLocked: row.entriesLocked,
  };
}
