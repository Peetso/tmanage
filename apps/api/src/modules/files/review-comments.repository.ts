import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { uuidv7 } from '@tmanage/domain';
import { softDeleteValues } from '../../common/database/content-retention.js';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { reviewComments } from '../../common/database/schema.js';
import type { ReviewCommentRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * R4 slice 5 (0268) — what people said on a proofing thread, oldest first. Storage only: the
 * service decides who may read, reply, edit (own, within a short window) or delete (own).
 *
 * Every statement names the acting tenant. `mentions` is the user ids the comment names; MariaDB
 * answers the JSON column as text, so every read parses it into a list.
 */

/** The most comments one read of a page of threads returns. */
export const MAX_REVIEW_COMMENTS_PAGE = 2000;

/** A comment as callers read it: `mentions` parsed. */
export interface ReviewComment extends Omit<ReviewCommentRow, 'mentions'> {
  readonly mentions: readonly string[];
}

export interface InsertReviewCommentInput {
  readonly threadId: string;
  readonly body: string;
  readonly mentions: readonly string[];
  readonly createdByMembershipId: string;
}

/** MariaDB answers a JSON column as its text; MySQL and the fakes answer the value. */
export function parseMentions(value: unknown): readonly string[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function toReviewComment(row: ReviewCommentRow): ReviewComment {
  return { ...row, mentions: parseMentions(row.mentions as unknown) };
}

function affected(result: unknown): number {
  const header = Array.isArray(result) ? (result[0] as unknown) : result;
  const rows = (header as { affectedRows?: unknown } | null)?.affectedRows;
  return typeof rows === 'number' ? rows : 0;
}

export class ReviewCommentsRepository {
  async insert(
    runner: TenantQueryRunner,
    context: TenantContext,
    input: InsertReviewCommentInput,
  ): Promise<ReviewComment> {
    const id = uuidv7();
    await tenantDrizzle(runner)
      .insert(reviewComments)
      .values({
        id,
        organizationId: context.organizationId,
        threadId: input.threadId,
        body: input.body,
        mentions: input.mentions.length === 0 ? null : [...input.mentions],
        createdByMembershipId: input.createdByMembershipId,
        createdAt: sql`current_timestamp(3)`,
      });
    const created = await this.findById(runner, context, id);
    if (!created) throw new Error('review comment vanished immediately after insert');
    return created;
  }

  /** One comment of this tenant, live or soft-deleted; `null` if absent. */
  async findById(
    runner: TenantQueryRunner,
    context: TenantContext,
    commentId: string,
  ): Promise<ReviewComment | null> {
    const rows = await tenantDrizzle(runner)
      .select()
      .from(reviewComments)
      .where(
        and(
          eq(reviewComments.organizationId, context.organizationId),
          eq(reviewComments.id, commentId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toReviewComment(row) : null;
  }

  /** The live comments of these threads, oldest first. Bounded. */
  async listForThreads(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadIds: readonly string[],
  ): Promise<readonly ReviewComment[]> {
    if (threadIds.length === 0) return [];
    const rows = await tenantDrizzle(runner)
      .select()
      .from(reviewComments)
      .where(
        and(
          eq(reviewComments.organizationId, context.organizationId),
          inArray(reviewComments.threadId, [...threadIds]),
          isNull(reviewComments.deletedAt),
        ),
      )
      .orderBy(asc(reviewComments.createdAt), asc(reviewComments.id))
      .limit(MAX_REVIEW_COMMENTS_PAGE);
    return rows.map(toReviewComment);
  }

  /** Replace a live comment's text and mentions, stamping `edited_at`. */
  async editBody(
    runner: TenantQueryRunner,
    context: TenantContext,
    commentId: string,
    body: string,
    mentions: readonly string[],
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(reviewComments)
      .set({
        body,
        mentions: mentions.length === 0 ? null : [...mentions],
        editedAt: sql`current_timestamp(3)`,
      })
      .where(
        and(
          eq(reviewComments.organizationId, context.organizationId),
          eq(reviewComments.id, commentId),
          isNull(reviewComments.deletedAt),
        ),
      );
    return affected(result) > 0;
  }

  /** PA-03 soft delete (with the restore window). `true` when a live comment was removed. */
  async softDelete(
    runner: TenantQueryRunner,
    context: TenantContext,
    commentId: string,
  ): Promise<boolean> {
    const result = await tenantDrizzle(runner)
      .update(reviewComments)
      .set(await softDeleteValues(runner, context.userId, null))
      .where(
        and(
          eq(reviewComments.organizationId, context.organizationId),
          eq(reviewComments.id, commentId),
          isNull(reviewComments.deletedAt),
        ),
      );
    return affected(result) > 0;
  }

  /** How many live comments a thread still has (the last delete removes the thread too). */
  async countLive(
    runner: TenantQueryRunner,
    context: TenantContext,
    threadId: string,
  ): Promise<number> {
    const rows = await tenantDrizzle(runner)
      .select({ n: sql<number>`count(*)` })
      .from(reviewComments)
      .where(
        and(
          eq(reviewComments.organizationId, context.organizationId),
          eq(reviewComments.threadId, threadId),
          isNull(reviewComments.deletedAt),
        ),
      );
    return Number(rows[0]?.n ?? 0);
  }
}
