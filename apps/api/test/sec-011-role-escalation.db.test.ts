import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { capabilitiesFor, uuidv7 } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { TenantDatabase, createTenantContext } from '../src/common/database/tenant-context.js';
import type { TenantContext } from '../src/common/database/tenant-context.js';
import { CustomRolesController } from '../src/modules/admin/roles.controller.js';
import { CustomRolesRepository } from '../src/modules/admin/roles.repository.js';
import { RoleEditController } from '../src/modules/admin/role-edit.controller.js';
import { RoleEditRepository } from '../src/modules/admin/role-edit.repository.js';
import { ApiError } from '../src/common/http/errors.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * SEC-011 — custom-role RBAC escalation + cross-tenant role use, against a real local MySQL
 * server (module 18, migration 0071). Disjoint from T005's `admin-001-roles-policies.db.test.ts`
 * and from the fakes-only `roles.controller.test.ts`: this suite drives the **real** controllers
 * over a **real** tenant-scoped `TenantDatabase`, so every refusal is checked for its database
 * consequence — the thing a fake repository cannot prove.
 *
 * What only this suite can prove (`25-AUTHORIZATION-AND-TENANT-ISOLATION-SPEC.md` §4, §11;
 * `12-PERMISSION-MATRIX.md` §2):
 *
 * 1. **A role can never carry a capability its creator cannot exercise org-wide.** The
 *    privilege-escalation guard runs the real `authorize` against an org-wide resource, so a
 *    reviewer-gated capability (`approval.decide` — held in the org_admin ceiling but exercisable
 *    only per object) is a 403 for an org_admin on create, clone and edit, and the `custom_roles`
 *    table shows **no new row and no changed `capabilities_json`** afterwards. The one exemption
 *    is an active internal owner (ADM-08, wave A1 3a6018bc — Peter decided 2026-10-23 that the
 *    owner may grant approval.decide to any role): the owner's ceiling is every capability, so an
 *    owner-made role never widens access past its author, and whoever holds it still needs the
 *    reviewer relation on each approval. That allowance is proven here too, row and all.
 * 2. **A custom role is tenant-local.** A role id created in the §11 twin tenant cannot be read,
 *    cloned or edited from the sibling tenant — each is a 404 (indistinguishable from an unknown
 *    id, never a 403 that would confirm the row exists), and the twin's row is byte-for-byte
 *    untouched afterwards.
 * 3. **A non-admin member cannot reach the role write paths at all.** A `member` principal is
 *    refused by the org-wide `org.manage` decision (403, audit code `custom_roles.manage:*`) on
 *    create, clone and edit, with no row written and no row changed.
 *
 * Known trap honoured: the admin pool clock is SYSTEM, so the one fixture row this suite writes
 * directly through the admin pool (the pre-existing twin role, in {@link seedTwinRole}) is dated
 * from a bound `new Date(...)`, never `current_timestamp`. Every role the system under test writes
 * goes through the runtime-scoped repositories, where `created_at` is the engine's own clock.
 */

let db: TestDatabase;
let world: SeedWorld;
let tenant: TenantDatabase;

let ownerCtx: TenantContext;
let owner: Principal;
let adminCtx: TenantContext;
let admin: Principal;
let memberCtx: TenantContext;
let member: Principal;
let twinOwnerCtx: TenantContext;
let twinOwner: Principal;

let roles: CustomRolesController;
let edit: RoleEditController;

const POLICY_VERSION = '2026-08-30';

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

/** Count the custom roles that exist for a tenant right now. */
async function roleCount(organizationId: string): Promise<number> {
  const rows = await observe('select count(*) as n from custom_roles where organization_id = ?', [
    organizationId,
  ]);
  return Number(rows[0]?.['n']);
}

/** The stored `(name, capabilities_json)` for one role id, or undefined — the write-consequence probe. */
async function roleSnapshot(
  id: string,
): Promise<{ name: string; capabilitiesJson: string } | undefined> {
  const rows = await observe('select name, capabilities_json from custom_roles where id = ?', [id]);
  const row = rows[0];
  if (!row) return undefined;
  return { name: String(row['name']), capabilitiesJson: String(row['capabilities_json']) };
}

