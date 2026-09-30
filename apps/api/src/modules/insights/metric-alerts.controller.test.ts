import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { ApiError } from '../../common/http/errors.js';
import { InsightMetricAlertsController } from './metric-alerts.controller.js';
import { InsightMetricAlertsService } from './metric-alerts.service.js';
import type { MetricAlertStatusView, MetricAlertView } from './metric-alerts.service.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x319 — Insight metric alerts. Database-free proofs over the module with the **real** `authorize`.
 * The upsert/list/delete data paths are ordinary tenant- and self-scoped SQL, so the properties the
 * controller owns are proven here:
 *   - every route is behind `work.read` — a client (internal-only capability) is a 403 before any write;
 *   - an unknown metric key or comparator, or a non-numeric threshold, is a 400, never a stored row;
 *   - the list is the caller's own rows evaluated against the latest workload snapshot, breached/ok.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const context = { organizationId: ORG } as unknown as TenantContext;

/** A member holds `work.read` (an internal role); the subject is always this principal's own user. */
function member(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000001',
    organizationId: ORG,
    kind: 'internal',
    role: 'member',
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

/** A client holds no `work.read` (internal-only) — the refusal case. */
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

function serviceWith(overrides: Partial<InsightMetricAlertsService> = {}): InsightMetricAlertsService {
  const database = {} as unknown as TenantDatabase;
  const service = new InsightMetricAlertsService(database);
  return Object.assign(service, overrides);
}

describe('InsightMetricAlertsController', () => {
  it('sets an alert for a member holding work.read', async () => {
    const written: MetricAlertView[] = [];
    const controller = new InsightMetricAlertsController(
      serviceWith({
        set: async (_ctx, _principal, input) => {
          written.push(input);
          return input;
        },
      }),
    );
    await expect(
      controller.set(context, member(), { metricKey: 'open_items', comparator: 'gte', threshold: 5 }),
    ).resolves.toMatchObject({ metricKey: 'open_items', comparator: 'gte', threshold: 5 });
    expect(written).toHaveLength(1);
  });

  it('refuses a write from a client with a 403 before any write', async () => {
    let touched = false;
    const controller = new InsightMetricAlertsController(
      serviceWith({
        set: async (_ctx, _principal, input) => {
          touched = true;
          return input;
        },
      }),
    );
    await expect(
      controller.set(context, client(), { metricKey: 'open_items', comparator: 'gte', threshold: 5 }),
    ).rejects.toMatchObject({ status: 403 } as Partial<ApiError>);
    expect(touched).toBe(false);
  });

  it('rejects an unknown metric key, unknown comparator and non-numeric threshold with a 400', async () => {
    let touched = false;
    const controller = new InsightMetricAlertsController(
      serviceWith({
        set: async (_ctx, _principal, input) => {
          touched = true;
          return input;
        },
      }),
    );
    await expect(
      controller.set(context, member(), { metricKey: 'bogus', comparator: 'gte', threshold: 5 }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
    await expect(
      controller.set(context, member(), { metricKey: 'open_items', comparator: 'eq', threshold: 5 }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
    await expect(
      controller.set(context, member(), {
        metricKey: 'open_items',
        comparator: 'gte',
        threshold: 'lots',
      }),
    ).rejects.toMatchObject({ status: 400 } as Partial<ApiError>);
    expect(touched).toBe(false);
  });

  it('lists the caller own alerts evaluated breached/ok, and refuses a client', async () => {
    const rows: readonly MetricAlertStatusView[] = [
      { metricKey: 'open_items', comparator: 'gte', threshold: 5, currentValue: 8, breached: true },
    ];
    const controller = new InsightMetricAlertsController(serviceWith({ list: async () => rows }));
    await expect(controller.list(context, member())).resolves.toEqual({ alerts: rows });
    await expect(controller.list(context, client())).rejects.toMatchObject({
      status: 403,
    } as Partial<ApiError>);
  });

  it('refuses a client delete and rejects an unknown metric key on delete with a 400', async () => {
    let touched = false;
    const controller = new InsightMetricAlertsController(
      serviceWith({
        remove: async () => {
          touched = true;
        },
      }),
    );
    await expect(controller.remove(context, client(), 'open_items')).rejects.toMatchObject({
      status: 403,
    } as Partial<ApiError>);
    await expect(controller.remove(context, member(), 'bogus')).rejects.toMatchObject({
      status: 400,
    } as Partial<ApiError>);
    expect(touched).toBe(false);
  });

  it('evaluates gte/lte against the latest workload snapshot and reports null when none exists', async () => {
    const row = (metricKey: string, comparator: string, threshold: number) =>
      ({
        id: 'a',
        organizationId: ORG,
        memberUserId: member().userId,
        metricKey,
        comparator,
        threshold,
        createdAt: new Date(),
      }) as unknown as import('../../common/database/schema.js').InsightMetricAlertRow;

    // A fake database.read that simply invokes the repository callback, and a fake repository that
    // returns fixed rows and a fixed snapshot payload — so the service's own breach evaluation is
    // proven without a database.
    const makeService = (payload: unknown) => {
      const repository = {
        listForMember: async () => [
          row('open_items', 'gte', 5), // 8 >= 5 → breached
          row('scheduled_items', 'lte', 5), // 2 <= 5 → breached
          row('active_projects', 'gte', 9), // 3 >= 9 → ok
        ],
        latestWorkloadPayload: async () => payload,
      } as unknown as import('./metric-alerts.repository.js').InsightMetricAlertsRepository;
      const database = {
        read: async (_ctx: TenantContext, run: (r: unknown) => unknown) => run(undefined),
      } as unknown as TenantDatabase;
      return new InsightMetricAlertsService(database, repository);
    };

    const withSnapshot = makeService({
      totals: { openItemCount: 8, scheduledItemCount: 2, projectCount: 3, assigneeCount: 4 },
    });
    expect(await withSnapshot.list(context, member())).toEqual([
      { metricKey: 'open_items', comparator: 'gte', threshold: 5, currentValue: 8, breached: true },
      { metricKey: 'scheduled_items', comparator: 'lte', threshold: 5, currentValue: 2, breached: true },
      { metricKey: 'active_projects', comparator: 'gte', threshold: 9, currentValue: 3, breached: false },
    ]);

    // No snapshot captured yet: current value is null and nothing is breached (no fabricated number).
    const noSnapshot = makeService(undefined);
    expect(await noSnapshot.list(context, member())).toEqual([
      { metricKey: 'open_items', comparator: 'gte', threshold: 5, currentValue: null, breached: false },
      { metricKey: 'scheduled_items', comparator: 'lte', threshold: 5, currentValue: null, breached: false },
      { metricKey: 'active_projects', comparator: 'gte', threshold: 9, currentValue: null, breached: false },
    ]);
  });
});
