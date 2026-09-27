import { Body, Controller, Delete, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { Ctx, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { SEARCH_HISTORY_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { SearchHistoryEntryView, SearchHistoryService } from './search-history.service.js';

/**
 * Search recent history (x288). The HTTP surface over `search_history` — a member's own recent
 * queries: record one, list the most-recent, clear them all.
 *
 * Every route sits behind `@RequireCapability('search.use')` — the SRCH-01 search capability,
 * **reused** so this slice stays off `capabilities.ts` and the role grid. A caller without it (a
 * client principal) is refused by the global `CapabilityGuard` with a 403 before any handler runs.
 * No route reads an `organizationId` or a `membershipId` from anywhere: the tenant and the acting
 * member are `TenantContextGuard`'s, and a recent query is always the acting member's own — the
 * object rule the service and repository enforce (own-scoped reads, clear and prune, by
 * `organization_id` AND `membership_id`).
 */
@Controller('v1/organizations/:orgSlug/search/history')
export class SearchHistoryController {
  constructor(@Inject(SEARCH_HISTORY_SERVICE) private readonly history: SearchHistoryService) {}

  /**
   * Record one query the acting member ran, then return their recent list (200 — a repeat refreshes
   * an existing row rather than creating one, so this is not a 201). A blank query, or one longer
   * than {@link MAX_QUERY_LENGTH} after trimming, is a 400 with no insert.
   */
  @Post()
  @RequireCapability('search.use')
  @HttpCode(200)
  async record(
    @Ctx() context: TenantContext,
    @Body() body: RecordBody,
  ): Promise<{ readonly history: readonly SearchHistoryEntryView[] }> {
    await this.history.record(context, parseQuery(body));
    return { history: await this.history.listRecent(context) };
  }

  /** The acting member's recent queries, most-recent first and bounded (200). */
  @Get()
  @RequireCapability('search.use')
  async list(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly history: readonly SearchHistoryEntryView[] }> {
    return { history: await this.history.listRecent(context) };
  }

  /**
   * Clear the acting member's history (200). Own-scoped: only the caller-membership rows are
   * removed, so a clear never reaches another member's or another studio's history. Returns the
   * now-empty list.
   */
  @Delete()
  @RequireCapability('search.use')
  @HttpCode(200)
  async clear(
    @Ctx() context: TenantContext,
  ): Promise<{ readonly history: readonly SearchHistoryEntryView[] }> {
    await this.history.clear(context);
    return { history: await this.history.listRecent(context) };
  }
}

interface RecordBody {
  readonly query?: unknown;
}

/** The query column is `VARCHAR(300)`; the SRCH-01 search bounds `q` the same way. */
const MAX_QUERY_LENGTH = 300;

/**
 * Validate and normalise the request body into the query to record, or throw a 400. The query is
 * trimmed and internal whitespace collapsed to single spaces (so ` open  bugs ` and `open bugs`
 * dedupe to one row); a blank query, or one longer than {@link MAX_QUERY_LENGTH} after normalising,
 * is rejected with no insert.
 */
function parseQuery(body: RecordBody): string {
  const raw = typeof body?.query === 'string' ? body.query : '';
  const query = raw.trim().replace(/\s+/g, ' ');
  if (query.length === 0) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'query', message: 'must be a non-empty string' },
    ]);
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field: 'query', message: `must be ${MAX_QUERY_LENGTH} characters or fewer` },
    ]);
  }
  return query;
}
