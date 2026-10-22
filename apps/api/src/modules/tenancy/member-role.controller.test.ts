import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { builtInRoles, MemberRoleController } from './member-role.controller.js';
import type { MembershipsRepository } from './memberships.repository.js';
import type { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const context = { organizationId: ORG, membershipId: 'm0' } as unknown as TenantContext;

function principal(role: string): Principal {
  return {
    userId: 'u0',
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'm0',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

interface Row {
  id: string;
  userId: string;
  role: string;
  status: string;
  version: number;
}

function setup(rows: Row[]) {
  const audits: unknown[] = [];
  const memberships = {
    findByUserId: (_r: unknown, _c: unknown, userId: string) =>
      Promise.resolve(rows.find((row) => row.userId === userId) ?? null),
    countActiveHoldersOfRoles: (_r: unknown, _c: unknown, roles: string[], exclude?: string) =>
      Promise.resolve(
        rows.filter((r) => roles.includes(r.role) && r.status === 'active' && r.id !== exclude)
          .length,
      ),
    changeRole: (_r: unknown, _c: unknown, id: string, _v: number, role: string) => {
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, { role, version: row.version + 1 });
      return Promise.resolve({ ...row });
    },
  } as unknown as MembershipsRepository;
  const database = {
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const audit = {
    record: (_t: unknown, _c: unknown, e: unknown) => Promise.resolve(audits.push(e)),
  } as unknown as AuditService;
  return { controller: new MemberRoleController(database, memberships, audit), audits };
}

async function status(promise: Promise<unknown>): Promise<number> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(ApiError);
  return (error as ApiError).status;
}

const member = (over: Partial<Row> = {}): Row => ({
  id: 'm1',
  userId: 'u1',
  role: 'member',
  status: 'active',
  version: 1,
  ...over,
});

describe('MemberRoleController (ADM-01)', () => {
  it('lets an org admin make a member a Manager, with one audit row', async () => {
    const { controller, audits } = setup([member()]);
    const view = await controller.change(context, principal('org_admin'), 'u1', {
      role: 'manager',
    });
    expect(view).toMatchObject({ previousRole: 'member', role: 'manager', changed: true });
    expect(audits).toEqual([
      expect.objectContaining({ action: 'membership.role_changed', objectId: 'm1' }),
    ]);
  });

  it('refuses a caller who is neither owner nor org admin, and a non-owner touching an owner', async () => {
    const { controller } = setup([member(), member({ id: 'm2', userId: 'u2', role: 'owner' })]);
    expect(
      await status(controller.change(context, principal('manager'), 'u1', { role: 'guest' })),
    ).toBe(403);
    expect(
      await status(controller.change(context, principal('org_admin'), 'u2', { role: 'member' })),
    ).toBe(403);
    expect(
      await status(controller.change(context, principal('org_admin'), 'u1', { role: 'owner' })),
    ).toBe(403);
  });

  it('never demotes the last active owner, but does when another owner remains', async () => {
    const solo = setup([member({ role: 'owner' })]);
    expect(
      await status(solo.controller.change(context, principal('owner'), 'u1', { role: 'member' })),
    ).toBe(409);
    const pair = setup([
      member({ role: 'owner' }),
      member({ id: 'm2', userId: 'u2', role: 'owner' }),
    ]);
    const view = await pair.controller.change(context, principal('owner'), 'u1', {
      role: 'member',
    });
    expect(view.role).toBe('member');
  });

  it('400s an unknown role, 404s an unknown user, 409s a stale version', async () => {
    const { controller } = setup([member()]);
    expect(
      await status(controller.change(context, principal('owner'), 'u1', { role: 'boss' })),
    ).toBe(400);
    expect(
      await status(controller.change(context, principal('owner'), 'nope', { role: 'guest' })),
    ).toBe(404);
    expect(
      await status(
        controller.change(context, principal('owner'), 'u1', { role: 'guest', version: 7 }),
      ),
    ).toBe(409);
  });

  it('lists built-in roles with capabilities; only an owner may assign Owner', () => {
    const admin = builtInRoles(principal('org_admin'));
    expect(admin.find((r) => r.role === 'manager')).toMatchObject({
      assignable: true,
      projectRole: true,
    });
    expect(admin.find((r) => r.role === 'manager')?.capabilities).toContain('project.manage');
    expect(admin.find((r) => r.role === 'owner')?.assignable).toBe(false);
    expect(builtInRoles(principal('owner')).find((r) => r.role === 'owner')?.assignable).toBe(true);
  });
});
