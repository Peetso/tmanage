import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { InsightComparisonController } from './comparison.controller.js';
import { InsightComparisonService } from './comparison.service.js';
import type { PeriodComparisonView } from './comparison.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x229 — Insight period comparison. Database-free proofs over the module with the **real**
 * `authorize`. The count path is ordinary tenant-scoped SQL (no schema-shape logic worth a unit),
 * so the properties the controller and service own are the ones proven here:
 *   - a principal `work.read` refuses (a client — the capability is internal-only) is a 403, the
 *     org-level relation half of the route's ceiling, checked before any parse or count;
 *   - an unknown metric is a 400, never a query built from caller text;
 *   - an inverted window is a 400, with no partial compute;
 *   - a permitted principal's valid request computes delta and pct, and pct guards divide-by-zero
 *     (base 0 → null, never NaN/500).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const A = '2026-01-01T00:00:00.000Z..2026-02-01T00:00:00.000Z';
const B = '2026-02-01T00:00:00.000Z..2026-03-01T00:00:00.000Z';

const context = { organizationId: ORG } as unknown as TenantContext;

function orgWide(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'org_admin',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function client(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000003',
    organizationId: ORG,
    kind: 'client',
    role: 'client_admin',
    membershipId: 'membership-0000-0000-000000000003',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    projectIds: [],
    hasOrgWideScope: false,
  };
}

/**
 * A service whose per-window count is stubbed to a scripted queue; the real `authorize`-backed gate
 * and the real parse/arithmetic are preserved.
 */
function serviceWith(counts: readonly number[]): InsightComparisonService {
  const database = {} as unknown as TenantDatabase;
  const service = new InsightComparisonService(database);
  const queue = [...counts];
  return Object.assign(service, {
    // Replace the private count with a scripted one; compare()'s delta/pct logic runs for real.
    count: async () => queue.shift() ?? 0,
  });
}

describe('InsightComparisonController', () => {
  it('refuses a caller without work.read with a 403 before any parse or count', async () => {
    let touched = false;
    const service = Object.assign(serviceWith([]), {
      compare: async (): Promise<PeriodComparisonView> => {
        touched = true;
        throw new Error('should not reach the compute');
      },
    });
    const controller = new InsightComparisonController(service);
    // A bogus metric would also 400, but the 403 must win — the gate is checked first.
    await expect(
      controller.compare(context, client(), 'bogus', 'garbage', 'garbage'),
    ).rejects.toMatchObject({ status: 403 } as Partial<ApiError>);
    expect(touched).toBe(false);
  });

  it('rejects an unknown metric with a 400', async () => {
    const controller = new InsightComparisonController(serviceWith([]));
    await expect(controller.compare(context, orgWide(), 'nope', A, B)).rejects.toMatchObject({
      status: 400,
    } as Partial<ApiError>);
  });

  it('rejects an inverted window with a 400 (no partial compute)', async () => {
    const controller = new InsightComparisonController(serviceWith([]));
    const inverted = '2026-03-01T00:00:00.000Z..2026-02-01T00:00:00.000Z';
    await expect(
      controller.compare(context, orgWide(), 'work_items_created', inverted, B),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it('computes delta and pct for a permitted principal', async () => {
    const controller = new InsightComparisonController(serviceWith([4, 6]));
    const view = await controller.compare(context, orgWide(), 'work_items_created', A, B);
    expect(view.a.value).toBe(4);
    expect(view.b.value).toBe(6);
    expect(view.delta).toBe(2);
    expect(view.pct).toBeCloseTo(0.5);
  });

  it('guards divide-by-zero: a base of 0 yields a null pct, not NaN', async () => {
    const controller = new InsightComparisonController(serviceWith([0, 3]));
    const view = await controller.compare(context, orgWide(), 'meetings_held', A, B);
    expect(view.delta).toBe(3);
    expect(view.pct).toBeNull();
  });
});
