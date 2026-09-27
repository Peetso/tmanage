import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PersonAllocationsController } from './allocations.controller.js';
import type { PersonAllocationsRepository } from './allocations.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { MembershipsRepository } from '../tenancy/memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { PersonAllocationRow } from '../../common/database/schema.js';

/**
 * PEOPLE / module 14 (x171). The person-allocations controller over the module's fakes with the
 * **real** `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven
 * separately; here the subject is the controller's own decisions:
 *
 * - the assign → list round-trip;
 * - percent out of [1,100] is a 400 with no write;
 * - a duplicate active (project, membership) pair is a 409 with no second row;
 * - the Known-trap — an unknown / cross-tenant `projectId` OR `membershipId` is a 404 with no write,
 *   and a caller who names a project they do not manage gets the same not-found rather than a 403;
 * - the route ceilings — the write requires `project.manage`, the list `work.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const UNKNOWN_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
const MEMBERSHIP = 'membership-0000-0000-0000-00000000aa01';
const UNKNOWN_MEMBERSHIP = 'membership-0000-0000-0000-00000000aaff';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(
  role: Principal['role'],
  projectIds: readonly string[],
  orgWide = false,
): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds,
    hasOrgWideScope: orgWide,
  };
}

const owner = principal('owner', [], true);
const managerOnProject = principal('manager', [PROJECT]);
const managerElsewhere = principal('manager', []);

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(
  seed: readonly PersonAllocationRow[] = [],
  knownProjectIds: readonly string[] = [PROJECT],
  knownMembershipIds: readonly string[] = [MEMBERSHIP],
): { controller: PersonAllocationsController; store: PersonAllocationRow[] } {
  const store: PersonAllocationRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const allocations = {
    list: async (_r: unknown, ctx: TenantContext, options: { readonly projectId: string }) =>
      store
        .filter(
          (row) => row.projectId === options.projectId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findActiveForMember: async (
      _r: unknown,
      ctx: TenantContext,
      projectId: string,
      membershipId: string,
    ) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.projectId === projectId &&
          row.membershipId === membershipId &&
          row.endDate === null,
      ) ?? null,
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.id === id && row.organizationId === ctx.organizationId) ?? null,
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly membershipId: string;
        readonly percent: number;
        readonly startDate?: string | null;
        readonly endDate?: string | null;
      },
    ) => {
      const row = {
        id: `allocation-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        membershipId: input.membershipId,
        percent: input.percent,
        startDate: input.startDate ?? null,
        endDate: input.endDate ?? null,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as PersonAllocationRow;
      store.push(row);
      return row;
    },
  } as unknown as PersonAllocationsRepository;

  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const memberships = {
    findById: async (_r: unknown, ctx: TenantContext, membershipId: string) =>
      knownMembershipIds.includes(membershipId) && ctx.organizationId === ORG
        ? ({ id: membershipId } as unknown)
        : null,
  } as unknown as MembershipsRepository;

  return {
    controller: new PersonAllocationsController(database, allocations, projects, memberships),
    store,
  };
}

describe('PersonAllocationsController assign → list', () => {
  it('assigns a member to a project and lists the allocation', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, PROJECT, {
      membershipId: MEMBERSHIP,
      percent: 50,
    });
    expect(created.projectId).toBe(PROJECT);
    expect(created.membershipId).toBe(MEMBERSHIP);
    expect(created.percent).toBe(50);
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const listed = await controller.list(context, owner, PROJECT);
    expect(listed.allocations.map((a) => a.id)).toEqual([created.id]);
  });
});

describe('validation and the guarded invariants', () => {
  it('rejects a percent out of [1,100] with a 400 and no write', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, PROJECT, { membershipId: MEMBERSHIP, percent: 0 }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    await expect(
      controller.create(context, owner, PROJECT, { membershipId: MEMBERSHIP, percent: 101 }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    expect(store).toHaveLength(0);
  });

  it('rejects a duplicate active (project, membership) with a 409 and no second row', async () => {
    const { controller, store } = build();
    await controller.create(context, owner, PROJECT, { membershipId: MEMBERSHIP, percent: 40 });
    await expect(
      controller.create(context, owner, PROJECT, { membershipId: MEMBERSHIP, percent: 60 }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, code: 'conflict' }));
    expect(store).toHaveLength(1);
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write, never a 500', () => {
  it('create against an unknown project is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, UNKNOWN_PROJECT, { membershipId: MEMBERSHIP, percent: 50 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('create against an unknown membership is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, PROJECT, { membershipId: UNKNOWN_MEMBERSHIP, percent: 50 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });

  it('list against an unknown project is a 404', async () => {
    const { controller } = build();
    await expect(controller.list(context, owner, UNKNOWN_PROJECT)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager related to the project may assign', async () => {
    const { controller } = build();
    const created = await controller.create(context, managerOnProject, PROJECT, {
      membershipId: MEMBERSHIP,
      percent: 25,
    });
    expect(created.percent).toBe(25);
  });

  it('a manager not related to the project gets not-found, never a 403, and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, managerElsewhere, PROJECT, {
        membershipId: MEMBERSHIP,
        percent: 25,
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to assign and work.read to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(PersonAllocationsController.prototype.create)).toBe('project.manage');
    expect(cap(PersonAllocationsController.prototype.list)).toBe('work.read');
  });
});
