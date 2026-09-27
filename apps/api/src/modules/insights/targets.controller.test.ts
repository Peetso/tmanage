import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { InsightTargetsController } from './targets.controller.js';
import { InsightTargetsService } from './targets.service.js';
import type { MetricTargetView } from './targets.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InsightsService } from './insights.service.js';

/**
 * x230 — Insight metric targets. Database-free proofs over the module with the **real** `authorize`.
 * The upsert/list data paths are ordinary tenant-scoped SQL, so the properties the controller owns are
 * proven here:
 *   - the write is behind `org.manage` — a `work.read`-only principal is a 403 before any write;
 *   - the read is behind `work.read` — a client (internal-only capability) is a 403;
 *   - an unknown metric/period or an out-of-range target is a 400, never a stored row;
 *   - the status compute flags on-track / behind and guards a zero target (no divide error).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG } as unknown as TenantContext;

/** Owner holds `org.manage` (org_admin is the one internal role that does not). */
function owner(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** A viewer with `work.read` but not `org.manage` — a member role. */
function member(): Principal {
  return { ...owner(), role: 'member', hasOrgWideScope: false };
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

function serviceWith(overrides: Partial<InsightTargetsService> = {}): InsightTargetsService {
  const database = {} as unknown as TenantDatabase;
  const insights = {} as unknown as InsightsService;
  const service = new InsightTargetsService(database, insights);
  return Object.assign(service, overrides);
}

const sample: MetricTargetView = { metric: 'open_items', targetValue: 10, period: 'weekly' };

describe('InsightTargetsController', () => {
  it('sets a target for a principal holding org.manage', async () => {
    const written: MetricTargetView[] = [];
    const controller = new InsightTargetsController(
      serviceWith({
        setTarget: async (_ctx, input) => {
          written.push(input);
          return input;
        },
      }),
    );
    await expect(
      controller.set(context, owner(), { metric: 'open_items', targetValue: 10, period: 'weekly' }),
    ).resolves.toMatchObject({ metric: 'open_items', targetValue: 10 });
    expect(written).toHaveLength(1);
  });

  it('refuses a write from a work.read-only member with a 403 before any write', async () => {
    let touched = false;
    const controller = new InsightTargetsController(
      serviceWith({
        setTarget: async (_ctx, input) => {
          touched = true;
          return input;
        },
      }),
    );
    await expect(
      controller.set(context, member(), {
        metric: 'open_items',
        targetValue: 10,
        period: 'weekly',
      }),
    ).rejects.toMatchObject({ status: 403 } as Partial<ApiError>);
    expect(touched).toBe(false);
  });

  it('allows a member (work.read) to list, and refuses a client', async () => {
    const controller = new InsightTargetsController(serviceWith({ list: async () => [sample] }));
    await expect(controller.list(context, member())).resolves.toHaveLength(1);
    await expect(controller.list(context, client())).rejects.toMatchObject({
      status: 403,
    } as Partial<ApiError>);
  });

  it('rejects an unknown metric, unknown period and out-of-range target with a 400', async () => {
    const controller = new InsightTargetsController(serviceWith({ setTarget: async (_c, i) => i }));
    await expect(
      controller.set(context, owner(), { metric: 'bogus', targetValue: 5, period: 'weekly' }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
    await expect(
      controller.set(context, owner(), { metric: 'open_items', targetValue: 5, period: 'nope' }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
    await expect(
      controller.set(context, owner(), { metric: 'open_items', targetValue: -1, period: 'weekly' }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
  });

  it('flags on-track / behind and guards a zero target in the status compute', async () => {
    const insights = {
      orgWorkload: async () => ({
        projects: [],
        totals: { projectCount: 3, assigneeCount: 2, openItemCount: 8, scheduledItemCount: 0 },
        computedAt: '2026-09-27T00:00:00.000Z',
      }),
    } as unknown as InsightsService;
    const service = new InsightTargetsService({} as unknown as TenantDatabase, insights);
    Object.assign(service, {
      list: async (): Promise<readonly MetricTargetView[]> => [
        { metric: 'open_items', targetValue: 10, period: 'weekly' }, // 8 < 10 → behind
        { metric: 'active_projects', targetValue: 3, period: 'weekly' }, // 3 >= 3 → on_track
        { metric: 'active_assignees', targetValue: 0, period: 'weekly' }, // zero target → attainment null
      ],
    });
    const controller = new InsightTargetsController(service);
    const rows = await controller.status(context, owner());
    expect(rows).toEqual([
      {
        metric: 'open_items',
        targetValue: 10,
        period: 'weekly',
        currentValue: 8,
        attainment: 0.8,
        status: 'behind',
      },
      {
        metric: 'active_projects',
        targetValue: 3,
        period: 'weekly',
        currentValue: 3,
        attainment: 1,
        status: 'on_track',
      },
      {
        metric: 'active_assignees',
        targetValue: 0,
        period: 'weekly',
        currentValue: 2,
        attainment: null,
        status: 'on_track',
      },
    ]);
  });
});
