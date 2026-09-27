import { ApiError, MESSAGES } from '../../common/http/errors.js';
import type { InboxSavedFilterRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import {
  InboxSavedFiltersRepository,
  isDuplicateKeyError,
} from './inbox-saved-filters.repository.js';

/**
 * INBOX saved filters (IN-02 "All inbox", x261) — the application service.
 *
 * A member keeps named inbox filter sets (create / list / delete) over one private, per-membership
 * table (`inbox_saved_filters`). The `filter` is the client's opaque, serialized facet set (source /
 * project / kind); the service stores and returns it verbatim and never reads into it.
 *
 * The route ceiling is the inbox read capability (reused, no `capabilities.ts` edit); the
 * object-level rule — a member may read and delete only their **own** saved filters — is enforced
 * here and in the repository, which scopes every operation by `organization_id` AND `membership_id`.
 * A saved-filter id that names another membership's row or another studio's row matches nothing and
 * is a 404, never a leak that the row exists. A name already used by the acting membership collides
 * at the unique key and is mapped to 409.
 */

/** A saved inbox filter as the client reads it — paired Exact with the web's shape in the contracts gate. */
export interface InboxSavedFilterView {
  readonly id: string;
  readonly name: string;
  /** The client's opaque, serialized inbox facet set (source / project / kind). */
  readonly filter: string;
  readonly createdAt: string;
}

/** The validated create body — request-side, so the contracts gate drops the `Input` suffix. */
export interface InboxSavedFilterInput {
  readonly name: string;
  readonly filter: string;
}

export class InboxSavedFiltersService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly repository: InboxSavedFiltersRepository = new InboxSavedFiltersRepository(),
  ) {}

  /** The acting membership's saved filters, newest first. */
  async list(context: TenantContext): Promise<readonly InboxSavedFilterView[]> {
    const rows = await this.database.read(context, (runner) =>
      this.repository.list(runner, context),
    );
    return rows.map((row) => toView(row));
  }

  /**
   * Persist a new saved filter owned by the acting membership. A name the membership already uses
   * collides at `uq_inbox_saved_filters_name`; the duplicate-key error is mapped to a typed 409 so a
   * member's saved-filter names stay distinct.
   */
  async create(
    context: TenantContext,
    input: InboxSavedFilterInput,
  ): Promise<InboxSavedFilterView> {
    try {
      const row = await this.database.transaction(context, (tx) =>
        this.repository.insert(tx, context, { name: input.name, filter: input.filter }),
      );
      return toView(row);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ApiError(409, 'conflict', 'A saved filter with that name already exists');
      }
      throw error;
    }
  }

  /**
   * Delete the acting membership's saved filter by id. Own-scoped: an id that names another
   * membership's row, another studio's row, or nothing removes nothing and is a 404 — the existence
   * of a saved filter is never disclosed to anyone but its owner.
   */
  async delete(context: TenantContext, id: string): Promise<void> {
    const removed = await this.database.transaction(context, (tx) =>
      this.repository.deleteOwned(tx, context, id),
    );
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }
}

/** Project a row to the wire shape. `organization_id`/`membership_id` are never echoed. */
function toView(row: InboxSavedFilterRow): InboxSavedFilterView {
  return {
    id: row.id,
    name: row.name,
    filter: row.filterJson,
    createdAt: row.createdAt.toISOString(),
  };
}