/** The id of a just-created role, looked up by name in a create view (throws if absent). */
function roleIdByName(
  view: { readonly roles: readonly { readonly id: string; readonly name: string }[] },
  name: string,
): string {
  const found = view.roles.find((r) => r.name === name);
  if (!found) throw new Error(`expected a role named ${name} in the view`);
  return found.id;
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(status);
    return error as ApiError;
  }
  throw new Error(`expected a ${status} refusal and got success`);
}

/** An internal principal for a seeded user, with the ceiling for `role`. */
function internalPrincipal(
  organizationId: string,
  user: { id: string; membershipId: string },
  role: 'owner' | 'org_admin' | 'member',
  projectIds: readonly string[],
): { ctx: TenantContext; principal: Principal } {
  const ctx = createTenantContext({
    organizationId,
    userId: user.id,
    membershipId: user.membershipId,
    principalKind: 'internal',
    capabilities: capabilitiesFor(role),
    policyVersion: POLICY_VERSION,
    correlationId: uuidv7(),
  });
  const principal: Principal = {
    userId: user.id,
    organizationId,
    kind: 'internal',
    role,
    membershipId: user.membershipId,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [...projectIds],
    hasOrgWideScope: role === 'owner' || role === 'org_admin',
  };
  return { ctx, principal };
}

/**
 * Write one pre-existing custom role directly into a tenant through the admin pool, so the clone
 * and cross-tenant cases have a real row to address. Dated from a bound `new Date(...)` — the
 * admin pool clock is SYSTEM (Known trap), so `current_timestamp` must not be used here.
 */
async function seedRole(
  tenantWorld: { readonly organizationId: string; readonly owner: { readonly id: string } },
  name: string,
  capabilities: readonly string[],
): Promise<string> {
  const id = uuidv7();
  await db.admin.execute(
    `insert into custom_roles (id, organization_id, name, capabilities_json, created_by, created_at)
     values (?, ?, ?, ?, ?, ?)`,
    [
      id,
      tenantWorld.organizationId,
      name,
      JSON.stringify(capabilities),
      tenantWorld.owner.id,
      new Date('2026-09-01T00:00:00.000Z'),
    ],
  );
  return id;
}

/** {@link seedRole} into the §11 twin tenant. */
async function seedTwinRole(name: string, capabilities: readonly string[]): Promise<string> {
  return seedRole(world.twin, name, capabilities);
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });

  ({ ctx: ownerCtx, principal: owner } = internalPrincipal(
    world.northstar.organizationId,
    world.northstar.owner,
    'owner',
    [],
  ));
  // An org_admin: every capability in its ceiling (ADM-03) and org.manage, but no owner exemption.
  // The suite drives the controllers directly, so the principal is the one the auth layer would
  // build for an org_admin membership; the seeded manager's identity carries it.
  ({ ctx: adminCtx, principal: admin } = internalPrincipal(
    world.northstar.organizationId,
    world.northstar.manager,
    'org_admin',
    [],
  ));
  ({ ctx: memberCtx, principal: member } = internalPrincipal(
    world.northstar.organizationId,
    world.northstar.designer,
    'member',
    [world.northstar.projectId],
  ));
  ({ ctx: twinOwnerCtx, principal: twinOwner } = internalPrincipal(
    world.twin.organizationId,
    world.twin.owner,
    'owner',
    [],
  ));

  roles = new CustomRolesController(tenant, new CustomRolesRepository());
  edit = new RoleEditController(tenant, new RoleEditRepository());
});

afterAll(async () => {
  await db?.stop();
});

