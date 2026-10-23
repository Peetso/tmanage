import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { MemberBulkRoleController } from './member-bulk-role.controller.js';
import type { MemberBulkRoleRepository } from './member-bulk-role.repository.js';
import type { MembershipsRepository } from './memberships.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { CustomRoleRow } from '../../common/database/schema.js';

/**
 * Admin bulk role assignment (x222) over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — the addressed role is resolved
 * tenant-scoped BEFORE authorize (a cross-tenant/unknown role id is a 404 with no write, the Known trap);
 * the privilege-escalation guard refuses a role whose capability subset the caller cannot exercise
 * org-wide (a reviewer-gated capability like `approval.decide` is a 403 with no write for a non-owner, so a bulk assign
 * can never hand out a role beyond the caller); a foreign/unknown membership id is reported not-found and
 * never written; the batch is bounded (over the cap is a 400); and the route sits behind `org.manage`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

/** An owner — its ceiling holds every capability. */
function owner(): Principal {
  return {
    userId: OWNER_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

/** An org_admin — holds `org.manage` (ADM-03) but is not an owner. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

/** A workspace_admin — does not hold `org.manage`, so the real authorize denies. */
function workspaceAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin', hasOrgWideScope: false };
}

const context = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

function role(id: string, name: string, capabilities: readonly string[]): CustomRoleRow {
  return {
    id,
    organizationId: ORG,
    name,
    capabilitiesJson: JSON.stringify(capabilities),
    createdBy: OWNER_USER,
    createdAt: new Date('2026-09-27T00:00:00.000Z'),
  };
}

/**
 * An in-memory {@link MemberBulkRoleRepository}. `findRoleById` models the tenant-scoped resolve (a role
 * absent from `rows`, e.g. one in another tenant, returns `undefined`). `assignRole` models the
 * tenant-scoped UPDATE: it writes (and returns true) only for a membership id in `memberIds`, and a
 * foreign/unknown id matches no row (no write, returns false) — exactly what the real scoped UPDATE does.
 */
class FakeBulkRoleRepository {
  applied: { membershipId: string; roleId: string }[] = [];

  constructor(
    readonly rows: CustomRoleRow[] = [],
    readonly memberIds: Set<string> = new Set(),
  ) {}

  findRoleById(_r: unknown, _c: unknown, id: string): Promise<CustomRoleRow | undefined> {
    return Promise.resolve(this.rows.find((row) => row.id === id));
  }

  keepOwners: boolean[] = [];

  assignRole(
    _r: unknown,
    _c: unknown,
    membershipId: string,
    roleId: string,
    options: { keepOwners: boolean },
  ): Promise<boolean> {
    this.keepOwners.push(options.keepOwners);
    if (!this.memberIds.has(membershipId)) return Promise.resolve(false);
    this.applied.push({ membershipId, roleId });
    return Promise.resolve(true);
  }
}

/** Active owner memberships, for the last-owner guard's reads. */
function fakeMemberships(activeOwners: readonly string[]): MembershipsRepository {
  return {
    findById: (_r: unknown, _c: unknown, id: string) =>
      Promise.resolve(activeOwners.includes(id) ? { id, role: 'owner', status: 'active' } : null),
    countActiveHoldersOfRoles: () => Promise.resolve(activeOwners.length),
  } as unknown as MembershipsRepository;
}

function controllerWith(
  repo: FakeBulkRoleRepository,
  activeOwners: readonly string[] = [],
): MemberBulkRoleController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new MemberBulkRoleController(
    database,
    repo as unknown as MemberBulkRoleRepository,
    undefined,
    fakeMemberships(activeOwners),
  );
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('MemberBulkRoleController (ADM bulk role assignment, x222)', () => {
  it('assigns a role to every valid member, one write per de-duplicated id', async () => {
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Coordinator', ['work.read', 'work.create'])],
      new Set(['m1', 'm2']),
    );
    const controller = controllerWith(repo);

    const result = await controller.assign(context, owner(), 'org', {
      roleId: 'r1',
      membershipIds: ['m1', 'm2', 'm1'],
    });

    expect(result.roleId).toBe('r1');
    expect(result.assignments).toEqual([
      { membershipId: 'm1', outcome: 'assigned' },
      { membershipId: 'm2', outcome: 'assigned' },
    ]);
    expect(repo.applied).toEqual([
      { membershipId: 'm1', roleId: 'r1' },
      { membershipId: 'm2', roleId: 'r1' },
    ]);
    // The wire projection never echoes the tenant id.
    expect(JSON.stringify(result)).not.toContain(ORG);
  });

  it('403s when the role carries a capability the caller cannot exercise (escalation), no write', async () => {
    // `approval.decide` is reviewer-gated: an org admin can never exercise it org-wide.
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Approver', ['work.read', 'approval.decide'])],
      new Set(['m1']),
    );
    const controller = controllerWith(repo);

    await expectStatus(
      controller.assign(context, orgAdmin(), 'org', { roleId: 'r1', membershipIds: ['m1'] }),
      403,
    );
    expect(repo.applied).toHaveLength(0);
  });

  it('lets the owner assign a role carrying approval.decide (ADM-08)', async () => {
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Approver', ['work.read', 'approval.decide'])],
      new Set(['m1']),
    );
    const controller = controllerWith(repo);

    await controller.assign(context, owner(), 'org', { roleId: 'r1', membershipIds: ['m1'] });
    expect(repo.applied).toEqual([{ membershipId: 'm1', roleId: 'r1' }]);
  });

  it('reports a foreign/unknown membership id not-found and never writes it', async () => {
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Coordinator', ['work.read'])],
      new Set(['m1']),
    );
    const controller = controllerWith(repo);

    const result = await controller.assign(context, owner(), 'org', {
      roleId: 'r1',
      membershipIds: ['m1', 'foreign'],
    });

    expect(result.assignments).toEqual([
      { membershipId: 'm1', outcome: 'assigned' },
      { membershipId: 'foreign', outcome: 'not_found' },
    ]);
    // The foreign id was not applied.
    expect(repo.applied).toEqual([{ membershipId: 'm1', roleId: 'r1' }]);
  });

  it('404s an unknown or cross-tenant role id, before authorize and before any write (Known trap)', async () => {
    const repo = new FakeBulkRoleRepository([], new Set(['m1']));
    const controller = controllerWith(repo);

    await expectStatus(
      controller.assign(context, owner(), 'org', { roleId: 'missing', membershipIds: ['m1'] }),
      404,
    );
    expect(repo.applied).toHaveLength(0);
  });

  it('400s a batch larger than the cap, without a write', async () => {
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Coordinator', ['work.read'])],
      new Set(['m1']),
    );
    const controller = controllerWith(repo);
    const tooMany = Array.from({ length: 101 }, (_v, i) => `m${i}`);

    await expectStatus(
      controller.assign(context, owner(), 'org', { roleId: 'r1', membershipIds: tooMany }),
      400,
    );
    // An empty list is also a 400.
    await expectStatus(
      controller.assign(context, owner(), 'org', { roleId: 'r1', membershipIds: [] }),
      400,
    );
    expect(repo.applied).toHaveLength(0);
  });

  it('403s a caller without org.manage, with the real authorize, no write', async () => {
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Coordinator', ['work.read'])],
      new Set(['m1']),
    );
    const controller = controllerWith(repo);

    await expectStatus(
      controller.assign(context, workspaceAdmin(), 'org', { roleId: 'r1', membershipIds: ['m1'] }),
      403,
    );
    expect(repo.applied).toHaveLength(0);
  });

  it('never lets a non-owner change an owner seat; an owner may (CQ-06)', async () => {
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Coordinator', ['work.read'])],
      new Set(['m1']),
    );
    const controller = controllerWith(repo);

    await controller.assign(context, orgAdmin(), 'org', { roleId: 'r1', membershipIds: ['m1'] });
    await controller.assign(context, owner(), 'org', { roleId: 'r1', membershipIds: ['m1'] });
    expect(repo.keepOwners).toEqual([true, false]);
  });

  it('409s an owner batch that would leave no active owner (ADM-01), no write', async () => {
    const repo = new FakeBulkRoleRepository(
      [role('r1', 'Coordinator', ['work.read'])],
      new Set(['m1', 'm2']),
    );
    await expectStatus(
      controllerWith(repo, ['m1']).assign(context, owner(), 'org', {
        roleId: 'r1',
        membershipIds: ['m1', 'm2'],
      }),
      409,
    );
    expect(repo.applied).toHaveLength(0);
  });

  it('guards the route with org.manage, so CapabilityGuard refuses a caller without it', () => {
    const capability = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      MemberBulkRoleController.prototype.assign,
    );
    expect(capability).toBe('org.manage');
  });
});
