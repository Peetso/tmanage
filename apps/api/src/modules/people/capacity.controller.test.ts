import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import { PersonCapacityController } from './capacity.controller.js';
import type { PersonCapacityRepository, SetCapacityInput } from './capacity.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MembershipRow, PersonCapacityRow } from '../../common/database/schema.js';

/**
 * People capacity (x170) controller proofs, database-free over fakes with the *real* `authorize`. The
 * migration, the upsert's SQL round-trip and the tenant guard are the chain's DB suite, not here; this
 * file proves the controller's own security logic: the Known-trap 404 for a cross-tenant member id with
 * no write, the [0,168] validation 400 with no write, the org-scoped authorize (project.manage to set,
 * work.read to read), and set→read returning the figure.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const MEMBER_ID = 'membership-0000-0000-0000-000000000009';
const FOREIGN_MEMBER_ID = 'membership-0000-0000-0000-0000000000ff';

function principal(role: Principal['role'], kind: Principal['kind'] = 'internal'): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind,
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? 'client-org-0000-0000-000000000001' : null,
    projectIds: [PROJECT],
    hasOrgWideScope: true,
  };
}

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/**
 * A controller over in-memory stores. `setCalls` records every upsert so a test can assert none
 * happened. The fakes are tenant-scoped like the real repositories: a member of another org resolves
 * to null through `findById`, which the controller turns into a 404 before any write.
 */
function controllerWith(members: readonly MembershipRow[]) {
  const store = new Map<string, PersonCapacityRow>();
  const setCalls: SetCapacityInput[] = [];

  const database = {
    read: async (_ctx: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_ctx: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const memberships = {
    findById: async (_runner: unknown, ctx: TenantContext, id: string) =>
      members.find((m) => m.id === id && m.organizationId === ctx.organizationId) ?? null,
  } as unknown as MembershipsRepository;

  const capacity = {
    findByMembership: async (_runner: unknown, ctx: TenantContext, membershipId: string) =>
      store.get(`${ctx.organizationId}:${membershipId}`) ?? null,
    set: async (_runner: unknown, ctx: TenantContext, input: SetCapacityInput) => {
      setCalls.push(input);
      const row: PersonCapacityRow = {
        id: 'person-capacity-0000-0000-000000000001',
        organizationId: ctx.organizationId,
        membershipId: input.membershipId,
        weeklyHours: input.weeklyHours,
        effectiveFrom: input.effectiveFrom,
        updatedAt: new Date('2026-09-26T10:00:00.000Z'),
      };
      store.set(`${ctx.organizationId}:${input.membershipId}`, row);
      return row;
    },
  } as unknown as PersonCapacityRepository;

  return {
    controller: new PersonCapacityController(database, capacity, memberships),
    setCalls,
  };
}

function member(id: string, organizationId: string): MembershipRow {
  return {
    id,
    organizationId,
    userId: 'user-0000-0000-0000-0000-0000000000aa',
    role: 'member',
    status: 'active',
    hasOrgWideScope: false,
    workspaceScopeId: null,
    version: 1,
    policyVersion: 1,
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    updatedAt: new Date('2026-09-26T10:00:00.000Z'),
  } as unknown as MembershipRow;
}

describe('PersonCapacityController', () => {
  it('sets a member capacity and reads it back', async () => {
    const { controller, setCalls } = controllerWith([member(MEMBER_ID, ORG)]);
    const actor = principal('owner');

    const set = await controller.set(context, actor, MEMBER_ID, {
      weeklyHours: 40,
      effectiveFrom: '2026-01-05',
    });
    expect(set.weeklyHours).toBe(40);
    expect(set.membershipId).toBe(MEMBER_ID);
    expect(set).not.toHaveProperty('organizationId');
    expect(setCalls).toHaveLength(1);

    const read = await controller.read(context, actor, MEMBER_ID);
    expect(read.capacity?.weeklyHours).toBe(40);
    expect(read.capacity?.effectiveFrom).toBe('2026-01-05');
  });

  it('reads null for a member with no capacity set yet', async () => {
    const { controller } = controllerWith([member(MEMBER_ID, ORG)]);
    const read = await controller.read(context, principal('owner'), MEMBER_ID);
    expect(read.capacity).toBeNull();
  });

  it('rejects weekly hours out of [0,168] with 400 and writes nothing', async () => {
    const { controller, setCalls } = controllerWith([member(MEMBER_ID, ORG)]);
    await expect(
      controller.set(context, principal('owner'), MEMBER_ID, {
        weeklyHours: 200,
        effectiveFrom: '2026-01-05',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(setCalls).toEqual([]);
  });

  it('returns 404 for a cross-tenant member id and writes nothing', async () => {
    const { controller, setCalls } = controllerWith([member(FOREIGN_MEMBER_ID, OTHER_ORG)]);
    await expect(
      controller.set(context, principal('owner'), FOREIGN_MEMBER_ID, {
        weeklyHours: 40,
        effectiveFrom: '2026-01-05',
      }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      controller.set(context, principal('owner'), FOREIGN_MEMBER_ID, {
        weeklyHours: 40,
        effectiveFrom: '2026-01-05',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(setCalls).toEqual([]);
  });

  it('refuses to set capacity without project.manage (403) and writes nothing', async () => {
    const { controller, setCalls } = controllerWith([member(MEMBER_ID, ORG)]);
    // `member` holds work.read but not project.manage (capabilities ceiling), so the org-scoped
    // authorize denies the write with a 403.
    await expect(
      controller.set(context, principal('member'), MEMBER_ID, {
        weeklyHours: 40,
        effectiveFrom: '2026-01-05',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(setCalls).toEqual([]);
  });

  it('refuses to read capacity without work.read (403)', async () => {
    const { controller } = controllerWith([member(MEMBER_ID, ORG)]);
    // A client principal holds no `work.read` (it is internal-only), so the org-scoped authorize
    // denies the read with a 403.
    await expect(
      controller.read(context, principal('client_member', 'client'), MEMBER_ID),
    ).rejects.toMatchObject({ status: 403 });
  });
});
