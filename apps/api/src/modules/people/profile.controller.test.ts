import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { PersonProfileController } from './profile.controller.js';
import type {
  PersonProfileMemberRow,
  PersonProfileProjectRow,
  PersonProfileRepository,
} from './profile.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x169 — one member's profile. Database-free proofs over the module's fakes with the **real**
 * `authorize`: the reads are ordinary tenant-scoped `SELECT`s (no schema change, so no `.db.test.ts`),
 * and the properties the controller owns are unit-provable:
 *   - a resolved member's role, projects and open-work count are projected (non-sensitive fields);
 *   - a cross-tenant or unknown id is resolved before authorize and is a 404 (Known-trap), not a 403
 *     that would confirm the id exists elsewhere;
 *   - a principal `work.read` refuses (a client — the capability is internal-only) is a 403, the
 *     org-level relation half of the route's `work.read` ceiling.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';

const context = {
  organizationId: ORG,
  correlationId: 'correlation-0000-0000-0000-000000000001',
} as unknown as TenantContext;

function orgWide(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'org_admin',
    membershipId: MEMBERSHIP,
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

function controllerWith(
  member: PersonProfileMemberRow | null,
  projects: readonly PersonProfileProjectRow[],
  openWorkCount: number,
): PersonProfileController {
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    findMember: async () => member,
    listProjects: async () => projects,
    countOpenWork: async () => openWorkCount,
  } as unknown as PersonProfileRepository;

  return new PersonProfileController(database, repository);
}

const MEMBER: PersonProfileMemberRow = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
  userId: USER,
  displayName: 'Ada Lovelace',
  role: 'org_admin',
  status: 'active',
};

describe('PersonProfileController.personProfile', () => {
  it('projects a resolved member: role, projects, and open-work count (non-sensitive fields)', async () => {
    const projects: PersonProfileProjectRow[] = [
      { projectId: 'p1', name: 'Apollo', status: 'active', role: 'lead' },
      { projectId: 'p2', name: 'Zephyr', status: 'archived', role: 'member' },
    ];

    const view = await controllerWith(MEMBER, projects, 4).personProfile(
      context,
      orgWide(),
      MEMBERSHIP,
    );

    expect(view).toEqual({
      membershipId: MEMBERSHIP,
      userId: USER,
      displayName: 'Ada Lovelace',
      role: 'org_admin',
      status: 'active',
      projects: [
        { projectId: 'p1', name: 'Apollo', status: 'active', role: 'lead' },
        { projectId: 'p2', name: 'Zephyr', status: 'archived', role: 'member' },
      ],
      openWorkCount: 4,
      computedAt: view.computedAt,
    });
    expect(typeof view.computedAt).toBe('string');
    // No sensitive fields leak through the projection.
    expect(view).not.toHaveProperty('email');
  });

  it('answers a cross-tenant or unknown membership id with a 404, resolved before authorize (Known-trap)', async () => {
    await expect(
      controllerWith(null, [], 0).personProfile(context, orgWide(), 'membership-does-not-exist'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a principal without work.read (a client — the capability is internal-only) with a 403', async () => {
    await expect(
      controllerWith(MEMBER, [], 0).personProfile(context, client(), MEMBERSHIP),
    ).rejects.toMatchObject({ status: 403 });
  });
});
