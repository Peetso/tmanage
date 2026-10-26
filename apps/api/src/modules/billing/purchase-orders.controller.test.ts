import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PurchaseOrdersController } from './purchase-orders.controller.js';
import { PurchaseOrdersService } from './purchase-orders.service.js';
import type { PurchaseOrdersRepository } from './purchase-orders.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingPurchaseOrderRow } from '../../common/database/schema.js';

// These suites prove the paid behaviour; BILLING_MODE=beta_free (the default) is covered in
// billing-mode.test.ts.
beforeEach(() => {
  vi.stubEnv('BILLING_MODE', 'paid');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * Billing purchase-orders (x282) proofs, database-free over a fake repository with the *real*
 * `authorize` (the controller delegates to a real {@link PurchaseOrdersService} built on the fake). The
 * migration and the tenant-scoped SQL round-trip are the chain's DB suite, not here; this file proves
 * the slice's own security logic: create→list, the empty-number and negative-amount 400s with no write,
 * the duplicate-number 409 with no second insert, the 403 for a role without `org.manage`, the
 * cross-tenant 404 on close, and the idempotent delete.
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

function controllerWith(seed: readonly BillingPurchaseOrderRow[] = []) {
  const store: BillingPurchaseOrderRow[] = [...seed];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.poNumber.localeCompare(b.poNumber)),
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
    findByNumber: async (_runner: unknown, ctx: TenantContext, poNumber: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.poNumber === poNumber) ??
      null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        poNumber: string;
        amountMinor: number | null;
        currency: string | null;
        note: string | null;
      },
    ) => {
      const row: BillingPurchaseOrderRow = {
        id: `billing-purchase-order-${(seq += 1).toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        poNumber: input.poNumber,
        amountMinor: input.amountMinor,
        currency: input.currency,
        note: input.note,
        status: 'open',
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
      };
      store.push(row);
      return row;
    },
    close: async (_runner: unknown, ctx: TenantContext, id: string) => {
      const row = store.find((r) => r.organizationId === ctx.organizationId && r.id === id);
      if (!row) throw new Error('vanished');
      row.status = 'closed';
      return row;
    },
    remove: async (_runner: unknown, ctx: TenantContext, id: string) => {
      const index = store.findIndex((r) => r.organizationId === ctx.organizationId && r.id === id);
      if (index >= 0) store.splice(index, 1);
    },
  } as unknown as PurchaseOrdersRepository;

  const service = new PurchaseOrdersService(database, repository);
  return { controller: new PurchaseOrdersController(service), store };
}

describe('PurchaseOrdersController', () => {
  it('records a PO and lists it, without echoing the tenant id', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');

    const created = await controller.create(context, actor, {
      poNumber: 'PO-1001',
      amount: 25000,
      currency: 'usd',
    });
    expect(created.poNumber).toBe('PO-1001');
    expect(created.amountMinor).toBe(25000);
    expect(created.currency).toBe('USD');
    expect(created.status).toBe('open');
    expect(created).not.toHaveProperty('organizationId');

    const { purchaseOrders } = await controller.list(context, actor);
    expect(purchaseOrders.map((p) => p.id)).toContain(created.id);
  });

  it('rejects an empty poNumber with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), { poNumber: '   ' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects a negative amount with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.create(context, principal('owner'), { poNumber: 'PO-2', amount: -1 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('refuses a duplicate poNumber with 409 and does not insert a second row', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('owner');
    await controller.create(context, actor, { poNumber: 'PO-DUP' });
    await expect(controller.create(context, actor, { poNumber: 'PO-DUP' })).rejects.toMatchObject({
      status: 409,
    });
    expect(store).toHaveLength(1);
  });

  it('refuses a role without org.manage with 403 on create and list', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('workspace_admin');
    await expect(controller.list(context, actor)).rejects.toMatchObject({ status: 403 });
    await expect(controller.create(context, actor, { poNumber: 'PO-3' })).rejects.toMatchObject({
      status: 403,
    });
    expect(store).toHaveLength(0);
  });

  it('returns 404 when closing a PO of another tenant', async () => {
    const other: BillingPurchaseOrderRow = {
      id: 'billing-purchase-order-other',
      organizationId: OTHER_ORG,
      poNumber: 'PO-OTHER',
      amountMinor: null,
      currency: null,
      note: null,
      status: 'open',
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
    };
    const { controller } = controllerWith([other]);
    await expect(controller.close(context, principal('owner'), other.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(other.status).toBe('open');
  });

  it('closes idempotently and deletes idempotently', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('owner');
    const created = await controller.create(context, actor, { poNumber: 'PO-9' });

    const closed = await controller.close(context, actor, created.id);
    expect(closed.status).toBe('closed');
    const reclosed = await controller.close(context, actor, created.id);
    expect(reclosed.status).toBe('closed');

    await controller.remove(context, actor, created.id);
    expect(store).toHaveLength(0);
    // A second delete of the now-absent id still succeeds (idempotent 204).
    await expect(controller.remove(context, actor, created.id)).resolves.toBeUndefined();
  });
});
