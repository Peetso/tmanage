import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { customRoleKey } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { RoleEditController } from './role-edit.controller.js';
import type { RoleEditRepository } from './role-edit.repository.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { CustomRoleRow } from '../../common/database/schema.js';

/**
 * Wave 10 R5 — F30 (partial): editing or cloning a custom role re-roles every holder of it, so it is
 * an "Assign roles" act (`12-PERMISSION-MATRIX` §2: owner and org_admin). A delegated custom role
 * holding `org.manage` + `work.read` used to pass every check on PATCH/clone (it holds `work.read`),
 * so it could strip every holder of the role down to `work.read`. Now it is a 403 before any read or
 * write; an org_admin still gets a 200.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-0000000000c1';
const MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const DELEGATE_ROLE = '0b6d2c1e-6a4f-4c39-9a51-1f2d3e4c5b6a';
const ROLE_ID = '9f1d2c3b-4a5e-4f60-8b71-2c3d4e5f6a7b';

function principal(role: string): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  } as Principal;
}

const delegate = (): Principal =>
  principal(customRoleKey(DELEGATE_ROLE, ['org.manage', 'work.read']));
const orgAdmin = (): Principal => principal('org_admin');

const context = { organizationId: ORG, membershipId: MEMBERSHIP } as unknown as TenantContext;

const ORIGINAL = JSON.stringify(['work.read', 'work.create', 'work.update']);

class FakeRepo {
  reads = 0;
  writes = 0;
  readonly rows: CustomRoleRow[] = [
    {
      id: ROLE_ID,
      organizationId: ORG,
      name: 'Coordinator',
      capabilitiesJson: ORIGINAL,
      createdBy: USER,
      createdAt: new Date('2026-09-27T00:00:00.000Z'),
    },
  ];

  findById(_r: unknown, _c: unknown, id: string): Promise<CustomRoleRow | undefined> {
    this.reads += 1;
    return Promise.resolve(this.rows.find((row) => row.id === id));
  }

  findByName(_r: unknown, _c: unknown, name: string): Promise<CustomRoleRow | undefined> {
    this.reads += 1;
    return Promise.resolve(this.rows.find((row) => row.name === name));
  }

  insert(
    _r: unknown,
    _c: unknown,
    input: { name: string; capabilities: readonly string[]; createdBy: string },
  ): Promise<CustomRoleRow> {
    this.writes += 1;
    const created: CustomRoleRow = {
      ...this.rows[0]!,
      id: 'copy-1',
      name: input.name,
      capabilitiesJson: JSON.stringify(input.capabilities),
    };
    this.rows.push(created);
    return Promise.resolve(created);
  }

  update(
    _r: unknown,
    _c: unknown,
    input: { id: string; name: string; capabilities: readonly string[] },
  ): Promise<CustomRoleRow> {
    this.writes += 1;
    const row = this.rows.find((r) => r.id === input.id)!;
    row.name = input.name;
    row.capabilitiesJson = JSON.stringify(input.capabilities);
    return Promise.resolve(row);
  }
}

function controllerWith(repo: FakeRepo): RoleEditController {
  const database = {
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  return new RoleEditController(database, repo as unknown as RoleEditRepository);
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return error instanceof ApiError ? error.status : undefined;
}

describe('wave 10 R5 — F30: custom role edit/clone need an owner or org_admin', () => {
  it('403s a delegated org.manage custom role editing a role to [work.read]; the row is unchanged', async () => {
    const repo = new FakeRepo();
    const status = await statusOf(
      controllerWith(repo).edit(context, delegate(), ROLE_ID, {
        name: 'Coordinator',
        capabilities: ['work.read'],
      }),
    );
    expect(status).toBe(403);
    expect(repo.reads).toBe(0);
    expect(repo.writes).toBe(0);
    expect(repo.rows[0]!.capabilitiesJson).toBe(ORIGINAL);
  });

  it('403s the same delegate cloning the role, with no read and no write', async () => {
    const repo = new FakeRepo();
    const status = await statusOf(
      controllerWith(repo).clone(context, delegate(), ROLE_ID, { name: 'Coordinator copy' }),
    );
    expect(status).toBe(403);
    expect(repo.reads).toBe(0);
    expect(repo.writes).toBe(0);
    expect(repo.rows).toHaveLength(1);
  });

  it('still lets an org_admin edit the role to [work.read] (200)', async () => {
    const repo = new FakeRepo();
    const result = await controllerWith(repo).edit(context, orgAdmin(), ROLE_ID, {
      name: 'Coordinator',
      capabilities: ['work.read'],
    });
    expect(result.role.capabilities).toEqual(['work.read']);
    expect(repo.writes).toBe(1);
  });

  it('still lets an org_admin clone the role (200)', async () => {
    const repo = new FakeRepo();
    const result = await controllerWith(repo).clone(context, orgAdmin(), ROLE_ID, {
      name: 'Coordinator copy',
    });
    expect(result.role.name).toBe('Coordinator copy');
    expect(repo.writes).toBe(1);
  });
});
