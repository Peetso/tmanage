import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { MATRIX, capabilitiesFor } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { CustomRoleRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { RolesMatrixController } from './roles-matrix.controller.js';
import type { CustomRolesRepository } from './roles.repository.js';

/** platform-admin v2 · PA-01 — `GET …/admin/roles/matrix` (SPEC §3.3). */

const ORG = '0199ee00-0000-7000-8000-0000000000c1';
const context = { organizationId: ORG } as unknown as TenantContext;

function principal(role: string): Principal {
  return {
    userId: '0199ee00-0000-7000-8000-0000000000a1',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: '0199ee00-0000-7000-8000-0000000000b1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

const ROW: CustomRoleRow = {
  id: '0199ee00-0000-7000-8000-0000000000f1',
  organizationId: ORG,
  name: 'Coordinator',
  capabilitiesJson: JSON.stringify(['work.read', 'report.view', 'gone.capability']),
  createdBy: '0199ee00-0000-7000-8000-0000000000a1',
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
};

function controller(): { controller: RolesMatrixController; reads: () => number } {
  let reads = 0;
  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repo = {
    listAll: () => {
      reads += 1;
      return Promise.resolve([ROW]);
    },
  } as unknown as CustomRolesRepository;
  return { controller: new RolesMatrixController(database, repo), reads: () => reads };
}

describe('RolesMatrixController', () => {
  it('declares org.manage', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, RolesMatrixController.prototype.read)).toBe(
      'org.manage',
    );
  });

  it('returns the layout, every assignable built-in role and the custom roles', async () => {
    const { controller: c } = controller();
    const view = await c.read(context, principal('org_admin'));
    expect(view.matrix).toBe(MATRIX);
    expect(view.areas).toHaveLength(18);
    const ids = view.roles.map((role) => role.id);
    expect(ids).toContain('owner');
    expect(ids).toContain('client_reviewer');
    expect(ids).not.toContain('platform_support');
    expect(view.roles.find((r) => r.id === 'member')?.capabilities).toEqual(
      capabilitiesFor('member'),
    );
    expect(view.roles.find((r) => r.id === ROW.id)).toEqual({
      id: ROW.id,
      name: 'Coordinator',
      kind: 'internal',
      builtIn: false,
      capabilities: ['work.read', 'report.view'],
    });
  });

  it('is a 403 without org.manage, before any read', async () => {
    const { controller: c, reads } = controller();
    const error = await c.read(context, principal('manager')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    expect(reads()).toBe(0);
  });
});
