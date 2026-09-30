import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { InsightMetricFavoritesController } from './metric-favorites.controller.js';
import { InsightMetricFavoritesService } from './metric-favorites.service.js';
import type { InsightMetricFavoritesRepository } from './metric-favorites.repository.js';
import type {
  InsightMetricFavoriteRow,
  InsightFavoriteMetricKey,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * INS metric favorites (x303) controller/service proofs over the module's fakes. The migration and the
 * tenant-scoped SQL round-trip are proven in the DB suite (the chain owns it); here the subject is the
 * refusal the slice must enforce: an off-allowlist metricKey is a 400 with nothing written, and one
 * member never sees another member's favorites (membership scope). A repeated star is idempotent.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-000000000001';
const KEY: InsightFavoriteMetricKey = 'portfolio.projectCount';

function contextFor(membershipId: string): TenantContext {
  return { organizationId: ORG, membershipId } as unknown as TenantContext;
}

/** A controller whose favorites live in an in-memory store scoped by (org, membership, key). */
function controllerWith(): {
  ctl: InsightMetricFavoritesController;
  store: InsightMetricFavoriteRow[];
} {
  const store: InsightMetricFavoriteRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const favorites = {
    find: async (_r: unknown, ctx: TenantContext, membershipId: string, metricKey: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.membershipId === membershipId &&
          row.metricKey === metricKey,
      ) ?? null,
    add: async (
      _r: unknown,
      ctx: TenantContext,
      input: { membershipId: string; metricKey: InsightFavoriteMetricKey },
    ) => {
      const existing = store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.membershipId === input.membershipId &&
          row.metricKey === input.metricKey,
      );
      if (existing) return existing;
      const row = {
        id: `favorite-0000-0000-0000-0000000000${++seq}`,
        organizationId: ctx.organizationId,
        membershipId: input.membershipId,
        metricKey: input.metricKey,
        createdAt: new Date(),
      } as InsightMetricFavoriteRow;
      store.push(row);
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, membershipId: string, metricKey: string) => {
      const i = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.membershipId === membershipId &&
          row.metricKey === metricKey,
      );
      if (i >= 0) store.splice(i, 1);
    },
    listForMember: async (_r: unknown, ctx: TenantContext, membershipId: string) =>
      store
        .filter(
          (row) => row.organizationId === ctx.organizationId && row.membershipId === membershipId,
        )
        .sort((a, b) => b.id.localeCompare(a.id)),
  } as unknown as InsightMetricFavoritesRepository;

  return {
    ctl: new InsightMetricFavoritesController(
      new InsightMetricFavoritesService(database, favorites),
    ),
    store,
  };
}

describe('InsightMetricFavorites', () => {
  it('stars self idempotently, lists own, and never echoes the tenant id', async () => {
    const { ctl, store } = controllerWith();
    const context = contextFor(MEMBERSHIP);

    const first = await ctl.add(context, KEY);
    const again = await ctl.add(context, KEY);
    expect(again.id).toBe(first.id);
    expect(store).toHaveLength(1);
    expect(first).not.toHaveProperty('organizationId');
    expect(first).not.toHaveProperty('membershipId');

    const listed = await ctl.list(context);
    expect(listed.favorites.map((f) => f.metricKey)).toEqual([KEY]);

    await ctl.remove(context, KEY);
    expect(store).toHaveLength(0);
    // A second unstar is still success (no row → no-op), not a 404.
    await ctl.remove(context, KEY);
  });

  it('refuses an off-allowlist metricKey with 400 and writes nothing', async () => {
    const { ctl, store } = controllerWith();
    const error = await ctl.add(contextFor(MEMBERSHIP), 'portfolio.bogus').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it('does not list another membership’s favorites', async () => {
    const { ctl } = controllerWith();
    await ctl.add(contextFor(MEMBERSHIP), KEY);
    const other = await ctl.list(contextFor('membership-0000-0000-000000000002'));
    expect(other.favorites).toHaveLength(0);
  });
});
