import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { SubscriptionService } from './subscription.service.js';
import type { SubscriptionRepository, UpsertPlanInput } from './subscription.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { SubscriptionRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

// Billing / module 19 (x177), SEC budget — one assertion per key behaviour: the default when no row,
// the pending-change write, the off-catalog 400 with no write, the refusal without org.manage, and
// that the tenant is the context's. The write boundary is the security surface, so the refusal and
// the no-write path are proven directly rather than assumed from the route guard.

const ORG = 'org-under-test';

/** An owner — the one internal role whose ceiling still holds `org.manage`. */
function ownerPrincipal(): Principal {
  return {
    userId: 'user-1',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG } as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

/** A repository stub that records the upsert it is handed and returns a canned row. */
function fakeRepo(
  row: SubscriptionRow | null,
  sink?: { upserts: UpsertPlanInput[] },
): SubscriptionRepository {
  return {
    find: (_r: never, ctx: TenantContext) => {
      expect(ctx.organizationId).toBe(ORG);
      return Promise.resolve(row);
    },
    upsertPlan: (_r: never, ctx: TenantContext, input: UpsertPlanInput) => {
      expect(ctx.organizationId).toBe(ORG);
      sink?.upserts.push(input);
      return Promise.resolve({
        planId: input.planId,
        status: input.status,
        currentPeriodEnd: null,
      } as unknown as SubscriptionRow);
    },
  } as unknown as SubscriptionRepository;
}

describe('SubscriptionService.read', () => {
  it('defaults to the free tier, active, when the organization has no row', async () => {
    const service = new SubscriptionService(fakeDatabase(), fakeRepo(null));
    await expect(service.read(context, ownerPrincipal())).resolves.toEqual({
      planId: 'free',
      status: 'active',
      currentPeriodEnd: null,
    });
  });

  it('refuses a principal without org.manage', async () => {
    const notManager: Principal = { ...ownerPrincipal(), role: 'org_admin' };
    const service = new SubscriptionService(fakeDatabase(), fakeRepo(null));
    await expect(service.read(context, notManager)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('SubscriptionService.requestChange', () => {
  it('records a valid plan as pending_change (no charge path — the only write is the upsert)', async () => {
    const sink = { upserts: [] as UpsertPlanInput[] };
    const service = new SubscriptionService(fakeDatabase(), fakeRepo(null, sink));

    await expect(service.requestChange(context, ownerPrincipal(), 'pro')).resolves.toEqual({
      planId: 'pro',
      status: 'pending_change',
      currentPeriodEnd: null,
    });
    expect(sink.upserts).toEqual([{ planId: 'pro', status: 'pending_change' }]);
  });

  it('rejects an off-catalog plan with a 400 and writes nothing', async () => {
    const sink = { upserts: [] as UpsertPlanInput[] };
    const service = new SubscriptionService(fakeDatabase(), fakeRepo(null, sink));

    await expect(
      service.requestChange(context, ownerPrincipal(), 'enterprise-unlimited'),
    ).rejects.toMatchObject({ status: 400 });
    expect(sink.upserts).toEqual([]);
  });

  it('refuses a principal without org.manage and writes nothing', async () => {
    const sink = { upserts: [] as UpsertPlanInput[] };
    const notManager: Principal = { ...ownerPrincipal(), role: 'org_admin' };
    const service = new SubscriptionService(fakeDatabase(), fakeRepo(null, sink));

    await expect(service.requestChange(context, notManager, 'pro')).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(sink.upserts).toEqual([]);
  });
});
