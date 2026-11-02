import { describe, expect, it } from 'vitest';
import type { Principal, RateCardInput } from '@tmanage/domain';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ApiError } from '../../common/http/errors.js';
import { validateRateEntry } from './rates-rules.js';
import type { RatesRepository } from './rates.repository.js';
import { RatesService, priceTimeLog } from './rates.service.js';

/** 52-04 — rates over in-memory fakes and the real `authorize`. DB cases (INT-52-09/10) not run. */

const ORG = '01890000-0000-7000-8000-00000000000a';
const context = { organizationId: ORG, userId: 'u1', membershipId: 'm1' } as TenantContext;
const as = (role: string): Principal =>
  ({
    userId: 'u1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  }) as Principal;
const orgCard: RateCardInput = {
  id: 'c1',
  scope: 'org',
  scopeId: null,
  currency: 'SAR',
  archived: false,
  entries: [
    {
      targetType: 'default',
      targetKey: null,
      hourlyMinor: 30_000,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    },
  ],
};

function harness(candidates = 2) {
  const audits: { action: string; metadata: unknown; changes: unknown }[] = [];
  const written: string[] = [];
  const repository = {
    resolverCards: async () => [orgCard],
    projectPricing: async () => ({ billableDefault: true, rateCardId: null, clientOrgId: null }),
    projectExists: async () => true,
    membershipRole: async () => 'member',
    costRates: async () => [
      { hourlyCostMinor: 12_000, currency: 'SAR', effectiveFrom: '2026-01-01', effectiveTo: null },
    ],
    repriceCandidates: async () =>
      Array.from({ length: candidates }, (_, i) => ({
        id: `t${i}`,
        projectId: 'p1',
        loggedBy: 'm1',
        spentOn: '2026-05-01',
      })),
    writeSnapshot: async (_r: unknown, _o: string, id: string) => void written.push(id),
  } as unknown as RatesRepository;
  const service = new RatesService({
    database: { read: (_c, f) => f({} as never), transaction: (_c, f) => f({} as never) },
    repository,
    audit: {
      record: async (_tx, _c, e) => {
        audits.push(e as never);
        return {} as never;
      },
    },
  });
  return { service, repository, audits, written };
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: unknown) => (e as ApiError).status,
  );

describe('52-04 rates', () => {
  it('INT-52-09 shape: a logged hour carries sell and cost snapshots; no rate is null, never 0', async () => {
    const { repository } = harness();
    const input = { projectId: 'p1', membershipId: 'm1', spentOn: '2026-05-01' };
    expect(await priceTimeLog({} as never, ORG, repository, input)).toEqual({
      rateSnapshotMinor: 30_000,
      costSnapshotMinor: 12_000,
      snapshotCurrency: 'SAR',
      billableDefault: true,
    });
    const before = await priceTimeLog({} as never, ORG, repository, {
      ...input,
      spentOn: '2025-12-31',
    });
    expect([before.rateSnapshotMinor, before.costSnapshotMinor]).toEqual([null, null]);
  });

  it('INT-52-10: re-price writes each unbilled candidate, audits the count, refuses > 5,000', async () => {
    const { service, audits, written } = harness();
    expect(
      await service.reprice(context, as('owner'), { projectId: 'all', until: '2026-06-30' }),
    ).toEqual({ repriced: 2 });
    expect(written).toEqual(['t0', 't1']);
    expect(audits[0]).toMatchObject({ action: 'rates.repriced', metadata: { count: 2 } });
    expect(
      await status(
        harness(5_001).service.reprice(context, as('owner'), {
          projectId: 'all',
          until: '2026-06-30',
        }),
      ),
    ).toBe(422);
  });

  it('AUTH-52-05: a finance.view caller gets the sell rate only and no cost route', async () => {
    const { service } = harness();
    const resolved = await service.resolve(context, as('manager'), {
      projectId: 'p1',
      membershipId: 'm1',
      on: '2026-05-01',
    });
    expect(Object.keys(resolved).sort()).toEqual(['currency', 'hourlyMinor', 'source']);
    expect(await status(service.getCostRates(context, as('manager'), 'm1'))).toBe(403);
    expect(await status(service.getCostRates(context, as('owner'), 'm1'))).toBe(200);
  });

  it('validates hourly range and windows', () => {
    const entry = {
      targetType: 'role',
      targetKey: 'manager',
      hourlyMinor: 1,
      effectiveFrom: '2026-01-01',
    };
    expect(validateRateEntry(entry).effectiveTo).toBeNull();
    expect(() => validateRateEntry({ ...entry, hourlyMinor: 100_000_001 })).toThrow();
    expect(() => validateRateEntry({ ...entry, effectiveTo: '2026-01-01' })).toThrow();
  });
});
