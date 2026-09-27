import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/http/errors.js';
import { InboxSavedFiltersController } from './inbox-saved-filters.controller.js';
import { InboxSavedFiltersService } from './inbox-saved-filters.service.js';
import type { InboxSavedFiltersRepository } from './inbox-saved-filters.repository.js';
import type { InboxSavedFilterRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * INBOX saved filters (IN-02, x261) controller/service proofs over an in-memory repository fake. The
 * migration, the tenant-scoped SQL and the `uq_inbox_saved_filters_name` collision are proven in the
 * DB suite (the chain owns it); here the subject is the logic: the refusal (an empty name is 400 and
 * inserts nothing), create/list own, a foreign/absent delete is 404, a duplicate name is 409, and a
 * saved filter never echoes the tenant or membership id.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-000000000001';

const context = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/** A controller whose saved filters live in an in-memory store keyed like the real unique keys. */
function controllerWith(): {
  controller: InboxSavedFiltersController;
  store: InboxSavedFilterRow[];
} {
  const store: InboxSavedFilterRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    insert: async (
      _r: unknown,
      ctx: TenantContext,
      input: { name: string; filter: string },
    ): Promise<InboxSavedFilterRow> => {
      const collision = store.some(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.membershipId === ctx.membershipId &&
          row.name === input.name,
      );
      if (collision) throw { errno: 1062, code: 'ER_DUP_ENTRY' };
      const row: InboxSavedFilterRow = {
        id: `filter-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        membershipId: ctx.membershipId,
        name: input.name,
        filterJson: input.filter,
        createdAt: new Date(),
      };
      store.push(row);
      return row;
    },
    list: async (_r: unknown, ctx: TenantContext): Promise<readonly InboxSavedFilterRow[]> =>
      store
        .filter(
          (row) =>
            row.organizationId === ctx.organizationId && row.membershipId === ctx.membershipId,
        )
        .sort((a, b) => b.id.localeCompare(a.id)),
    deleteOwned: async (_r: unknown, ctx: TenantContext, id: string): Promise<boolean> => {
      const index = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.membershipId === ctx.membershipId &&
          row.id === id,
      );
      if (index < 0) return false;
      store.splice(index, 1);
      return true;
    },
  } as unknown as InboxSavedFiltersRepository;

  const service = new InboxSavedFiltersService(database, repository);
  return { controller: new InboxSavedFiltersController(service), store };
}

describe('InboxSavedFilters', () => {
  it('refuses an empty name with 400 and inserts nothing', async () => {
    const { controller, store } = controllerWith();
    const error = await controller.create(context, { name: '   ', filter: '{}' }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it('refuses a non-string filter with 400 and inserts nothing', async () => {
    const { controller, store } = controllerWith();
    const error = await controller
      .create(context, { name: 'Urgent', filter: 42 as unknown as string })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect(store).toHaveLength(0);
  });

  it('creates, lists own newest-first, and never echoes the tenant or membership id', async () => {
    const { controller } = controllerWith();
    const created = await controller.create(context, { name: 'Urgent', filter: '{"kind":"a"}' });
    expect(created).not.toHaveProperty('organizationId');
    expect(created).not.toHaveProperty('membershipId');
    expect(created.filter).toBe('{"kind":"a"}');
    const { savedFilters } = await controller.list(context);
    expect(savedFilters.map((f) => f.name)).toEqual(['Urgent']);
  });

  it('maps a duplicate name to 409', async () => {
    const { controller, store } = controllerWith();
    await controller.create(context, { name: 'Urgent', filter: '{}' });
    const error = await controller
      .create(context, { name: 'Urgent', filter: '{}' })
      .catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(409);
    expect(store).toHaveLength(1);
  });

  it('deletes own, and a foreign or absent id is 404', async () => {
    const { controller } = controllerWith();
    const created = await controller.create(context, { name: 'Urgent', filter: '{}' });
    const missing = await controller.remove(context, 'filter-does-not-exist').catch((e) => e);
    expect((missing as ApiError).status).toBe(404);
    const { savedFilters } = await controller.remove(context, created.id);
    expect(savedFilters).toHaveLength(0);
  });
});
