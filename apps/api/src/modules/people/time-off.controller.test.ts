import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PersonTimeOffController } from './time-off.controller.js';
import { PersonTimeOffService } from './time-off.service.js';
import type {
  CreatePersonTimeOffInput,
  PersonTimeOffRepository,
  TimeOffRange,
} from './time-off.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonTimeOffRow } from '../../common/database/schema.js';

/**
 * Person time-off (x325) controller/service proofs, database-free over fakes with the *real*
 * `authorize`. The migration, the insert/delete SQL round-trips and the tenant guard are the chain's
 * DB suite, not here; this file proves the slice's own security logic: **resolve the target person by
 * (tenant, userId) BEFORE authorize** (a cross-tenant/unknown id is a 404 even for an owner, with no
 * write), the `org.manage` write / `work.read` read deny-by-default 403s, the fixed-kind and
 * starts≤ends 400s with no write, the idempotent DELETE, the range-overlap read, and that every route
 * sits behind the right capability.
 */

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const ACTING = '00000000-0000-4000-8000-0000000000c1';
const PERSON = '00000000-0000-4000-8000-0000000000b1';
const FOREIGN_PERSON = '00000000-0000-4000-8000-0000000000bf';

const context = { organizationId: ORG, membershipId: ACTING } as unknown as TenantContext;

function principal(role: Principal['role'], kind: Principal['kind'] = 'internal'): Principal {
  return {
    userId: ACTING,
    organizationId: ORG,
    kind,
    role,
    membershipId: '00000000-0000-4000-8000-0000000000e1',
    membershipStatus: 'active',
    clientOrganizationId: kind === 'client' ? '00000000-0000-4000-8000-0000000000d1' : null,
    projectIds: [],
    hasOrgWideScope: false,
  };
}

/**
 * An in-memory time-off store, tenant- and person-scoped like the real repository. `members` maps a
 * tenant to the user ids that resolve to a membership there, so a cross-tenant user id is unresolved.
 */
function makeStore(members: Readonly<Record<string, readonly string[]>>) {
  const rows: PersonTimeOffRow[] = [];
  const createCalls: CreatePersonTimeOffInput[] = [];

  const repository = {
    resolvePersonMembership: async (_r: unknown, ctx: TenantContext, userId: string) =>
      (members[ctx.organizationId] ?? []).includes(userId) ? { userId } : null,
    listForPerson: async (
      _r: unknown,
      ctx: TenantContext,
      personUserId: string,
      range: TimeOffRange | null,
    ) =>
      rows
        .filter(
          (row) => row.organizationId === ctx.organizationId && row.personUserId === personUserId,
        )
        .filter((row) =>
          range === null ? true : row.startsOn <= range.to && row.endsOn >= range.from,
        )
        .sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0)),
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      rows.find((row) => row.organizationId === ctx.organizationId && row.id === id) ?? null,
    create: async (_r: unknown, ctx: TenantContext, input: CreatePersonTimeOffInput) => {
      createCalls.push(input);
      const row: PersonTimeOffRow = {
        id: `time-off-${rows.length + 1}`,
        organizationId: ctx.organizationId,
        personUserId: input.personUserId,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        kind: input.kind,
        note: input.note,
        createdByUserId: input.createdByUserId,
        createdAt: new Date('2026-09-28T10:00:00.000Z'),
      } as unknown as PersonTimeOffRow;
      rows.push(row);
      return row;
    },
    deleteForPerson: async (_r: unknown, ctx: TenantContext, personUserId: string, id: string) => {
      const index = rows.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.personUserId === personUserId &&
          row.id === id,
      );
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
  } as unknown as PersonTimeOffRepository;

  return { rows, createCalls, repository };
}

