import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { softDeleteValues } from '../../common/database/content-retention.js';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { fileVersions, reviewThreads } from '../../common/database/schema.js';
import type { ReviewThreadRow } from '../../common/database/schema.js';
import type {
  QueryRows,
  TenantContext,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { parseMeta } from './file-previews.repository.js';

/**
 * R4 slice 5 (0268) — proofing threads: the numbered pin (or box, drawing, moment, cell) and its
 * place on a file. Storage only; who may do what is the service's.
 *
 * `FileCommentsRepository`'s shape: `TenantContext` scopes every statement, no input carries an
 * `organizationId`, and the runner is a parameter. Two things are particular to threads:
 *
 * - **Numbering.** {@link ReviewThreadsRepository.lockNextNumber} reads `MAX(number)` for the
 *   subject `FOR UPDATE` — it must run inside the transaction that inserts — and the unique key
 *   `uq_review_threads_number` turns a lost race into {@link DuplicateThreadNumberError}, which the
 *   service retries. Soft-deleted threads keep their number, so a number is never reused.
 * - **Audience is immutable** (0268 trigger): nothing here can change it; there is no method that
 *   writes the column after the insert.
 *
 * `anchor` comes back from MariaDB as text (its JSON is LONGTEXT); every read parses it.
 */

export const REVIEW_SUBJECT_TYPES = ['file_asset', 'figma_frame'] as const;
export type ReviewSubjectType = (typeof REVIEW_SUBJECT_TYPES)[number];

export const REVIEW_ANCHOR_KINDS = ['pin', 'box', 'draw', 'time', 'cell', 'none'] as const;
export type ReviewAnchorKind = (typeof REVIEW_ANCHOR_KINDS)[number];

export const REVIEW_AUDIENCES = ['internal', 'client_visible'] as const;
export type ReviewAudience = (typeof REVIEW_AUDIENCES)[number];

export const REVIEW_THREAD_STATUSES = ['open', 'resolved'] as const;
export type ReviewThreadStatus = (typeof REVIEW_THREAD_STATUSES)[number];

/** The most threads one subject read returns. */
export const MAX_REVIEW_THREADS_PAGE = 500;

/** A thread as callers read it: `anchor` parsed, the closed lists narrowed. */
export interface ReviewThread extends Omit<
  ReviewThreadRow,
  'anchor' | 'subjectType' | 'anchorKind' | 'audience' | 'status'
> {
  readonly subjectType: ReviewSubjectType;
  readonly anchorKind: ReviewAnchorKind;
  readonly audience: ReviewAudience;
  readonly status: ReviewThreadStatus;
  readonly anchor: Readonly<Record<string, unknown>> | null;
}

export interface InsertReviewThreadInput {
  readonly projectId: string;
  readonly subjectType: ReviewSubjectType;
  readonly subjectId: string;
  readonly fileVersionId: string | null;
  readonly anchorKind: ReviewAnchorKind;
  readonly anchor: Readonly<Record<string, unknown>> | null;
  readonly pageNo: number | null;
  readonly timeMs: number | null;
  readonly number: number;
  readonly audience: ReviewAudience;
  readonly createdByMembershipId: string;
  readonly carriedFromThreadId?: string | null;
}

export interface ListReviewThreadsInput {
  readonly subjectType: ReviewSubjectType;
  readonly subjectId: string;
  /** Only threads drawn on this uploaded version. */
  readonly fileVersionId?: string | undefined;
  readonly status?: ReviewThreadStatus | undefined;
  /** The audiences the caller may see — a client passes `['client_visible']`. */
  readonly audiences: readonly ReviewAudience[];
}

export interface MoveReviewThreadInput {
  readonly anchor: Readonly<Record<string, unknown>> | null;
  readonly pageNo: number | null;
  readonly timeMs: number | null;
}

/** Two writers took the same `MAX(number)`; the second insert lost. The service retries. */
export class DuplicateThreadNumberError extends Error {
  constructor() {
    super('review thread number already taken');
    this.name = 'DuplicateThreadNumberError';
  }
}

const ER_DUP_ENTRY = 1062;
const ER_LOCK_DEADLOCK = 1213;
/** MariaDB 11.8 (`innodb_snapshot_isolation`): a locking read met a row newer than the snapshot. */
const ER_CHECKREAD = 1020;

function hasErrno(error: unknown, errno: number, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const candidate = current as { errno?: unknown; code?: unknown; cause?: unknown };
    if (candidate.errno === errno || candidate.code === code) return true;
    current = candidate.cause;
  }
  return false;
}

function isDuplicateKey(error: unknown): boolean {
  return hasErrno(error, ER_DUP_ENTRY, 'ER_DUP_ENTRY');
}

/**
 * A numbering race the caller may simply run again in a new transaction: a lost duplicate key;
 * the deadlock InnoDB picks when two first pins on one file both hold the empty range's gap lock
 * and both insert; or MariaDB 11.8's snapshot-isolation refusal (`ER_CHECKREAD`) when the locking
 * MAX read meets a pin another writer committed after this transaction's snapshot began.
 */
