import { describe, expect, it } from 'vitest';
import { capabilitiesFor } from '@tmanage/domain';
import { ApiError } from '../../../common/http/errors.js';
import { PLATFORM_PERMISSION_METADATA } from '../require-platform-permission.decorator.js';
import { PlatformOrgRolesController } from './org-roles.controller.js';
import { capabilityChanges } from './permissions.service.js';
import { ORG, OTHER_ROLE, ROLE, actor, harness, request, roleRow } from './test-fakes.js';

/** PA-04 · D7 platform role routes: permissions, 409, reassign-before-delete, clone. */

function permissionOf(method: keyof PlatformOrgRolesController): unknown {
  return Reflect.getMetadata(
    PLATFORM_PERMISSION_METADATA,
    PlatformOrgRolesController.prototype[method],
  );
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

describe('PlatformOrgRolesController permissions', () => {
  it('reads with platform.orgs.view and writes with platform.permissions.edit', () => {
    expect(permissionOf('list')).toBe('platform.orgs.view');
    for (const method of ['create', 'update', 'clone', 'remove'] as const) {
      expect(permissionOf(method)).toBe('platform.permissions.edit');
    }
  });
});

describe('platform role list', () => {
  it('lists built-in and custom roles with holders', async () => {
    const h = harness({ roles: [roleRow(ROLE, 'Delivery lead', ['work.read', 'work.delete'])] });
    const view = await h.service.listRoles(ORG, request);
    expect(view.slug).toBe('nile');
    const custom = view.roles.find((role) => role.id === ROLE);
    expect(custom).toMatchObject({ builtIn: false, holders: 6, name: 'Delivery lead' });
    expect(view.roles.find((role) => role.id === 'owner')?.builtIn).toBe(true);
    expect(view.roles.some((role) => role.id === 'platform_support')).toBe(false);
  });

  it('answers 404 for an organization id that is not a uuid', async () => {
    const h = harness({});
    expect((await refusal(h.service.listRoles('nope', request))).status).toBe(404);
  });
});

describe('create / update', () => {
  it('refuses a duplicate name with 409 and writes nothing', async () => {
    const h = harness({ roles: [roleRow(ROLE, 'Delivery lead', ['work.read'])] });
    const error = await refusal(
      h.service.createRole(
        actor,
        ORG,
        { name: 'Delivery lead', capabilities: ['work.read'] },
        request,
      ),
    );
    expect(error.status).toBe(409);
    expect(h.roleRepo.insert).not.toHaveBeenCalled();
    expect(h.platformAudit.insert).not.toHaveBeenCalled();
  });

  it('refuses an unknown capability with 400', async () => {
    const h = harness({});
    const error = await refusal(
      h.service.createRole(actor, ORG, { name: 'X', capabilities: ['work.fly'] }, request),
    );
    expect(error.status).toBe(400);
  });

  it('a rename to another role name is a 409; to its own name is fine', async () => {
    const h = harness({
      roles: [
        roleRow(ROLE, 'Delivery lead', ['work.read']),
        roleRow(OTHER_ROLE, 'Designer', ['work.read']),
      ],
    });
    expect(
      (await refusal(h.service.updateRole(actor, ORG, ROLE, { name: 'Designer' }, request))).status,
    ).toBe(409);
    const view = await h.service.updateRole(
      actor,
      ORG,
      ROLE,
      { name: 'Delivery lead', capabilities: ['work.read', 'work.delete'] },
      request,
    );
    expect(view.role.capabilities).toEqual(['work.read', 'work.delete']);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: 'custom_role.updated',
        actorUserId: null,
        effectiveActorId: actor.account.userId,
        changes: [{ field: 'capability.work.delete', before: false, after: true }],
      }),
    );
    expect(h.platformAudit.build).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.org_role_updated', organizationId: ORG }),
    );
  });

  it('a built-in role cannot be edited (404)', async () => {
    const h = harness({});
    expect(
      (await refusal(h.service.updateRole(actor, ORG, 'manager', { name: 'Boss' }, request)))
        .status,
    ).toBe(404);
  });
});

describe('delete', () => {
  it('needs reassignTo before anything is read', async () => {
    const h = harness({ roles: [roleRow(ROLE, 'Delivery lead', ['work.read'])] });
    const error = await refusal(h.service.deleteRole(actor, ORG, ROLE, {}, request));
    expect(error.status).toBe(400);
    expect(error.details?.[0]?.field).toBe('reassignTo');
    expect(h.database.transaction).not.toHaveBeenCalled();
  });

  it('refuses owner as the replacement', async () => {
    const h = harness({ roles: [roleRow(ROLE, 'Delivery lead', ['work.read'])] });
    expect(
      (await refusal(h.service.deleteRole(actor, ORG, ROLE, { reassignTo: 'owner' }, request)))
        .status,
    ).toBe(400);
  });

  it('moves every holder, then retires the role', async () => {
    const holders = [
      {
        id: '0199aa00-0000-7000-8000-0000000000f1',
        userId: '0199aa00-0000-7000-8000-0000000000f2',
        version: 3,
      },
    ];
    const h = harness({ roles: [roleRow(ROLE, 'Delivery lead', ['work.read'])], holders });
    const view = await h.service.deleteRole(actor, ORG, ROLE, { reassignTo: 'member' }, request);
    expect(view).toEqual({ deletedRoleId: ROLE, reassignedTo: 'member', reassigned: 1 });
    expect(h.memberships.changeRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      holders[0]?.id,
      3,
      'member',
    );
    expect(h.repository.retireRole).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ROLE,
    );
    const actions = h.audit.record.mock.calls.map((call) => (call[2] as { action: string }).action);
    expect(actions).toEqual(['membership.role_changed', 'custom_role.deleted']);
  });
});

describe('clone', () => {
  it('copies a custom role under a new name', async () => {
    const h = harness({ roles: [roleRow(ROLE, 'Delivery lead', ['work.read', 'doc.export'])] });
    const view = await h.service.cloneRole(actor, ORG, ROLE, { name: 'Delivery lead 2' }, request);
    expect(view.role.name).toBe('Delivery lead 2');
    expect(view.role.capabilities).toEqual(['work.read', 'doc.export']);
    expect(h.platformAudit.build).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'platform.org_role_cloned' }),
    );
  });

  it('copies a built-in role from its ceiling', async () => {
    const h = harness({});
    const view = await h.service.cloneRole(actor, ORG, 'manager', { name: 'Lead' }, request);
    expect([...view.role.capabilities].sort()).toEqual([...capabilitiesFor('manager')].sort());
  });

  it('needs a name', async () => {
    const h = harness({ roles: [roleRow(ROLE, 'Delivery lead', ['work.read'])] });
    expect((await refusal(h.service.cloneRole(actor, ORG, ROLE, {}, request))).status).toBe(400);
  });
});

describe('capabilityChanges', () => {
  it('lists only the capabilities that moved', () => {
    expect(capabilityChanges(['work.read', 'billing.view'], ['work.read', 'work.delete'])).toEqual([
      { field: 'capability.work.delete', before: false, after: true },
      { field: 'capability.billing.view', before: true, after: false },
    ]);
  });
});
