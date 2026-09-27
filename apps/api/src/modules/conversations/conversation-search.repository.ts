import { and, asc, eq, isNull, like } from 'drizzle-orm';
import { tenantDrizzle } from '../../common/database/drizzle.js';
import { messages } from '../../common/database/schema.js';
import type { MessageRow } from '../../common/database/schema.js';
import type { TenantContext, TenantQueryRunner } from '../../common/database/tenant-context.js';

/**
 * CH-10 "Search in conversation" — the storage half (x253). Read-only: given a resolved
 * conversation and a search term, it finds the messages of *that* conversation whose body
 * contains the term.
 *
 * `25-AUTH-AND-TENANT-ISOLATION` §6 is honoured structurally, the way
 * `PersonSkillSearchRepository` honours it:
 *
 * 1. **No unscoped read.** The only method takes `TenantQueryRunner` and `TenantContext`; there is
 *    no overload without a context.
 * 2. **The tenant comes from the context, never the query.** `conversationId`/`term` are values to
 *    filter on, never a tenant selector — `organization_id = context` is on the statement.
 * 3. **Never leaks outside the conversation.** `conversation_id = <resolved id>` is on every row,
 *    so a match can only ever be a message of the conversation the caller was authorised for.
 *
 * A moderated message is excluded (`deleted_at IS NULL`): its body is withheld everywhere else,
 * and a search that returned a snippet of it would read the withheld content back out. The row
 * count is bounded by the caller — the controller passes a capped `limit`, and keyset paging is
 * on the sequence number, the conversation's own order.
 */

export interface SearchMessagesQuery {
  /** The conversation the caller has already been authorised to read. */
  readonly conversationId: string;
  /** The normalised, non-empty search term. `LIKE` wildcards in it are escaped. */
  readonly term: string;
  /** The capped page size. */
  readonly limit: number;
  /** Rows to skip — `(page - 1) * limit`, computed by the caller. */
  readonly offset: number;
}

/**
 * `%` and `_` are `LIKE`'s own wildcards and `\` its escape character. Escaped so the pattern
 * means what was typed rather than matching more than the caller asked for — the same reasoning
 * `MembershipsRepository.escapeLikePattern` records. This is not injection defence: the pattern
 * is a bound parameter and the tenant guard would refuse it if it were not.
 */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export class ConversationSearchRepository {
  /**
   * The messages of one conversation whose body contains `term`, in the conversation's own
   * order. Tenant-scoped and conversation-scoped on every row; moderated messages excluded;
   * bounded to `limit` rows, skipping `offset` for page-number paging.
   *
   * `LIKE` is case-insensitive here because the column's collation (`utf8mb4`) is, so a search
   * for "atlas" finds "Atlas" without the query naming a collation.
   */
  async searchMessages(
    runner: TenantQueryRunner,
    context: TenantContext,
    query: SearchMessagesQuery,
  ): Promise<readonly MessageRow[]> {
    return tenantDrizzle(runner)
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.organizationId, context.organizationId),
          eq(messages.conversationId, query.conversationId),
          isNull(messages.deletedAt),
          like(messages.body, `%${escapeLikePattern(query.term)}%`),
        ),
      )
      .orderBy(asc(messages.sequenceNo))
      .limit(query.limit)
      .offset(query.offset);
  }
}
