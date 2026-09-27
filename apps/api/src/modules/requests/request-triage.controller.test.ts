import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { RequestTriageController } from './request-triage.controller.js';
import type { RequestTriageRepository, TriagedRequestRow } from './request-triage.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x265 — request triage (module 11). Database-free proofs over the module's fakes with the **real**
 * `authorize` (the service builds it): the properties the controller and service own are unit-
 * provable without the schema change, which the chain's `.db.test` covers.
 *   - the mandated refusal: a category off the fixed allowlist is a 400 and nothing is upserted;
 *   - capability + tenant scope before any write: a project-scoped manager triaging a request in a
 *     project they do not own is a 403, and no upsert runs;
 *   - a request that is not this studio's is a 404 (resolve before authorize).
 */

const ORG = 'organization-0000-0000-0000-000000000001';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

const REQUEST: TriagedRequestRow = {
  id: 'request-0000-0000-0000-000000000001',
  organizationId: ORG,
  projectId: 'p1',
  clientOrganizationId: 'client-org-0000-0000-000000000001',
};

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

/** A manager scoped to project `p2` only — not the request's project `p1`. */
function scopedManager(): Principal {
  return {
    userId: 'user-0000-0000-0000-0000-000000000002',
    organizationId: ORG,
    kind: 'internal',
    role: 'manager',
    membershipId: 'membership-0000-0000-000000000002',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: ['p2'],
    hasOrgWideScope: false,
  };
}

function controllerWith(repo: Partial<RequestTriageRepository>): {
  controller: RequestTriageController;
  upsert: ReturnType<typeof vi.fn>;
} {
  const upsert = vi.fn(async () => {});
  const repository = {
    findRequest: async () => REQUEST,
    findActiveMembershipId: async () => null,
    findTriage: async () => null,
    upsert,
    ...repo,
  } as unknown as RequestTriageRepository;
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return { controller: new RequestTriageController(database, repository), upsert };
}

describe('RequestTriageController.put', () => {
  it('refuses a category off the fixed allowlist with a 400 and never upserts (mandated refusal)', async () => {
    const { controller, upsert } = controllerWith({});
    await expect(
      controller.put(context, orgWide(), REQUEST.id, { category: 'not-a-category' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('upserts a valid triage and returns the stored view', async () => {
    const { controller, upsert } = controllerWith({
      findTriage: async () => ({ category: 'bug', assigneeMembershipId: null }) as never,
    });
    const view = await controller.put(context, orgWide(), REQUEST.id, { category: 'bug' });
    expect(view).toMatchObject({ requestId: REQUEST.id, category: 'bug', triaged: true });
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('refuses a manager triaging a request outside their project scope with a 403 and no upsert', async () => {
    const { controller, upsert } = controllerWith({});
    await expect(
      controller.put(context, scopedManager(), REQUEST.id, { category: 'bug' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('returns 404 for a request that does not exist in this studio (resolve before authorize)', async () => {
    const { controller, upsert } = controllerWith({ findRequest: async () => null });
    await expect(
      controller.put(context, orgWide(), REQUEST.id, { category: 'bug' }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      controller.put(context, orgWide(), REQUEST.id, { category: 'bug' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(upsert).not.toHaveBeenCalled();
  });
});
