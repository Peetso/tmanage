import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { UsageService } from './usage.service.js';
import { STORAGE_BYTES_METRIC, type UsageCountersRepository } from './usage-counters.repository.js';
import type { ApiConfig } from '../../common/http/api-config.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { UsageCounterRow } from '../../common/database/schema.js';
import { ApiError } from '../../common/http/errors.js';

// USAGE-001 slice 5 — one test per behaviour (the 0.5 money-slice budget): the values the screen
// shows, the refusal without `org.manage`, and that the counter is read for the principal's tenant.

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

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
  } as unknown as TenantDatabase;
}

const countersReturning = (
  row: UsageCounterRow | null,
  spy?: (ctx: TenantContext, m: string) => void,
) =>
  ({
    find: (_r: never, ctx: TenantContext, metric: string) => {
      spy?.(ctx, metric);
      return Promise.resolve(row);
    },
  }) as unknown as UsageCountersRepository;

const config = (limit: number) => ({ storageOrgBytesLimit: limit }) as unknown as ApiConfig;
const context = { organizationId: ORG } as TenantContext;

describe('UsageService.read', () => {
  it('projects used, reserved, the config quota, the unit and reconciledAt', async () => {
    const reconciledAt = new Date('2026-09-19T12:00:00.000Z');
    const counters = countersReturning({
      usedValue: 120,
      reservedValue: 30,
      reconciledAt,
    } as unknown as UsageCounterRow);

    await expect(
      new UsageService(fakeDatabase(), counters, config(500)).read(context, ownerPrincipal()),
    ).resolves.toEqual({
      used: 120,
      reserved: 30,
      quota: 500,
      unit: 'bytes',
      reconciledAt: reconciledAt.toISOString(),
    });
  });

  it('refuses a principal without org.manage and never reads the counter', async () => {
    let read = false;
    const counters = countersReturning(null, () => {
      read = true;
    });
    const notManager: Principal = { ...ownerPrincipal(), role: 'workspace_admin' };

    await expect(
      new UsageService(fakeDatabase(), counters, config(500)).read(context, notManager),
    ).rejects.toBeInstanceOf(ApiError);
    expect(read).toBe(false);
  });

  it('reads the counter for the principal tenant, taking no organization id from the caller', async () => {
    let seenOrg: string | undefined;
    let seenMetric: string | undefined;
    const counters = countersReturning(null, (ctx, metric) => {
      seenOrg = ctx.organizationId;
      seenMetric = metric;
    });

    await new UsageService(fakeDatabase(), counters, config(500)).read(context, ownerPrincipal());

    expect(seenOrg).toBe(ORG);
    expect(seenMetric).toBe(STORAGE_BYTES_METRIC);
  });
});