export function isRetryableNumberRace(error: unknown): boolean {
  return (
    error instanceof DuplicateThreadNumberError ||
    hasErrno(error, ER_LOCK_DEADLOCK, 'ER_LOCK_DEADLOCK') ||
    hasErrno(error, ER_CHECKREAD, 'ER_CHECKREAD')
  );
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

export function toReviewThread(row: ReviewThreadRow): ReviewThread {
  return {
    ...row,
    subjectType: row.subjectType as ReviewSubjectType,
    anchorKind: row.anchorKind as ReviewAnchorKind,
    audience: row.audience as ReviewAudience,
    status: row.status as ReviewThreadStatus,
    anchor: parseMeta(row.anchor as unknown),
  };
}

export class ReviewThreadsRepository {
  /**
   * The next pin number for a subject, taken under a lock. **Must run inside a transaction**: on
   * an autocommit connection the lock would be released at once. Written out because Drizzle's
   * proxy dialect has no `.for('update')`.
   */
  async lockNextNumber(
    runner: TenantQueryRunner,
    context: TenantContext,
    subjectType: ReviewSubjectType,
    subjectId: string,
  ): Promise<number> {
    const rows = await runner.execute<QueryRows>(
      `select coalesce(max(number), 0) as max_number from review_threads
        where organization_id = ? and subject_type = ? and subject_id = ?
        for update`,
      [context.organizationId, subjectType, subjectId],
    );
    const max = Number(rows[0]?.['max_number'] ?? 0);
    return (Number.isSafeInteger(max) && max > 0 ? max : 0) + 1;
  }

  /** Insert a thread. A taken number raises {@link DuplicateThreadNumberError}. */
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertReviewThreadInput,
  ): Promise<ReviewThread> {
    const id = uuidv7();
    try {
      await tenantDrizzle(runner)
        .insert(reviewThreads)
        .values({
          id,
          organizationId: context.organizationId,
          projectId: input.projectId,
          subjectType: input.subjectType,
          subjectId: input.subjectId,
          fileVersionId: input.fileVersionId,
          anchorKind: input.anchorKind,
          anchor: input.anchor === null ? null : { ...input.anchor },
          pageNo: input.pageNo,
          timeMs: input.timeMs,
          number: input.number,
          audience: input.audience,
          status: 'open',
          carriedFromThreadId: input.carriedFromThreadId ?? null,
          createdByMembershipId: input.createdByMembershipId,
          createdAt: sql`current_timestamp(3)`,
          updatedAt: sql`current_timestamp(3)`,
        });
    } catch (error) {
      if (isDuplicateKey(error)) throw new DuplicateThreadNumberError();
      throw error;
    }
    const created = await this.findById(runner, context, id);
    if (!created) throw new Error('review thread vanished immediately after insert');
    return created;
  }

  /** One thread of this tenant, live or soft-deleted; `null` if absent. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
  ): Promise<ReviewThread | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(reviewThreads)
      .where(
        and(
          eq(reviewThreads.organizationId, context.organizationId),
          eq(reviewThreads.id, threadId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toReviewThread(row) : null;
  }

  /** One subject's live threads the caller may see, in pin-number order. Bounded. */
  async listForSubject(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: ListReviewThreadsInput,
  ): Promise<readonly ReviewThread[]> {
    if (input.audiences.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select()
      .from(reviewThreads)
      .where(
        and(
          eq(reviewThreads.organizationId, context.organizationId),
          eq(reviewThreads.subjectType, input.subjectType),
          eq(reviewThreads.subjectId, input.subjectId),
          inArray(reviewThreads.audience, [...input.audiences]),
          input.fileVersionId === undefined
            ? undefined
            : eq(reviewThreads.fileVersionId, input.fileVersionId),
          input.status === undefined ? undefined : eq(reviewThreads.status, input.status),
          isNull(reviewThreads.deletedAt),
        ),
      )
      .orderBy(asc(reviewThreads.number))
      .limit(MAX_REVIEW_THREADS_PAGE);
    return rows.map(toReviewThread);
  }

  /**
   * Resolve (`membershipId` given) or reopen (`null`). Conditional on the status changing, so a
   * second click is a no-op; `true` when the row moved.
   */
  async setResolved(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
    resolvedBy: string | null,
  ): Promise<boolean> {
    const resolving = resolvedBy !== null;
    const result = await tenantDrizzle(runner)
      .update(reviewThreads)
      .set({
        status: resolving ? 'resolved' : 'open',
        resolvedByMembershipId: resolvedBy,
        resolvedAt: resolving ? sql`current_timestamp(3)` : null,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(reviewThreads.organizationId, context.organizationId),
          eq(reviewThreads.id, threadId),
          ne(reviewThreads.status, resolving ? 'resolved' : 'open'),
          isNull(reviewThreads.deletedAt),
        ),
      );
    return affected(result) > 0;
  }

  /** Move a pin (the anchor and its page / moment). The version and number stay. */
  async moveAnchor(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
    input: MoveReviewThreadInput,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(reviewThreads)
      .set({
        anchor: input.anchor === null ? null : { ...input.anchor },
        pageNo: input.pageNo,
        timeMs: input.timeMs,
        updatedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(reviewThreads.organizationId, context.organizationId),
          eq(reviewThreads.id, threadId),
          isNull(reviewThreads.deletedAt),
        ),
      );
    return affected(result) > 0;
  }

  /** PA-03 soft delete (with the restore window). `true` when a live thread was removed. */
  async softDelete(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(reviewThreads)
      .set(await softDeleteValues(runner, context.userId, null))
      .where(
        and(
          eq(reviewThreads.organizationId, context.organizationId),
          eq(reviewThreads.id, threadId),
          isNull(reviewThreads.deletedAt),
        ),
      );
    return affected(result) > 0;
  }

  /** The file asset an uploaded version belongs to — the gate a thread-only route goes through. */
  async assetOfVersion(
    runner: TenantQueryRunner,
    context: TenantContext,
    fileVersionId: string,
  ): Promise<string | null> {
    const rows = await tenantDrizzle(runner)
      .select({ fileAssetId: fileVersions.fileAssetId })
      .from(fileVersions)
      .where(
        and(
          eq(fileVersions.organizationId, context.organizationId),
          eq(fileVersions.id, fileVersionId),
        ),
      )
      .limit(1);
    return rows[0]?.fileAssetId ?? null;
  }
}
