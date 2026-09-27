import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { InsightSnapshotsController } from './snapshots.controller.js';
import { InsightSnapshotsService } from './snapshots.service.js';
import type { SnapshotView } from './snapshots.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InsightsService } from './insights.service.js';

/**
 * x211 — Insight snapshots. Database-free proofs over the module with the **real** `authorize`. The
 * capture/list/get-by-id data paths are ordinary tenant-scoped SQL (no schema-shape logic worth a
 * unit), so the properties the controller owns are the ones proven here:
 *   - a principal `work.read` refuses (a client — the capability is internal-only) is a 403, the
 *     org-level relation half of the route's `work.read` ceiling, checked before any read or write;
 *   - an unknown report kind is a 400, never a stored row or a silently empty list;
 *   - a permitted org-wide principal captures and lists through to the service.
 */

const ORG = 'organization-0000-0000-0000-000000000001';

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

/** A service whose data methods are stubbed; the real `authorize`-backed gate is preserved. */
function serviceWith(overrides: Partial<InsightSnapshotsService> = {}): InsightSnapshotsService {
  const database = {} as unknown as TenantDatabase;
  const insights = {} as unknown as InsightsService;
  const service = new InsightSnapshotsService(database, insights);
  return Object.assign(service, overrides);
}

const sampleView: SnapshotView = {
  id: 'snapshot-1',
  kind: 'portfolio',
  capturedAt: '2026-09-27T00:00:00.000Z',
  payload: { projectCount: 0 },
};

describe('InsightSnapshotsController', () => {
  it('mayReadOrgInsights allows an org-wide internal principal and refuses a client', () => {
    const service = serviceWith();
    expect(service.mayReadOrgInsights(orgWide(), context)).toBe(true);
    expect(service.mayReadOrgInsights(client(), context)).toBe(false);
  });

  it('refuses a caller without work.read with a 403 before any read or write', async () => {
    let touched = false;
    const service = serviceWith({
      capture: async () => {
        touched = true;
        return sampleView;
      },
    });
    const controller = new InsightSnapshotsController(service);
    await expect(
      controller.capture(context, client(), { kind: 'portfolio' }),
    ).rejects.toMatchObject({ status: 403 } as Partial<ApiError>);
    expect(touched).toBe(false);
  });

  it('rejects an unknown report kind with a 400', async () => {
    const controller = new InsightSnapshotsController(serviceWith());
    await expect(controller.list(context, orgWide(), 'bogus')).rejects.toMatchObject({
      status: 400,
    } as Partial<ApiError>);
    await expect(controller.capture(context, orgWide(), { kind: 'nope' })).rejects.toMatchObject({
      status: 400,
    } as Partial<ApiError>);
  });

  it('captures and lists through to the service for a permitted principal', async () => {
    const captured: string[] = [];
    const service = serviceWith({
      capture: async (_ctx, _principal, kind) => {
        captured.push(kind);
        return { ...sampleView, kind };
      },
      list: async (_ctx, kind) => [{ ...sampleView, kind }],
    });
    const controller = new InsightSnapshotsController(service);

    await expect(
      controller.capture(context, orgWide(), { kind: 'workload' }),
    ).resolves.toMatchObject({ kind: 'workload' });
    expect(captured).toEqual(['workload']);
    await expect(controller.list(context, orgWide(), 'portfolio')).resolves.toHaveLength(1);
  });
});
