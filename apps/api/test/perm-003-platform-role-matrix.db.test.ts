import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RowDataPacket } from 'mysql2/promise';
import { PLATFORM_PERMISSIONS, uuidv7 } from '@tmanage/domain';
import { TenantDatabase } from '../src/common/database/tenant-context.js';
import { ApiError } from '../src/common/http/errors.js';
import { AuditEventsRepository } from '../src/modules/audit/audit-events.repository.js';
import { AuditService } from '../src/modules/audit/audit.service.js';
import type { PlatformAdminActor } from '../src/modules/platform-admin/platform-admin.guard.js';
import { PlatformAuditService } from '../src/modules/platform-admin/platform-audit.service.js';
import { PlatformPermissionsService } from '../src/modules/platform-admin/permissions/permissions.service.js';
import { startTestDatabase, truncateAll } from './support/test-database.js';
import type { TestDatabase } from './support/test-database.js';
import { seedTwoTenants } from './seed-two-tenants.js';
import type { SeedWorld } from './seed-two-tenants.js';

/**
 * platform-admin v2 · PA-04 — the platform-side permission editors (SPEC §5.2, D7/D8) against a
 * real MariaDB, through the app credential (`db.runtime`), so the grants are proved too.
 *
 * 1. The role list carries the built-in roles and Northstar's custom roles with holders, and
 *    never another tenant's.
 * 2. Create → edit → clone → delete (holders reassigned, role retired, no DELETE needed), each
 *    with an org `audit_events` row (actor null, effective actor = the platform admin, changes)
 *    and a `platform_admin_audit_events` row carrying the organization.
 * 3. Overrides from the platform: a deny lands, the preview reports `override_deny`, removing it
 *    revokes the row; an owner is refused (400); a membership of another tenant is a 404.
 */

let db: TestDatabase;
let world: SeedWorld;
let service: PlatformPermissionsService;
let actor: PlatformAdminActor;

const request = () => ({ correlationId: uuidv7(), ip: '203.0.113.40', userAgent: 'Firefox/131' });

async function observe(sql: string, params: readonly unknown[] = []): Promise<RowDataPacket[]> {
  const [rows] = await db.admin.query<RowDataPacket[]>(sql, params as unknown[]);
  return rows;
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  db = await startTestDatabase();
  await truncateAll(db.admin);
  world = await seedTwoTenants(db.admin);
  const tenant = new TenantDatabase(db.runtime, { guardMode: 'enforce' });
  service = new PlatformPermissionsService(
    tenant,
    new PlatformAuditService(tenant),
    new AuditService(tenant, new AuditEventsRepository()),
  );
  actor = {
    account: {
      userId: world.platformAdmin.id,
      email: world.platformAdmin.email,
      displayName: world.platformAdmin.displayName,
      emailVerified: true,
      mfaEnabled: true,
    },
    sessionId: uuidv7(),
    stepUp: null,
    source: 'env',
    preset: 'super_admin',
    permissions: [...PLATFORM_PERMISSIONS],
  };
}, 300_000);

afterAll(async () => {
  await db?.stop();
});

