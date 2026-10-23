import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import type { AuditService } from '../audit/audit.service.js';
import { CustomRolesController } from './roles.controller.js';
import type { CustomRolesRepository } from './roles.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { CustomRoleRow } from '../../common/database/schema.js';

/**
 * Custom roles (x173) create + list over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — the organization is resolved
 * tenant-scoped BEFORE the org-wide `org.manage` authorize (a cross-tenant context is a 404 with no
 * write, the Known trap); the fixed `CAPABILITIES` allowlist is the boundary (a capability off it is a
 * 400 with no write); the privilege-escalation guard refuses a capability the caller cannot exercise
 * org-wide (a reviewer-gated capability like `approval.decide` is a 403 with no write for anyone but
 * the owner, whose ceiling is every capability); a duplicate name is a 409; and both routes sit behind `org.manage`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OWNER_USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';

/** An owner — its ceiling holds every capability, so it may grant any of them. */
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

/** An org_admin — holds `org.manage` (ADM-03) but, unlike the owner, grants only what it can exercise. */
function orgAdmin(): Principal {
  return { ...owner(), role: 'org_admin' };
}

/** A workspace_admin — does not hold `org.manage`, so the create/list authorize denies. */
function workspaceAdmin(): Principal {
  return { ...owner(), role: 'workspace_admin', hasOrgWideScope: false };
}

const context = {
  organizationId: ORG,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/**
 * An in-memory {@link CustomRolesRepository}. `orgExists` controls the resolve-before-authorize step: a
 * cross-tenant context is modelled by constructing it `false`, exactly what the real tenant-scoped
 * resolve returns for an organization not in this tenant.
 */
class FakeCustomRolesRepository {
  readonly rows: CustomRoleRow[] = [];
  insertCalls = 0;

  constructor(private readonly orgExists = true) {}

  resolveOrganization(): Promise<{ readonly id: string } | undefined> {
    return Promise.resolve(this.orgExists ? { id: ORG } : undefined);
  }

  listAll(): Promise<readonly CustomRoleRow[]> {
    return Promise.resolve(this.rows);
  }

  findByName(_r: unknown, _c: unknown, name: string): Promise<CustomRoleRow | undefined> {
    return Promise.resolve(this.rows.find((row) => row.name === name));
  }

  insert(
    _r: unknown,
    _c: unknown,
    input: { name: string; capabilities: readonly string[]; createdBy: string },
  ): Promise<string> {
    this.insertCalls += 1;
    const id = `role-${this.rows.length + 1}`;
    this.rows.push({
      id,
      organizationId: ORG,
      name: input.name,
      capabilitiesJson: JSON.stringify(input.capabilities),
      createdBy: input.createdBy,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    });
    return Promise.resolve(id);
  }
}

function controllerWith(
  repo: FakeCustomRolesRepository,
  audit?: { record: (...args: unknown[]) => Promise<unknown> },
): CustomRolesController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new CustomRolesController(
    database,
    repo as unknown as CustomRolesRepository,
    audit as unknown as AuditService,
  );
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('CustomRolesController (ADM roles, x173)', () => {
  it('creates a role from held capabilities and reads it back (the tenant-scoped round trip)', async () => {
    const repo = new FakeCustomRolesRepository();
    const controller = controllerWith(repo);

    const before = await controller.list(context, owner());
    expect(before.roles).toEqual([]);

    const after = await controller.create(context, owner(), {
      name: 'Coordinator',
      capabilities: ['work.read', 'work.create'],
    });
    expect(repo.insertCalls).toBe(1);
    expect(after.roles).toHaveLength(1);
    expect(after.roles[0]).toMatchObject({
      name: 'Coordinator',
      capabilities: ['work.read', 'work.create'],
    });
  });

  it('400s a capability off the allowlist, without a write (no arbitrary capability is stored)', async () => {
    const repo = new FakeCustomRolesRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.create(context, owner(), {
        name: 'Bogus',
        capabilities: ['work.read', 'made.up.capability'],
      }),
      400,
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('400s an empty or missing name and an empty capability list, without a write', async () => {
    const repo = new FakeCustomRolesRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.create(context, owner(), { name: '   ', capabilities: ['work.read'] }),
      400,
    );
    await expectStatus(
      controller.create(context, owner(), { name: 'Empty', capabilities: [] }),
      400,
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('403s a capability the caller cannot exercise org-wide (escalation guard), without a write', async () => {
    const repo = new FakeCustomRolesRepository();
    const controller = controllerWith(repo);

    // `approval.decide` is reviewer-gated: an org admin may exercise it only when assigned as reviewer,
    // never org-wide. Putting it in a role would grant more than the author holds, so the guard refuses
    // it — with no write.
    await expectStatus(
      controller.create(context, orgAdmin(), {
        name: 'Approver',
        capabilities: ['work.read', 'approval.decide'],
      }),
      403,
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('lets the owner grant any capability, approval.decide included, and audits the new role (ADM-08, ADM-11)', async () => {
    const repo = new FakeCustomRolesRepository();
    const recorded: unknown[] = [];
    const audit = { record: (...args: unknown[]) => Promise.resolve(recorded.push(args[2])) };
    const controller = controllerWith(repo, audit);

    await controller.create(context, owner(), {
      name: 'Approver',
      capabilities: ['work.read', 'approval.read', 'approval.decide'],
    });
    expect(repo.insertCalls).toBe(1);
    expect(recorded).toEqual([
      {
        action: 'custom_role.created',
        objectId: 'role-1',
        result: 'allowed',
        metadata: { capability_count: 3 },
      },
    ]);
  });

  it('409s a duplicate role name, without a second write', async () => {
    const repo = new FakeCustomRolesRepository();
    const controller = controllerWith(repo);

    await controller.create(context, owner(), { name: 'Coordinator', capabilities: ['work.read'] });
    await expectStatus(
      controller.create(context, owner(), { name: 'Coordinator', capabilities: ['work.create'] }),
      409,
    );
    expect(repo.insertCalls).toBe(1);
  });

  it('404s a cross-tenant organization, before authorize and before any write (Known trap)', async () => {
    const repo = new FakeCustomRolesRepository(false);
    const controller = controllerWith(repo);

    await expectStatus(
      controller.create(context, owner(), { name: 'Coordinator', capabilities: ['work.read'] }),
      404,
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('403s a caller without org.manage on create and on list, with the real authorize, and does not write', async () => {
    const repo = new FakeCustomRolesRepository();
    const controller = controllerWith(repo);

    await expectStatus(
      controller.create(context, workspaceAdmin(), {
        name: 'Coordinator',
        capabilities: ['work.read'],
      }),
      403,
    );
    await expectStatus(controller.list(context, workspaceAdmin()), 403);
    expect(repo.insertCalls).toBe(0);
  });

  it('guards both routes with org.manage, so a caller without it is refused 403 by CapabilityGuard', () => {
    for (const method of ['list', 'create'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        CustomRolesController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});
