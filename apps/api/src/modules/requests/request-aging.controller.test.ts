import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { RequestAgingController } from './request-aging.controller.js';
import type { OpenRequestRow, RequestAgingRepository } from './request-aging.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x154 — the request-aging roll-up (module 11). Database-free proofs over the module's fakes with the
 * **real** `authorize`: the read is an ordinary tenant-scoped `SELECT` (no schema change, so no
 * `.db.test.ts`), and the properties the controller owns are unit-provable:
 *   - the bucketing by the fixed thresholds is correct and the counts follow it;
 *   - the read is tenant-scoped — a cross-tenant row that reaches the loop is dropped before it is
 *     aged (Known-trap: scope before the count);
 *   - it is relation-scoped — a project-scoped manager's aging queue never includes a request in a
 *     project they do not own;
 *   - a principal without `client_request.triage` (a client — the capability is internal-only) is a
 *     403, the org-level relation half of the route's ceiling.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A row created `daysAgo` days before now, in the given project/tenant, with an optional commitment. */
function row(overrides: Partial<OpenRequestRow> & { daysAgo: number }): OpenRequestRow {
  const { daysAgo, ...rest } = overrides;
  return {
    organizationId: ORG,
    id: `request-${daysAgo}-${rest.projectId ?? 'p1'}`,
    title: `Request from ${daysAgo}d ago`,
    state: 'submitted',
    projectId: 'p1',
    clientOrganizationId: 'client-org-0000-0000-000000000001',
    createdAt: new Date(Date.now() - daysAgo * DAY_MS),
    commitment: null,
    ...rest,
  };
}

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

/** A manager whose scope is project `p1` only — not org-wide. */
function scopedManager(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000002',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: 'membership-0000-0000-000000000002',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: ['p1'],
    hasOrgWideScope: false,
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

function controllerWith(rows: readonly OpenRequestRow[]): RequestAgingController {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    listOpen: async () => rows,
  } as unknown as RequestAgingRepository;
  return new RequestAgingController(database, repository);
}

describe('RequestAgingController.list', () => {
  it('buckets open requests by the fixed thresholds and tallies the counts, dropping a cross-tenant row (Known-trap)', async () => {
    const view = await controllerWith([
      row({ daysAgo: 1 }), // fresh (< 3)
      row({ daysAgo: 3, commitment: 'committed' }), // aging (>= 3, < 7), committed
      row({ daysAgo: 6 }), // aging
      row({ daysAgo: 10 }), // overdue (>= 7)
      row({ daysAgo: 20, organizationId: OTHER_ORG }), // cross-tenant — never contributes
    ]).list(context, orgWide());

    expect(view.thresholds).toEqual({ agingDays: 3, overdueDays: 7 });
    expect(view.counts).toEqual({ fresh: 1, aging: 2, overdue: 1, uncommitted: 3, total: 4 });
    expect(view.requests).toHaveLength(4);

    const overdue = view.requests.find((item) => item.bucket === 'overdue');
    expect(overdue?.ageDays).toBe(10);
    const committed = view.requests.find((item) => item.committed);
    expect(committed?.ageDays).toBe(3);
    expect(committed?.bucket).toBe('aging');
    expect(typeof view.computedAt).toBe('string');
  });

  it('scopes a project-scoped manager to their own projects — a request in another project never appears', async () => {
    const view = await controllerWith([
      row({ daysAgo: 5, projectId: 'p1' }), // theirs
      row({ daysAgo: 8, projectId: 'p2', id: 'request-foreign-project' }), // not theirs — dropped
    ]).list(context, scopedManager());

    expect(view.counts.total).toBe(1);
    expect(view.requests.map((item) => item.projectId)).toEqual(['p1']);
    expect(view.requests.some((item) => item.id === 'request-foreign-project')).toBe(false);
  });

  it('refuses a principal without client_request.triage (a client — the capability is internal-only) with a 403', async () => {
    await expect(
      controllerWith([row({ daysAgo: 1 })]).list(context, client()),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses an over-wide or non-integer limit with a 400 rather than clamping it', async () => {
    await expect(controllerWith([]).list(context, orgWide(), '0')).rejects.toBeInstanceOf(ApiError);
    await expect(controllerWith([]).list(context, orgWide(), '99999')).rejects.toMatchObject({
      status: 400,
    });
    await expect(controllerWith([]).list(context, orgWide(), 'lots')).rejects.toMatchObject({
      status: 400,
    });
  });
});