describe('custom roles from the platform', () => {
  let roleId = '';
  let cloneId = '';

  it('creates a role with both audit rows', async () => {
    const ctx = request();
    const view = await service.createRole(
      actor,
      world.northstar.organizationId,
      {
        name: 'Delivery lead',
        capabilities: ['work.read', 'work.update'],
        reason: 'Asked by Maya',
      },
      ctx,
    );
    roleId = view.role.id;
    expect(view.role).toMatchObject({ name: 'Delivery lead', builtIn: false, holders: 0 });

    const [org] = await observe(
      `select action, actor_user_id, effective_actor_id from audit_events
        where organization_id = ? and object_id = ?`,
      [world.northstar.organizationId, roleId],
    );
    expect(org).toMatchObject({
      action: 'custom_role.created',
      actor_user_id: null,
      effective_actor_id: world.platformAdmin.id,
    });
    const [platform] = await observe(
      `select action, organization_id, reason from platform_admin_audit_events
        where correlation_id = ?`,
      [ctx.correlationId],
    );
    expect(platform).toMatchObject({
      action: 'platform.org_role_created',
      organization_id: world.northstar.organizationId,
      reason: 'Asked by Maya',
    });
  });

  it('refuses a duplicate name with 409', async () => {
    const error = await refusal(
      service.createRole(
        actor,
        world.northstar.organizationId,
        { name: 'Delivery lead', capabilities: ['work.read'] },
        request(),
      ),
    );
    expect(error.status).toBe(409);
  });

  it('edits the capabilities and records one change row per capability', async () => {
    const view = await service.updateRole(
      actor,
      world.northstar.organizationId,
      roleId,
      { capabilities: ['work.read', 'work.update', 'work.delete'] },
      request(),
    );
    expect(view.role.capabilities).toContain('work.delete');
    const changes = await observe(
      `select c.field, c.before_value, c.after_value
         from audit_event_changes c
         join audit_events e on e.organization_id = c.organization_id and e.id = c.audit_event_id
        where e.organization_id = ? and e.object_id = ? and e.action = 'custom_role.updated'`,
      [world.northstar.organizationId, roleId],
    );
    expect(changes.map((row) => row['field'])).toEqual(['capability.work.delete']);
  });

  it("lists Northstar's roles with holders, and never another tenant's", async () => {
    const view = await service.listRoles(world.northstar.organizationId, request());
    expect(view.slug).toBe('northstar-studio');
    expect(view.roles.find((role) => role.id === 'owner')?.holders).toBeGreaterThanOrEqual(1);
    expect(view.roles.find((role) => role.id === roleId)?.name).toBe('Delivery lead');
    const twin = await service.listRoles(world.twin.organizationId, request());
    expect(twin.roles.some((role) => role.id === roleId)).toBe(false);
  });

  it('an id from another tenant is a 404', async () => {
    const error = await refusal(
      service.updateRole(actor, world.twin.organizationId, roleId, { name: 'Taken' }, request()),
    );
    expect(error.status).toBe(404);
  });

  it('clones the role', async () => {
    const view = await service.cloneRole(
      actor,
      world.northstar.organizationId,
      roleId,
      { name: 'Delivery lead (copy)' },
      request(),
    );
    cloneId = view.role.id;
    expect(view.role.capabilities).toEqual(['work.read', 'work.update', 'work.delete']);
  });

  it('deletes a held role: holders move first, the role is retired, nothing is deleted', async () => {
    // Give the designer the clone, as the org side would.
    await db.admin.query(`update memberships set role = ? where organization_id = ? and id = ?`, [
      cloneId,
      world.northstar.organizationId,
      world.northstar.designer.membershipId,
    ]);
    expect(
      (
        await refusal(
          service.deleteRole(actor, world.northstar.organizationId, cloneId, {}, request()),
        )
      ).status,
    ).toBe(400);
    const view = await service.deleteRole(
      actor,
      world.northstar.organizationId,
      cloneId,
      { reassignTo: 'member' },
      request(),
    );
    expect(view).toEqual({ deletedRoleId: cloneId, reassignedTo: 'member', reassigned: 1 });
    const [membership] = await observe(`select role from memberships where id = ?`, [
      world.northstar.designer.membershipId,
    ]);
    expect(membership?.['role']).toBe('member');
    const [role] = await observe(`select name, capabilities_json from custom_roles where id = ?`, [
      cloneId,
    ]);
    expect(role?.['capabilities_json']).toBe('[]');
    const list = await service.listRoles(world.northstar.organizationId, request());
    expect(list.roles.some((entry) => entry.id === cloneId)).toBe(false);
    // The name is free again.
    await service.createRole(
      actor,
      world.northstar.organizationId,
      { name: 'Delivery lead (copy)', capabilities: ['work.read'] },
      request(),
    );
  });
});

describe('member overrides from the platform', () => {
  it('a deny lands and the preview names it', async () => {
    const target = world.northstar.designer.membershipId;
    const view = await service.replaceOverrides(
      actor,
      world.northstar.organizationId,
      target,
      { overrides: [{ capability: 'conversation.write', effect: 'deny' }], reason: 'Handover' },
      request(),
    );
    expect(view.overrides.map((row) => `${row.effect}:${row.capability}`)).toEqual([
      'deny:conversation.write',
    ]);
    expect(view.overrides[0]?.createdByName).toBe(world.platformAdmin.displayName);
    const effective = await service.effectivePermissions(
      world.northstar.organizationId,
      target,
      world.northstar.projectId,
      request(),
    );
    expect(
      effective.permissions.find((entry) => entry.capability === 'conversation.write'),
    ).toMatchObject({ final: false, source: 'override_deny' });
    const [audit] = await observe(
      `select effective_actor_id from audit_events
        where organization_id = ? and object_id = ? and action = 'membership.permission_overrides_changed'`,
      [world.northstar.organizationId, target],
    );
    expect(audit?.['effective_actor_id']).toBe(world.platformAdmin.id);
  });

  it('removing it revokes the row', async () => {
    const target = world.northstar.designer.membershipId;
    const view = await service.replaceOverrides(
      actor,
      world.northstar.organizationId,
      target,
      { overrides: [] },
      request(),
    );
    expect(view.overrides).toEqual([]);
    const rows = await observe(
      `select revoked_at, revoked_by from membership_permission_overrides where membership_id = ?`,
      [target],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['revoked_by']).toBe(world.platformAdmin.id);
  });

  it('refuses an owner (400) and a membership of another tenant (404)', async () => {
    const owner = await refusal(
      service.replaceOverrides(
        actor,
        world.northstar.organizationId,
        world.northstar.owner.membershipId,
        { overrides: [{ capability: 'work.delete', effect: 'deny' }] },
        request(),
      ),
    );
    expect(owner.status).toBe(400);
    const foreign = await refusal(
      service.memberPermissions(
        world.twin.organizationId,
        world.northstar.designer.membershipId,
        undefined,
        request(),
      ),
    );
    expect(foreign.status).toBe(404);
  });

  it('shows a client contact without internal-only cells', async () => {
    const view = await service.memberPermissions(
      world.northstar.organizationId,
      world.atlas.reviewer.membershipId,
      undefined,
      request(),
    );
    expect(view.kind).toBe('client');
    expect(view.editable).toBe(false);
    expect(view.effective.permissions.some((entry) => entry.capability === 'work.delete')).toBe(
      false,
    );
  });
});
