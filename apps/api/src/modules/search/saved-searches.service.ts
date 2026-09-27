import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { SavedSearchFilter, SavedSearchRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { SavedSearchesRepository } from './saved-searches.repository.js';

/**
 * SRCH saved/recent searches (x214) — the application service.
 *
 * Two small surfaces over one private, per-user table (`saved_searches`):
 *
 *   - **Saved searches** the owner keeps by name (`create` / `list` / `delete`).
 *   - **Recent searches** the owner ran, recorded as a side effect of the global search and read
 *     back most-recent-first, bounded to {@link RECENT_LIMIT}.
 *
 * Both are private to one user in one studio. The route ceiling is `search.use` (reused, no
 * `capabilities.ts` edit); the object-level rule — a member may read and delete only their **own**
 * saved and recent searches — is enforced here and in the repository, which scopes every operation
 * by `organization_id` AND `user_id`. A saved-search id that names another user's row or another
 * studio's row matches nothing and is a 404, never a leak that the row exists.
 */

/** How many recent queries the service keeps and returns per user — a short, bounded list. */
export const RECENT_LIMIT = 10;

/** A saved search as the client reads it — paired Exact with the web's shape in the contracts gate. */
export interface SavedSearchView {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly filters: readonly SavedSearchFilter[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One recent query — paired Exact with the web's `RecentSearch` in the contracts gate. */
export interface RecentSearchView {
  readonly query: string;
  readonly searchedAt: string;
}

/** The validated create body — request-side, so the contracts gate drops the `Input` suffix. */
export interface SavedSearchInput {
  readonly name: string;
  readonly query: string;
  readonly filters: readonly SavedSearchFilter[];
}

export class SavedSearchesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SavedSearchesRepository = new SavedSearchesRepository(),
  ) {}

  /** The acting user's saved searches, newest first. */
  async listSaved(context: TenantContext): Promise<readonly SavedSearchView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listSaved(runner, context),
    );
    return rows.map((row) => toSavedSearchView(row));
  }

  /** Persist a new saved search owned by the acting user. */
  async createSaved(context: TenantContext, input: SavedSearchInput): Promise<SavedSearchView> {
    const row = await this.database.transaction(context, (tx) =>
      this.repository.insertSaved(tx, context, {
        name: input.name,
        query: input.query,
        filters: input.filters,
      }),
    );
    return toSavedSearchView(row);
  }

  /**
   * Delete the acting user's saved search by id. Own-scoped: an id that names another user's row,
   * another studio's row, a recent, or nothing removes nothing and is a 404 — the existence of a
   * saved search is never disclosed to anyone but its owner.
   */
  async deleteSaved(context: TenantContext, id: string): Promise<void> {
    const removed = await this.database.transaction(context, (tx) =>
      this.repository.deleteSavedOwned(tx, context, id),
    );
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }

  /** The acting user's recent queries, most-recent first, bounded to {@link RECENT_LIMIT}. */
  async listRecent(context: TenantContext): Promise<readonly RecentSearchView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.listRecent(runner, context, RECENT_LIMIT),
    );
    return rows.map((row) => ({ query: row.queryText, searchedAt: row.createdAt.toISOString() }));
  }

  /**
   * Record one recent query for the acting user (dedup to front, insert, prune to
   * {@link RECENT_LIMIT}). Called from the global search after a successful run.
   */
  async recordRecent(context: TenantContext, query: string): Promise<void> {
    await this.database.transaction(context, (tx) =>
      this.repository.recordRecent(tx, context, query, RECENT_LIMIT),
    );
  }
}

/** Project a row to the wire shape. `name` is always set on a saved row (the write enforces it). */
function toSavedSearchView(row: SavedSearchRow): SavedSearchView {
  return {
    id: row.id,
    name: row.name ?? '',
    query: row.queryText,
    filters: row.filters,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
