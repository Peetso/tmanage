import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AiActivityRepository } from './ai-activity.repository.js';
import type { AiActivityCursor, AiToolCallRow } from './ai-activity.repository.js';

export type { AiActivityCursor, AiToolCallRow } from './ai-activity.repository.js';

/**
 * **The audit context's published read of a member's own connected-AI tool calls (AI panel).**
 *
 * `audit_events` is owned by this context (AR-7); the AI panel reads it only through this service
 * (AR-5). The rows are the caller's own (actor = the caller's user, `membership_id` = the
 * caller's membership, `mcp.tool_called` only): there is no parameter that widens them, so the
 * read needs no capability beyond being that member.
 */
export class AiActivityReader {
  constructor(
    private readonly database: Pick<TenantDatabase, 'read'>,
    private readonly repository: AiActivityRepository = new AiActivityRepository(),
  ) {}

  /** At most `limit` of the caller's own rows older than `before`, newest first. */
  listOwn(
    context: TenantContext,
    before: AiActivityCursor | null,
    limit: number,
  ): Promise<AiToolCallRow[]> {
    return this.database.read(context, (runner) =>
      this.repository.listOwn(runner, context, before, limit),
    );
  }
}
