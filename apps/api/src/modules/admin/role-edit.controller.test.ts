import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { RoleEditController } from './role-edit.controller.js';
import type { RoleEditRepository } from './role-edit.repository.js';
import { ApiError } from '../../common/http/errors.js';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { CustomRoleRow } from '../../common/database/schema.js';

/**
 * Custom role clone + edit (x195) over fakes, with the **real** `authorize`.
 *
 * The database is faked, but the policy is not: a real `Principal` runs through the real evaluator, so
 * these cases prove the rules that are the whole of this slice's safety — the addressed role is resolved
 * tenant-scoped BEFORE authorize (a cross-tenant/unknown id is a 404 with no write, the Known trap); the
 * fixed `CAPABILITIES` allowlist bounds an edit (a capability off it is a 400 with no write); the
 * privilege-escalation guard refuses a capability the caller cannot exercise org-wide on both edit and
 * clone (a reviewer-gated capability like `approval.decide` is a 403 with no write for anyone, the
 * owner included, so a clone can never carry caps beyond the caller); and both routes sit behind `org.manage`.
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

/** An org_admin — holds `org.manage` (ADM-03) but grants only what it can exercise org-wide. */
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
 * An in-memory {@link RoleEditRepository}. `findById` models the tenant-scoped resolve: a role absent
 * from `rows` (e.g. one in another tenant) returns `undefined`, exactly what the real scoped read gives.
 */
class FakeRoleEditRepository {
  insertCalls = 0;
  updateCalls = 0;

  constructor(readonly rows: CustomRoleRow[] = []) {}

  findById(_r: unknown, _c: unknown, id: string): Promise<CustomRoleRow | undefined> {
    return Promise.resolve(this.rows.find((row) => row.id === id));
  }

  findByName(_r: unknown, _c: unknown, name: string): Promise<CustomRoleRow | undefined> {
    return Promise.resolve(this.rows.find((row) => row.name === name));
  }

  insert(
    _r: unknown,
    _c: unknown,
    input: { name: string; capabilities: readonly string[]; createdBy: string },
  ): Promise<CustomRoleRow> {
    this.insertCalls += 1;
    const created = role(`role-${this.rows.length + 1}`, input.name, input.capabilities);
    this.rows.push(created);
    return Promise.resolve(created);
  }

  update(
    _r: unknown,
    _c: unknown,
    input: { id: string; name: string; capabilities: readonly string[] },
  ): Promise<CustomRoleRow> {
    this.updateCalls += 1;
    const row = this.rows.find((r) => r.id === input.id)!;
    row.name = input.name;
    row.capabilitiesJson = JSON.stringify(input.capabilities);
    return Promise.resolve(row);
  }
}

function controllerWith(repo: FakeRoleEditRepository): RoleEditController {
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new RoleEditController(database, repo as unknown as RoleEditRepository);
}

async function expectStatus<T>(promise: Promise<T>, status: number): Promise<void> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).status).toBe(status);
}