describe('the privilege-escalation guard — a role can never exceed its creator', () => {
  it('an org_admin cannot create a role granting a reviewer-gated capability, and no row is written', async () => {
    const before = await roleCount(world.northstar.organizationId);

    // `approval.decide` is in the org_admin ceiling but reviewer-gated: an org_admin may exercise it
    // only when assigned reviewer on a specific object, never org-wide. Minting a role that grants
    // it org-wide would widen access past the author, so the guard refuses it — before any write.
    const error = await expectApiError(
      roles.create(adminCtx, admin, {
        name: 'Approvers everywhere',
        capabilities: ['work.read', 'approval.decide'],
      }),
      403,
    );
    expect(error.auditCode).toMatch(/^custom_roles\.escalation:/);

    // The database proof the controller unit test cannot give: no row landed.
    expect(await roleCount(world.northstar.organizationId)).toBe(before);
  });

  it('a legitimately held capability subset is created, and stored exactly as granted', async () => {
    const view = await roles.create(ownerCtx, owner, {
      name: 'Delivery coordinator',
      capabilities: ['work.read', 'work.create', 'work.update'],
    });
    expect(view.roles.map((r) => r.name)).toContain('Delivery coordinator');

    const created = view.roles.find((r) => r.name === 'Delivery coordinator');
    expect(created?.capabilities).toEqual(['work.read', 'work.create', 'work.update']);

    // Stored as a JSON array of exactly the allowlisted strings — nothing widened on the way to disk.
    const snapshot = await roleSnapshot(roleIdByName(view, 'Delivery coordinator'));
    expect(snapshot?.capabilitiesJson).toBe(
      JSON.stringify(['work.read', 'work.create', 'work.update']),
    );
  });

  it('an edit cannot add a capability the editor cannot exercise, and the stored subset is unchanged', async () => {
    // Start from a role the org_admin may hold in full.
    const createdId = roleIdByName(
      await roles.create(adminCtx, admin, {
        name: 'Editable role',
        capabilities: ['work.read'],
      }),
      'Editable role',
    );
    const before = await roleSnapshot(createdId);

    // Try to widen it to a reviewer-gated capability: 403, no change to the row.
    const error = await expectApiError(
      edit.edit(adminCtx, admin, createdId, {
        name: 'Editable role',
        capabilities: ['work.read', 'approval.decide'],
      }),
      403,
    );
    expect(error.auditCode).toMatch(/^custom_roles\.escalation:/);
    expect(await roleSnapshot(createdId)).toEqual(before);
  });

  it('a clone cannot carry a capability the cloner cannot exercise, and no copy is written', async () => {
    // A pre-existing role carrying a reviewer-gated capability, placed directly (as the owner, the
    // one principal who may define it, might have). An org_admin cannot clone it, because the clone
    // re-checks every copied capability against the caller org-wide.
    const approversId = await seedRole(world.northstar, 'Owner approvers', [
      'work.read',
      'approval.decide',
    ]);
    const before = await roleCount(world.northstar.organizationId);

    const error = await expectApiError(
      edit.clone(adminCtx, admin, approversId, { name: 'Cloned approvers' }),
      403,
    );
    expect(error.auditCode).toMatch(/^custom_roles\.escalation:/);
    // No copy landed.
    expect(await roleCount(world.northstar.organizationId)).toBe(before);
  });

  it('the owner may grant the reviewer-gated capability on create, edit and clone (ADM-08, A1), stored exactly as granted', async () => {
    // Peter's 2026-10-23 decision, built in A1 (3a6018bc): approval rights are the company owner's
    // to hand out. The owner's ceiling is every capability, so this widens nothing past the author.
    const createdView = await roles.create(ownerCtx, owner, {
      name: 'Owner approvers everywhere',
      capabilities: ['work.read', 'approval.decide'],
    });
    const createdId = roleIdByName(createdView, 'Owner approvers everywhere');
    expect((await roleSnapshot(createdId))?.capabilitiesJson).toBe(
      JSON.stringify(['work.read', 'approval.decide']),
    );

    const editableId = roleIdByName(
      await roles.create(ownerCtx, owner, { name: 'Owner editable', capabilities: ['work.read'] }),
      'Owner editable',
    );
    await edit.edit(ownerCtx, owner, editableId, {
      name: 'Owner editable',
      capabilities: ['work.read', 'approval.decide'],
    });
    expect((await roleSnapshot(editableId))?.capabilitiesJson).toBe(
      JSON.stringify(['work.read', 'approval.decide']),
    );

    // The twin owner may clone a role carrying it in their own tenant; the copy lands there.
    const twinRoleId = await seedTwinRole('Twin approvers', ['work.read', 'approval.decide']);
    const before = await roleCount(world.twin.organizationId);
    await edit.clone(twinOwnerCtx, twinOwner, twinRoleId, { name: 'Cloned approvers' });
    expect(await roleCount(world.twin.organizationId)).toBe(before + 1);
  });
});

