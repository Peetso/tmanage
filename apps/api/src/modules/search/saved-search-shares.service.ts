import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { SavedSearchFilter } from '../../common/database/schema.js';
import type {
  TenantContext,
  TenantDatabase,
  TenantQueryRunner,
} from '../../common/database/tenant-context.js';
import { SavedSearchSharesRepository } from './saved-search-shares.repository.js';

/**
 * SRCH saved-search sharing (x272) — the application service.
 *
 * The sharing half of SR-04, on top of x214's per-user saved searches: an owner shares one of their
 * own saved searches with the whole studio so teammates can run it, and unshares it again. The route
 * ceiling is `search.use` (reused, no `capabilities.ts` edit); the object rule enforced here is:
 *
 *   1. **Resolve before authorize.** Every share/unshare first resolves the saved search by
 *      `(organization_id, id)`. An id that names nothing in this studio is a 404 — the row's
 *      existence is never disclosed.
 *   2. **Owner only.** The authoritative owner is `saved_searches.user_id`, resolved read-only. A
 *      caller who is not the owner is refused with a 403 and **no write happens** — a member cannot
 *      share or unshare another member's saved search.
 *
 * Share (PUT) is idempotent; unshare (DELETE) is 204 whether or not a share was present (the
 * resource ends absent either way). The shared list returns every saved search shared with the
 * studio, joined read-only to its `saved_searches` row for the name, query, filters and owner.
 */

/** One shared saved search as the client reads it — paired Exact with the web's `SharedSavedSearch`. */
export interface SharedSavedSearchView {
  readonly id: string;
  readonly name: string;
  readonly query: string;
  readonly filters: readonly SavedSearchFilter[];
  readonly ownerUserId: string;
  readonly sharedAt: string;
}

export class SavedSearchSharesService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: SavedSearchSharesRepository = new SavedSearchSharesRepository(),
  ) {}

  /**
   * Share the acting user's own saved search with the studio (idempotent). Resolves the saved search
   * before authorizing (unknown id → 404); only the owner may share (a non-owner → 403, no insert).
   * Returns the refreshed shared list.
   */
  async share(
    context: TenantContext,
    savedSearchId: string,
  ): Promise<readonly SharedSavedSearchView[]> {
    return this.database.transaction(context, async (tx) => {
      await this.resolveOwned(tx, context, savedSearchId);
      await this.repository.insertShareIfAbsent(tx, context, savedSearchId);
      return this.listSharedWith(tx, context);
    });
  }

  /**
   * Unshare the acting user's own saved search (204). Resolves before authorizing (unknown id →
   * 404); only the owner may unshare (a non-owner → 403, no delete). Idempotent: whether or not a
   * share was present, the resource ends absent.
   */
  async unshare(context: TenantContext, savedSearchId: string): Promise<void> {
    await this.database.transaction(context, async (tx) => {
      await this.resolveOwned(tx, context, savedSearchId);
      await this.repository.deleteShare(tx, context, savedSearchId);
    });
  }

  /** Every saved search shared with the studio, newest share first. */
  async listShared(context: TenantContext): Promise<readonly SharedSavedSearchView[]> {
    return this.database.read(context, (runner) => this.listSharedWith(runner, context));
  }

  /**
   * Resolve the saved search and enforce the owner rule, or throw. An unknown saved search is a 404
   * (existence not disclosed); a saved search owned by another member is a 403 with no write. Runs
   * before any share/unshare write.
   */
  private async resolveOwned(
    runner: TenantQueryRunner,
    context: TenantContext,
    savedSearchId: string,
  ): Promise<void> {
    const ownerUserId = await this.repository.resolveOwner(runner, context, savedSearchId);
    if (ownerUserId === undefined) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    if (ownerUserId !== context.userId) throw new ApiError(403, 'forbidden', MESSAGES.forbidden);
  }

  private async listSharedWith(
    runner: TenantQueryRunner,
    context: TenantContext,
  ): Promise<readonly SharedSavedSearchView[]> {
    const rows = await this.repository.listShared(runner, context);
    return rows.map((row) => ({
      id: row.id,
      name: row.name ?? '',
      query: row.queryText,
      filters: row.filters,
      ownerUserId: row.ownerUserId,
      sharedAt: row.sharedAt.toISOString(),
    }));
  }
}