function database(): TenantDatabase {
  return {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
}

function controllerWith(members: Readonly<Record<string, readonly string[]>>) {
  const store = makeStore(members);
  const service = new PersonTimeOffService(database(), store.repository);
  return { ...store, controller: new PersonTimeOffController(service) };
}

const VALID = { startsOn: '2026-10-01', endsOn: '2026-10-05', kind: 'vacation', note: 'Away' };

describe('PersonTimeOffController (x325) — a manager files a person absence', () => {
  it('files an entry against a resolvable person, lists it, then removes it', async () => {
    const { createCalls, controller } = controllerWith({ [ORG]: [PERSON] });
    const owner = principal('owner');

    const created = await controller.create(context, owner, PERSON, VALID);
    expect(created.personUserId).toBe(PERSON);
    expect(created.createdByUserId).toBe(ACTING);
    expect(created).not.toHaveProperty('organizationId');
    expect(createCalls[0]?.personUserId).toBe(PERSON);

    const listed = await controller.list(context, principal('member'), PERSON);
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.kind).toBe('vacation');

    await controller.remove(context, owner, PERSON, created.id);
    expect((await controller.list(context, owner, PERSON)).entries).toHaveLength(0);
  });

  it('rejects an unknown kind with 400 and writes nothing', async () => {
    const { createCalls, controller } = controllerWith({ [ORG]: [PERSON] });
    await expect(
      controller.create(context, principal('owner'), PERSON, { ...VALID, kind: 'nope' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createCalls).toEqual([]);
  });

  it('rejects endsOn before startsOn with 400 and writes nothing', async () => {
    const { createCalls, controller } = controllerWith({ [ORG]: [PERSON] });
    await expect(
      controller.create(context, principal('owner'), PERSON, {
        ...VALID,
        startsOn: '2026-10-05',
        endsOn: '2026-10-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createCalls).toEqual([]);
  });

  // Refusal proof 1: create without `org.manage` is a 403 with no insert. `workspace_admin` holds
  // `work.read` but NOT `org.manage` (capabilities.ts), so the person resolves and the guard still 403s.
  it('refuses a create without org.manage (403) and writes nothing', async () => {
    const { createCalls, controller } = controllerWith({ [ORG]: [PERSON] });
    await expect(
      controller.create(context, principal('workspace_admin'), PERSON, VALID),
    ).rejects.toMatchObject({ status: 403 });
    expect(createCalls).toEqual([]);
  });

  // Refusal proof 2: an entry for another tenant's user id is a 404 with no write — even for an owner,
  // proving the resolve happens BEFORE authorize (the id is unresolved in this tenant).
  it('404s a create for another tenant user id with no write, before authorize', async () => {
    const { createCalls, controller } = controllerWith({
      [ORG]: [PERSON],
      [OTHER_ORG]: [FOREIGN_PERSON],
    });
    await expect(
      controller.create(context, principal('owner'), FOREIGN_PERSON, VALID),
    ).rejects.toMatchObject({ status: 404 });
    expect(createCalls).toEqual([]);
  });

  it('404s a list for another tenant user id with no read', async () => {
    const { controller } = controllerWith({ [ORG]: [PERSON], [OTHER_ORG]: [FOREIGN_PERSON] });
    await expect(
      controller.list(context, principal('member'), FOREIGN_PERSON),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a read without work.read (403)', async () => {
    const { controller } = controllerWith({ [ORG]: [PERSON] });
    await expect(
      controller.list(context, principal('client_member', 'client'), PERSON),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('DELETE is idempotent — removing a missing entry for a resolvable person is a 204 (no throw)', async () => {
    const { controller } = controllerWith({ [ORG]: [PERSON] });
    await expect(
      controller.remove(context, principal('owner'), PERSON, 'time-off-absent'),
    ).resolves.toBeUndefined();
  });

  it('404s a DELETE for another tenant user id', async () => {
    const { controller } = controllerWith({ [ORG]: [PERSON], [OTHER_ORG]: [FOREIGN_PERSON] });
    await expect(
      controller.remove(context, principal('owner'), FOREIGN_PERSON, 'time-off-1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('filters a ranged list to entries overlapping [from, to]', async () => {
    const { rows, controller } = controllerWith({ [ORG]: [PERSON] });
    const owner = principal('owner');
    await controller.create(context, owner, PERSON, {
      startsOn: '2026-10-01',
      endsOn: '2026-10-03',
      kind: 'vacation',
      note: null,
    });
    await controller.create(context, owner, PERSON, {
      startsOn: '2026-11-10',
      endsOn: '2026-11-12',
      kind: 'sick',
      note: null,
    });
    expect(rows).toHaveLength(2);

    const inRange = await controller.list(context, owner, PERSON, '2026-10-02', '2026-10-31');
    expect(inRange.entries).toHaveLength(1);
    expect(inRange.entries[0]?.startsOn).toBe('2026-10-01');
  });

  it('400s a range with only one bound', async () => {
    const { controller } = controllerWith({ [ORG]: [PERSON] });
    await expect(
      controller.list(context, principal('member'), PERSON, '2026-10-02', undefined),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('guards each route with its capability', () => {
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, PersonTimeOffController.prototype.list)).toBe(
      'work.read',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, PersonTimeOffController.prototype.create)).toBe(
      'org.manage',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, PersonTimeOffController.prototype.remove)).toBe(
      'org.manage',
    );
  });
});
