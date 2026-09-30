import type { RecentItemObjectType } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { RecentItemsRepository } from './recent-items.repository.js';

/**
 * HOME recents (x324) — the one CONTRACT-001 response projection: the caller's recently-viewed
 * references, newest first, each row inlined rather than a second `*View` (as `HomePinView` inlines
 * its pins). Dates are ISO strings, the shape `JSON.stringify` emits on the wire. Reference-only: a
 * row carries the object's kind and id, never a resolved title, so it can disclose nothing about a
 * target the caller could not already reach.
 */
export interface RecentItemsView {
  readonly items: readonly {
    readonly id: string;
    readonly objectType: RecentItemObjectType;
    readonly objectId: string;
    readonly viewedAt: string;
  }[];
}

/**
 * The record-a-view and read-recents orchestration.
 *
 * The safety is not here — it is the capability guard on the routes and the repository's
 * tenant-and-membership scoping — so this service only sequences the write and the bounded read and
 * projects the rows. `recordView` upserts (idempotent: a repeat view refreshes `viewed_at`) then
 * returns the refreshed list, so the record and the read share the one projection. The acting
 * membership and tenant are always the context's, never a field the caller supplies.
 */
export class RecentItemsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly recents: RecentItemsRepository = new RecentItemsRepository(),
  ) {}

  /** Record that the acting member viewed an object now, then return their recents (bounded). */
  async recordView(
    context: TenantContext,
    input: { readonly objectType: RecentItemObjectType; readonly objectId: string },
  ): Promise<RecentItemsView> {
    const viewedAt = new Date();
    await this.database.transaction(context, (tx) =>
      this.recents.recordView(tx, context, {
        membershipId: context.membershipId,
        objectType: input.objectType,
        objectId: input.objectId,
        viewedAt,
      }),
    );
    return this.list(context);
  }

  /** The acting membership's recents, newest first, bounded to the fixed cap. */
  async list(context: TenantContext): Promise<RecentItemsView> {
    const rows = await this.database.read(context, (runner) =>
      this.recents.listForMembership(runner, context, context.membershipId),
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        objectType: row.objectType as RecentItemObjectType,
        objectId: row.objectId,
        viewedAt: row.viewedAt.toISOString(),
      })),
    };
  }
}
