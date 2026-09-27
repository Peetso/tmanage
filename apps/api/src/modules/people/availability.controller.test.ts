import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  MemberAvailabilityController,
  PersonAvailabilityController,
} from './availability.controller.js';
import type {
  CreateAvailabilityInput,
  MemberAvailabilityRepository,
} from './availability.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { MemberAvailabilityRow, MembershipRow } from '../../common/database/schema.js';

/**
 * Member availability (x218) controller proofs, database-free over fakes with the *real* `authorize`.
 * The migration, the insert/delete SQL round-trips and the tenant guard are the chain's DB suite, not
 * here; this file proves the controller's own security logic: the owner-scoped add/list/delete (the
 * subject is `principal.membershipId`, never a body value), the fixed-kind and start≤end 400s with no
 * write, the team-view cross-tenant 404 with no read, the org-scoped `work.read` deny-by-default 403,
 * and that every route sits behind `work.read`.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const MY_MEMBERSHIP = '00000000-0000-4000-8000-0000000000e1';
const OTHER_MEMBER = '00000000-0000-4000-8000-0000000000e2';
const FOREIGN_MEMBER = '00000000-0000-4000-8000-0000000000ff';

const context = { organizationId: ORG, membershipId: MY_MEMBERSHIP } as unknown as TenantContext;

function principal(
  role: Principal['role'],
  kind: Principal['kind'] = 'internal',
  membershipId = MY_MEMBERSHIP,
): Principal {
  return {
    userId: '00000000-0000-4000-8000-0000000000c1',
    organizationId: ORG,
    kind,
    role,
    membershipId,
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? '00000000-0000-4000-8000-0000000000d1' : null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

function member(id: string, organizationId: string): MembershipRow {
  return {
    id,
    organizationId,
    userId: '00000000-0000-4000-8000-0000000000aa',
    role: 'member',
    status: 'active',
  } as unknown as MembershipRow;
}

/** An in-memory availability store, tenant- and member-scoped like the real repository. */
function makeStore() {
  const rows: MemberAvailabilityRow[] = [];
  const createCalls: CreateAvailabilityInput[] = [];

  const availability = {
    listForMember: async (_r: unknown, ctx: TenantContext, memberId: string) =>
      rows.filter((row) => row.organizationId === ctx.organizationId && row.memberId === memberId),
    create: async (_r: unknown, ctx: TenantContext, input: CreateAvailabilityInput) => {
      createCalls.push(input);
      const row: MemberAvailabilityRow = {
        id: `availability-${rows.length + 1}`,
        organizationId: ctx.organizationId,
        memberId: input.memberId,
        startDate: input.startDate,
        endDate: input.endDate,
        kind: input.kind,
        note: input.note,
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
      } as unknown as MemberAvailabilityRow;
      rows.push(row);
      return row;
    },
    deleteOwn: async (_r: unknown, ctx: TenantContext, memberId: string, id: string) => {
      const index = rows.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId && row.memberId === memberId && row.id === id,
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
  } as unknown as MemberAvailabilityRepository;

  return { rows, createCalls, availability };
}

function database(): TenantDatabase {
  return {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
}

function membershipsWith(members: readonly MembershipRow[]): MembershipsRepository {
  return {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      members.find((m) => m.id === id && m.organizationId === ctx.organizationId) ?? null,
  } as unknown as MembershipsRepository;
}

const VALID = { startDate: '2026-10-01', endDate: '2026-10-05', kind: 'vacation', note: 'Away' };

describe('PersonAvailabilityController (x218) — the caller manages their own windows', () => {
  it('adds a window against the caller membership, lists it, then removes it', async () => {
    const { createCalls, availability } = makeStore();
    const controller = new PersonAvailabilityController(database(), availability);
    const actor = principal('member');

    const created = await controller.create(context, actor, VALID);
    expect(created.membershipId).toBe(MY_MEMBERSHIP);
    expect(created).not.toHaveProperty('organizationId');
    expect(createCalls[0]?.memberId).toBe(MY_MEMBERSHIP);

    const listed = await controller.list(context, actor);
    expect(listed.windows).toHaveLength(1);
    expect(listed.windows[0]?.kind).toBe('vacation');

    await controller.remove(context, actor, created.id);
    expect((await controller.list(context, actor)).windows).toHaveLength(0);
  });

  it('rejects an unknown kind with 400 and writes nothing', async () => {
    const { createCalls, availability } = makeStore();
    const controller = new PersonAvailabilityController(database(), availability);
    await expect(
      controller.create(context, principal('member'), { ...VALID, kind: 'nope' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createCalls).toEqual([]);
  });

  it('rejects endDate before startDate with 400 and writes nothing', async () => {
    const { createCalls, availability } = makeStore();
    const controller = new PersonAvailabilityController(database(), availability);
    await expect(
      controller.create(context, principal('member'), {
        ...VALID,
        startDate: '2026-10-05',
        endDate: '2026-10-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createCalls).toEqual([]);
  });

  it('404s a delete of an id that is not the caller-own window and writes nothing', async () => {
    const { rows, availability } = makeStore();
    rows.push({
      id: 'availability-foreign',
      organizationId: ORG,
      memberId: OTHER_MEMBER,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      kind: 'vacation',
      note: null,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
    } as unknown as MemberAvailabilityRow);
    const controller = new PersonAvailabilityController(database(), availability);
    await expect(
      controller.remove(context, principal('member'), 'availability-foreign'),
    ).rejects.toMatchObject({ status: 404 });
    expect(rows).toHaveLength(1);
  });

  it('refuses add without work.read (403) and writes nothing', async () => {
    const { createCalls, availability } = makeStore();
    const controller = new PersonAvailabilityController(database(), availability);
    // A client principal holds no `work.read` (it is internal-only), so the org-scoped authorize 403s.
    await expect(
      controller.create(context, principal('client_member', 'client'), VALID),
    ).rejects.toMatchObject({ status: 403 });
    expect(createCalls).toEqual([]);
  });

  it('guards every route with work.read', () => {
    for (const method of ['list', 'create', 'remove'] as const) {
      expect(
        Reflect.getMetadata(REQUIRED_CAPABILITY, PersonAvailabilityController.prototype[method]),
      ).toBe('work.read');
    }
  });
});

describe('MemberAvailabilityController (x218) — the team reads a member window', () => {
  it('reads a resolvable member windows within the tenant', async () => {
    const { rows, availability } = makeStore();
    rows.push({
      id: 'availability-1',
      organizationId: ORG,
      memberId: OTHER_MEMBER,
      startDate: '2026-10-01',
      endDate: '2026-10-02',
      kind: 'sick',
      note: null,
      createdAt: new Date('2026-09-27T10:00:00.000Z'),
    } as unknown as MemberAvailabilityRow);
    const controller = new MemberAvailabilityController(
      database(),
      availability,
      membershipsWith([member(OTHER_MEMBER, ORG)]),
    );
    const listed = await controller.list(context, principal('member'), OTHER_MEMBER);
    expect(listed.windows).toHaveLength(1);
    expect(listed.windows[0]).not.toHaveProperty('organizationId');
  });

  it('404s a cross-tenant member id with no read', async () => {
    const { availability } = makeStore();
    const controller = new MemberAvailabilityController(
      database(),
      availability,
      membershipsWith([member(FOREIGN_MEMBER, OTHER_ORG)]),
    );
    await expect(
      controller.list(context, principal('member'), FOREIGN_MEMBER),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses the read without work.read (403)', async () => {
    const { availability } = makeStore();
    const controller = new MemberAvailabilityController(
      database(),
      availability,
      membershipsWith([member(OTHER_MEMBER, ORG)]),
    );
    await expect(
      controller.list(context, principal('client_member', 'client'), OTHER_MEMBER),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('guards the route with work.read', () => {
    expect(
      Reflect.getMetadata(REQUIRED_CAPABILITY, MemberAvailabilityController.prototype.list),
    ).toBe('work.read');
  });
});
