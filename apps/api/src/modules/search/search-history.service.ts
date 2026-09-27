import type { SearchHistoryRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SearchHistoryRepository } from './search-history.repository.js';

/**
 * Search recent history (x288) — the application service.
 *
 * One small surface over one private, per-member table (`search_history`): record a query the
 * member ran, list their most-recent {@link SEARCH_HISTORY_LIMIT} (newest first), and clear the
 * list. Every row is private to one member in one studio. The route ceiling is `search.use`
 * (reused, no `capabilities.ts` edit); the object-level rule — a member reads and clears only their
 * **own** history — is enforced here and in the repository, which scopes every operation by
 * `organization_id` AND `membership_id`. A cross-tenant or cross-member read matches nothing.
 */

/** How many recent queries the service keeps and returns per member — the retention cap. */
export const SEARCH_HISTORY_LIMIT = 20;

/** One recent query — paired Exact with the web's `SearchHistoryEntry` in the contracts gate. */
export interface SearchHistoryEntryView {
  readonly query: string;
  readonly recordedAt: string;
}

export class SearchHistoryService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SearchHistoryRepository = new SearchHistoryRepository(),
  ) {}

  /**
   * Record one query for the acting member (dedupe-refresh to the front, then prune to
   * {@link SEARCH_HISTORY_LIMIT}). The query is already trimmed, single-spaced and length-capped by
   * the controller — a blank query never reaches here (it is a 400 with no insert).
   */
  async record(context: TenantContext, query: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.repository.record(tx, context, query);
      await this.repository.prune(tx, context, SEARCH_HISTORY_LIMIT);
    });
  }

  /** The acting member's recent queries, most-recent first, bounded to {@link SEARCH_HISTORY_LIMIT}. */
  async listRecent(context: TenantContext): Promise<readonly SearchHistoryEntryView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listRecent(runner, context, SEARCH_HISTORY_LIMIT),
    );
    return rows.map((row) => toView(row));
  }

  /** Clear the acting member's history — only their own rows in the acting studio are removed. */
  async clear(context: TenantContext): Promise<void> {
    await this.database.transaction(context, (tx) => this.repository.clear(tx, context));
  }
}

/** Project a row to the wire shape. */
function toView(row: SearchHistoryRow): SearchHistoryEntryView {
  return { query: row.query, recordedAt: row.createdAt.toISOString() };
}