describe('a custom role is tenant-local — the §11 adjacent-id twin', () => {
  let twinRoleId: string;

  beforeAll(async () => {
    // A role that lives only in the twin tenant. Its id is a valid custom-role id in the twin; it
    // must be invisible and unusable from Northstar Studio next door.
    twinRoleId = await seedTwinRole('Twin only role', ['work.read', 'work.create']);
  });

  it('the sibling tenant never lists the twin role', async () => {
    const view = await roles.list(ownerCtx, owner);
    expect(view.roles.map((r) => r.id)).not.toContain(twinRoleId);
    expect(view.roles.map((r) => r.name)).not.toContain('Twin only role');
  });

  it('a twin role id cannot be edited from the sibling tenant (404, not 403), and is left untouched', async () => {
    const before = await roleSnapshot(twinRoleId);
    const error = await expectApiError(
      edit.edit(ownerCtx, owner, twinRoleId, {
        name: 'Hijacked role',
        capabilities: ['work.read'],
      }),
      404,
    );
    // A cross-tenant id is indistinguishable from an unknown one — never a 403 that confirms it exists.
    expect(error.auditCode).toBeUndefined();
    expect(await roleSnapshot(twinRoleId)).toEqual(before);
  });

  it('a twin role id cannot be cloned from the sibling tenant (404), and no row is written there', async () => {
    const before = await roleCount(world.northstar.organizationId);
    await expectApiError(
      edit.clone(ownerCtx, owner, twinRoleId, { name: 'Clone of a stranger' }),
      404,
    );
    expect(await roleCount(world.northstar.organizationId)).toBe(before);
  });

  it("the twin owner's own tenant still resolves the role (the id is real, only cross-tenant use is barred)", async () => {
    const view = await roles.list(twinOwnerCtx, twinOwner);
    expect(view.roles.map((r) => r.id)).toContain(twinRoleId);
  });
});

describe('a non-admin member cannot reach the role write paths', () => {
  it('create is refused by the org.manage decision (403), with no row written', async () => {
    const before = await roleCount(world.northstar.organizationId);
    const error = await expectApiError(
      roles.create(memberCtx, member, {
        name: 'Member made this',
        capabilities: ['work.read'],
      }),
      403,
    );
    expect(error.auditCode).toMatch(/^custom_roles\.manage:/);
    expect(await roleCount(world.northstar.organizationId)).toBe(before);
  });

  it('editing an existing role is refused by the org.manage decision (403), leaving it unchanged', async () => {
    // A real role in the member's own tenant, created by the owner.
    const targetId = roleIdByName(
      await roles.create(ownerCtx, owner, {
        name: 'Owner made this',
        capabilities: ['work.read', 'work.create'],
      }),
      'Owner made this',
    );
    const before = await roleSnapshot(targetId);

    const error = await expectApiError(
      edit.edit(memberCtx, member, targetId, {
        name: 'Owner made this',
        capabilities: ['work.read'],
      }),
      403,
    );
    expect(error.auditCode).toMatch(/^custom_roles\.manage:/);
    expect(await roleSnapshot(targetId)).toEqual(before);
  });

  it('cloning an existing role is refused by the org.manage decision (403), with no copy written', async () => {
    const targetId = roleIdByName(
      await roles.create(ownerCtx, owner, {
        name: 'Owner made another',
        capabilities: ['work.read'],
      }),
      'Owner made another',
    );
    const before = await roleCount(world.northstar.organizationId);

    const error = await expectApiError(
      edit.clone(memberCtx, member, targetId, { name: 'Member clone attempt' }),
      403,
    );
    expect(error.auditCode).toMatch(/^custom_roles\.manage:/);
    expect(await roleCount(world.northstar.organizationId)).toBe(before);
  });
});
