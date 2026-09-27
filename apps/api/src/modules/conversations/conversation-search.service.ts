import type { Principal } from '@tmanage/domain';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MessageRow } from '../../common/database/schema.js';
import type { ConversationsService } from './conversations.service.js';
import type { ConversationSearchRepository } from './conversation-search.repository.js';

/**
 * CH-10 "Search in conversation" — the application service (x253).
 *
 * Read-only, and it owns no gate of its own: the conversation is resolved and authorised by
 * {@link ConversationsService.get}, which is `conversation.read` plus the channel-membership
 * narrowing every other conversation read applies. That call resolves the conversation
 * `(tenant, id)` **before** the read below and answers **404** — not 403 — for a conversation
 * in another tenant or one the principal is not in, so a search can never confirm that a
 * channel exists to somebody who cannot read it, and no message row is ever read for it.
 *
 * The search itself is a case-insensitive substring match over the messages of that one
 * conversation. Moderated messages are excluded in the repository, so a snippet never reads a
 * withheld body back out. A blank query returns an empty result rather than an error, and the
 * page size is capped, so no input yields an unbounded scan.
 */

/** One match: enough to show author, time and a highlighted snippet. `organizationId` is absent. */
export interface MessageSearchMatchView {
  readonly id: string;
  readonly conversationId: string;
  readonly authorUserId: string;
  readonly sequenceNo: number;
  readonly createdAt: string;
  /** A window of the body around the first match, truncated with ellipses when clipped. */
  readonly snippet: string;
}

export interface SearchMessagesCommand {
  readonly q: string;
  /** 1-based page number. Absent or below 1 is treated as the first page. */
  readonly page?: number;
  readonly limit?: number;
}

/** The default page size when the caller names no `limit`. */
const DEFAULT_PAGE_SIZE = 25;
/** The largest page the search returns, whatever the caller asks for. */
const MAX_PAGE_SIZE = 50;
/** Characters of context kept on each side of a match before it is truncated. */
const SNIPPET_RADIUS = 80;

/**
 * A window of `body` around the first case-insensitive occurrence of `term`, with an ellipsis on
 * whichever side was clipped. When the term is not found (it always is — the row matched the same
 * `LIKE`) the body's head is returned, so this degrades to a safe preview rather than throwing.
 */
function buildSnippet(body: string, term: string): string {
  const found = body.toLowerCase().indexOf(term.toLowerCase());
  const at = found === -1 ? 0 : found;
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(body.length, at + term.length + SNIPPET_RADIUS);
  const core = body.slice(start, end);
  return `${start > 0 ? '…' : ''}${core}${end < body.length ? '…' : ''}`;
}

export class ConversationSearchService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly conversations: ConversationsService,
    private readonly search: ConversationSearchRepository,
  ) {}

  async searchMessages(
    context: TenantContext,
    principal: Principal,
    conversationId: string,
    command: SearchMessagesCommand,
  ): Promise<readonly MessageSearchMatchView[]> {
    // Resolve + authorise first: a conversation in another tenant, or one this principal is not
    // in, is a 404 here — before any message is read.
    await this.conversations.get(context, principal, conversationId);

    const term = command.q.trim();
    // A blank query is an empty result, not an error and not a scan of the whole channel.
    if (term === '') return [];

    const limit = Math.min(Math.max(command.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const page = Math.max(command.page ?? 1, 1);
    const offset = (page - 1) * limit;

    const rows = await this.database.read(context, (runner) =>
      this.search.searchMessages(runner, context, { conversationId, term, limit, offset }),
    );

    return rows.map((row) => this.toMatchView(row, term));
  }

  private toMatchView(row: MessageRow, term: string): MessageSearchMatchView {
    return {
      id: row.id,
      conversationId: row.conversationId,
      authorUserId: row.authorUserId,
      sequenceNo: Number(row.sequenceNo),
      createdAt: row.createdAt.toISOString(),
      snippet: buildSnippet(row.body, term),
    };
  }
}
