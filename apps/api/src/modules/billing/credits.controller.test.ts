import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { BillingCreditsController } from './credits.controller.js';
import { CreditsService } from './credits.service.js';
import type { CreditsRepository } from './credits.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { BillingCreditRow } from '../../common/database/schema.js';

/**
 * Billing credits (x226) proofs, database-free over a fake repository with the *real* `authorize` (the
 * controller delegates to a real {@link CreditsService} built on the fake). The migration, the grant
 * (INSERT-only, no UPDATE/DELETE) and the tenant-scoped SQL round-trip are the chain's DB suite, not
 * here; this file proves the slice's own security logic: post→list with a running balance, the
 * out-of-bounds amount and empty reason 400s with no write, the cross-tenant row is not listed, and the
 * 403 for a role without `org.manage`.
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

function controllerWith(seed: readonly BillingCreditRow[] = []) {
  const store: BillingCreditRow[] = [...seed];
  let seq = store.length;

  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: { amount: number; reason: string; createdBy: string },
    ) => {
      seq += 1;
      const row: BillingCreditRow = {
        id: `billing-credit-${seq.toString().padStart(2, '0')}`,
        organizationId: ctx.organizationId,
        amount: input.amount,
        reason: input.reason,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 8, 27, 10, seq, 0)),
      };
      store.push(row);
      return row;
    },
  } as unknown as CreditsRepository;

  const service = new CreditsService(database, repository);
  return { controller: new BillingCreditsController(service), store };
}

describe('BillingCreditsController', () => {
  it('posts credits and lists them newest-first with a running balance, without echoing the tenant id', async () => {
    const { controller } = controllerWith();
    const actor = principal('owner');

    const first = await controller.post(context, actor, {
      amount: 5000,
      reason: 'Goodwill credit',
    });
    await controller.post(context, actor, { amount: -1500, reason: 'Overbill adjustment' });
    expect(first).not.toHaveProperty('organizationId');

    const listed = await controller.list(context, actor);
    expect(listed.balance).toBe(3500);
    expect(listed.credits[0]?.reason).toBe('Overbill adjustment');
    expect(listed.credits.map((c) => c.amount)).toEqual([-1500, 5000]);
  });

  it('rejects an out-of-bounds or zero amount with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('owner');
    await expect(controller.post(context, actor, { amount: 0, reason: 'x' })).rejects.toMatchObject(
      { status: 400 },
    );
    await expect(
      controller.post(context, actor, { amount: 100_000_001, reason: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.post(context, actor, { amount: 10.5, reason: 'x' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it('rejects an empty reason with 400 and writes nothing', async () => {
    const { controller, store } = controllerWith();
    await expect(
      controller.post(context, principal('owner'), { amount: 100, reason: '   ' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store).toHaveLength(0);
  });

  it("does not list another tenant's credits and excludes them from the balance", async () => {
    const other: BillingCreditRow = {
      id: 'billing-credit-other',
      organizationId: OTHER_ORG,
      amount: 9999,
      reason: 'Another studio',
      createdBy: USER,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
    };
    const { controller } = controllerWith([other]);
    const listed = await controller.list(context, principal('owner'));
    expect(listed.credits).toHaveLength(0);
    expect(listed.balance).toBe(0);
  });

  it('refuses a role without org.manage with 403 on list and post', async () => {
    const { controller, store } = controllerWith();
    const actor = principal('org_admin');
    await expect(controller.list(context, actor)).rejects.toMatchObject({ status: 403 });
    await expect(
      controller.post(context, actor, { amount: 100, reason: 'nope' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store).toHaveLength(0);
  });
});
