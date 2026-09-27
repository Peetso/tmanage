import type { InsightSavedViewRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightSavedViewsRepository } from './saved-views.repository.js';
import type { InsightSavedViewInsert } from './saved-views.repository.js';

/** The fields a create carries, re-exported from the repository for the controller's use. */
export type InsightSavedViewInput = InsightSavedViewInsert;

/**
 * INS saved views (x210) — the create/list/delete orchestration for a member's own named insights
 * views over the tenant transaction wrapper.
 *
 * Every operation is scoped by `(organization_id, owner_user_id = context.userId)` in the repository:
 * a view is private to its creator, so a caller can only ever create, list or remove their own views.
 * `owner_user_id` is `context.userId`, resolved once per request by the tenant guard and never a body
 * value. The service owns only the transaction boundary; the scoped queries are the repository's.
 */
export class InsightSavedViewsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly savedViews: InsightSavedViewsRepository = new InsightSavedViewsRepository(),
  ) {}

  /** Create a view owned by the acting user and return the stored row. */
  async create(context: TenantContext, input: InsightSavedViewInput): Promise<InsightSavedViewRow> {
    return this.database.transaction(context, async (tx) => {
      const id = await this.savedViews.create(tx, context, input);
      const row = await this.savedViews.findOwn(tx, context, id);
      // The row was just inserted in this same transaction, so its absence is impossible; the check
      // keeps the return type honest rather than asserting non-null.
      if (!row) {
        throw new Error('insight_saved_views: inserted row not found in its own transaction');
      }
      return row;
    });
  }

  /** The acting user's views in this studio. */
  async listOwn(context: TenantContext): Promise<InsightSavedViewRow[]> {
    return this.database.read(context, (runner) => this.savedViews.listOwn(runner, context));
  }

  /** Delete a view by id, scoped to the acting user. `false` when nothing was removed (→ 404). */
  async deleteOwn(context: TenantContext, id: string): Promise<boolean> {
    return this.database.transaction(context, (tx) => this.savedViews.deleteOwn(tx, context, id));
  }
}
