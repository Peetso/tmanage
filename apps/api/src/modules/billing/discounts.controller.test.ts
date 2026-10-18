import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BillingDiscountsController } from './discounts.controller.js';
import { DiscountsService } from './discounts.service.js';
import type { DiscountsRepository } from './discounts.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingDiscountRow } from '../../common/database/schema.js';

/**
 * Billing discounts (x330) proofs, database-free over a fake repository with the *real* `authorize` (the
 * controller delegates to a real {@link DiscountsService} built on the fake). The migration, the grant
 * (INSERT/DELETE, no UPDATE) and the tenant-scoped SQL round-trip are the chain's DB suite, not here;
 * this file proves the slice's own security logic: the required refusals — create without `org.manage`
 * (403, no insert), a cross-tenant DELETE (404, no delete), `percent` over 100 (400, no insert) — plus
 * the read-side active/expired marking and a tenant-scoped delete.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role']): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function controllerWith(seed: readonly BillingDiscountRow[] = []) {
  const store: BillingDiscountRow[] = [...seed];
  let seq = store.length;

  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_r: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: { label: string; kind: string; amount: number; expiresOn: string | null },
    ) => {
      seq += 1;
      const row: BillingDiscountRow = {
        id: `billing-discount-${seq.toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        label: input.label,
        kind: input.kind,
        amount: input.amount,
        expiresOn: input.expiresOn,
        createdBy: USER,
        createdAt: new Date(Date.UTC(2026, 8, 30, 10, seq, 0)),
      };
      store.push(row);
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, id: string) => {
      const at = store.findIndex(
        (row) => row.organizationId === ctx.organizationId && row.id === id,
      );
      if (at >= 0) store.splice(at, 1);
    },
  } as unknown as DiscountsRepository;

  const service = new DiscountsService(database, repository);
  return { controller: new BillingDiscountsController(service), store };
}

describe('BillingDiscountsController', () => {
  it('records discounts and lists them newest-first without echoing the tenant id', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');

    const created = await controller.create(context, actor, {
      label: 'Launch promo',
      kind: 'percent',
      amount: 15,
      expiresOn: null,
    });
    await controller.create(context, actor, { label: 'Goodwill', kind: 'fixed', amount: 2500 });
    expect(created).not.toHaveProperty('organizationId');

    const { discounts } = await controller.list(context, actor);
    expect(discounts.map((d) => d.label)).toEqual(['Goodwill', 'Launch promo']);
    expect(discounts.every((d) => d.active)).toBe(true);
  });

  it('marks a past-dated discount expired and a never-expiring one active, read-side', async () => {
    const rows: BillingDiscountRow[] = [
      {
        id: 'billing-discount-expired',
        organizationId: ORG,
        label: 'Old deal',
        kind: 'percent',
        amount: 10,
        expiresOn: '2000-01-01',
        createdBy: USER,
        createdAt: new Date(Date.UTC(2026, 8, 30, 10, 1, 0)),
      },
      {
        id: 'billing-discount-forever',
        organizationId: ORG,
        label: 'Standing',
        kind: 'fixed',
        amount: 500,
        expiresOn: null,
        createdBy: USER,
        createdAt: new Date(Date.UTC(2026, 8, 30, 10, 2, 0)),
      },
    ];
    const { controller } = controllerWith(rows);
    const { discounts } = await controller.list(context, principal('owner'));
    const byId = new Map(discounts.map((d) => [d.id, d.active]));
    expect(byId.get('billing-discount-expired')).toBe(false);
    expect(byId.get('billing-discount-forever')).toBe(true);
  });

  it('rejects a percentage over 100 with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), {
        label: 'Too much',
        kind: 'percent',
        amount: 101,
        expiresOn: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects a negative fixed amount and an empty label with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('owner');
    await expect(
      controller.create(context, actor, { label: 'x', kind: 'fixed', amount: -1, expiresOn: null }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.create(context, actor, {
        label: '   ',
        kind: 'fixed',
        amount: 100,
        expiresOn: null,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('refuses a role without org.manage with 403 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('workspace_admin');
    await expect(controller.list(context, actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.create(context, actor, {
        label: 'nope',
        kind: 'percent',
        amount: 5,
        expiresOn: null,
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });

  it("does not delete another tenant's discount: 404 with no delete", async () => {
    const other: BillingDiscountRow = {
      id: 'billing-discount-other',
      organizationId: OTHER_ORG,
      label: 'Another studio',
      kind: 'percent',
      amount: 20,
      expiresOn: null,
      createdBy: USER,
      createdAt: new Date('2026-09-30T10:00:00.000Z'),
    };
    const { controller, store } = controllerWith([other]);
    await expect(
      controller.remove(context, principal('owner'), 'billing-discount-other'),
    ).rejects.toMatchObject({ status: 404 });
    expect(store).toHaveLength(1);
  });

  it('removes an in-tenant discount', async () => {
    const mine: BillingDiscountRow = {
      id: 'billing-discount-mine',
      organizationId: ORG,
      label: 'Mine',
      kind: 'fixed',
      amount: 1000,
      expiresOn: null,
      createdBy: USER,
      createdAt: new Date('2026-09-30T10:00:00.000Z'),
    };
    const { controller, store } = controllerWith([mine]);
    await controller.remove(context, principal('owner'), 'billing-discount-mine');
    expect(store).toHaveLength(0);
  });
});