describe('RoleEditController (ADM role clone + edit, x195)', () => {
  it('clones a role, copying its capability subset under the new name', async () => {
    const repo = new FakeRoleEditRepository([
      role('r1', 'Coordinator', ['work.read', 'work.create']),
    ]);
    const controller = controllerWith(repo);

    const result = await controller.clone(context, owner(), 'r1', { name: 'Coordinator (copy)' });

    expect(repo.insertCalls).toBe(1);
    expect(result.role).toMatchObject({
      name: 'Coordinator (copy)',
      capabilities: ['work.read', 'work.create'],
    });
  });

  it('edits a role, persisting a valid capability subset', async () => {
    const repo = new FakeRoleEditRepository([role('r1', 'Coordinator', ['work.read'])]);
    const controller = controllerWith(repo);

    const result = await controller.edit(context, owner(), 'r1', {
      name: 'Lead',
      capabilities: ['work.read', 'work.update'],
    });

    expect(repo.updateCalls).toBe(1);
    expect(result.role).toMatchObject({ name: 'Lead', capabilities: ['work.read', 'work.update'] });
  });

  it('403s an edit whose new subset holds a capability the caller cannot exercise (escalation), no write', async () => {
    const repo = new FakeRoleEditRepository([role('r1', 'Coordinator', ['work.read'])]);
    const controller = controllerWith(repo);

    // `approval.decide` is reviewer-gated: an org admin can never exercise it org-wide.
    await expectStatus(
      controller.edit(context, orgAdmin(), 'r1', {
        name: 'Approver',
        capabilities: ['work.read', 'approval.decide'],
      }),
      403,
    );
    expect(repo.updateCalls).toBe(0);
  });

  it('403s a clone that would carry a capability beyond the caller (escalation), without a write', async () => {
    // The source role holds a reviewer-gated capability; cloning it must not widen access.
    const repo = new FakeRoleEditRepository([
      role('r1', 'Approver', ['work.read', 'approval.decide']),
    ]);
    const controller = controllerWith(repo);

    await expectStatus(
      controller.clone(context, orgAdmin(), 'r1', { name: 'Approver (copy)' }),
      403,
    );
    expect(repo.insertCalls).toBe(0);
  });

  it('400s an edit with a capability off the allowlist, without a write', async () => {
    const repo = new FakeRoleEditRepository([role('r1', 'Coordinator', ['work.read'])]);
    const controller = controllerWith(repo);

    await expectStatus(
      controller.edit(context, owner(), 'r1', {
        name: 'Bogus',
        capabilities: ['work.read', 'made.up.capability'],
      }),
      400,
    );
    expect(repo.updateCalls).toBe(0);
  });

  it('404s an unknown or cross-tenant id, before authorize and before any write (Known trap)', async () => {
    const repo = new FakeRoleEditRepository([]);
    const controller = controllerWith(repo);

    await expectStatus(
      controller.edit(context, owner(), 'missing', {
        name: 'Lead',
        capabilities: ['work.read'],
      }),
      404,
    );
    await expectStatus(controller.clone(context, owner(), 'missing', { name: 'Copy' }), 404);
    expect(repo.updateCalls).toBe(0);
    expect(repo.insertCalls).toBe(0);
  });

  it('409s an edit whose new name collides with another role, but allows renaming to its own name', async () => {
    const repo = new FakeRoleEditRepository([
      role('r1', 'Coordinator', ['work.read']),
      role('r2', 'Lead', ['work.read']),
    ]);
    const controller = controllerWith(repo);

    await expectStatus(
      controller.edit(context, owner(), 'r1', { name: 'Lead', capabilities: ['work.read'] }),
      409,
    );
    // Renaming a role to its own current name is not a conflict.
    const same = await controller.edit(context, owner(), 'r1', {
      name: 'Coordinator',
      capabilities: ['work.read'],
    });
    expect(same.role.name).toBe('Coordinator');
    expect(repo.updateCalls).toBe(1);
  });

  it('403s a caller without org.manage on clone and on edit, with the real authorize, no write', async () => {
    const repo = new FakeRoleEditRepository([role('r1', 'Coordinator', ['work.read'])]);
    const controller = controllerWith(repo);

    await expectStatus(controller.clone(context, workspaceAdmin(), 'r1', { name: 'Copy' }), 403);
    await expectStatus(
      controller.edit(context, workspaceAdmin(), 'r1', {
        name: 'Lead',
        capabilities: ['work.read'],
      }),
      403,
    );
    expect(repo.insertCalls).toBe(0);
    expect(repo.updateCalls).toBe(0);
  });

  it('guards both routes with org.manage, so CapabilityGuard refuses a caller without it', () => {
    for (const method of ['clone', 'edit'] as const) {
      const capability = Reflect.getMetadata(
        REQUIRED_CAPABILITY,
        RoleEditController.prototype[method],
      );
      expect(capability).toBe('org.manage');
    }
  });
});
