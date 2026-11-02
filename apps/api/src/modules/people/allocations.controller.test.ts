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
): {
  controller: PersonAllocationsController;
  store: PersonAllocationRow[];
  audited: string[];
  auditInputs: { readonly action: string; readonly changes?: unknown }[];
} {
  const audited: string[] = [];
  const auditInputs: { readonly action: string; readonly changes?: unknown }[] = [];
  const audit = {
    record: async (
      _tx: unknown,
      _ctx: unknown,
      input: { readonly action: string; readonly changes?: unknown },
    ) => {
      audited.push(input.action);
      auditInputs.push(input);
      return {} as never;
    },
  };
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
        readonly status?: string;
        readonly hoursPerWeek?: number | null;
        readonly note?: string | null;
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
        status: input.status ?? 'confirmed',
        hoursPerWeek: input.hoursPerWeek ?? null,
        note: input.note ?? null,
      } as PersonAllocationRow;
      store.push(row);
      return row;
    },
    confirm: async (_r: unknown, ctx: TenantContext, id: string) => {
      const row = store.find((r) => r.id === id && r.organizationId === ctx.organizationId);
      if (!row) return 'not_found';
      if (row.status !== 'tentative') return 'already_confirmed';
      (row as { status: string }).status = 'confirmed';
      return 'confirmed';
    },
    requireById: async (_r: unknown, ctx: TenantContext, id: string) =>
      store.find((row) => row.id === id && row.organizationId === ctx.organizationId)!,
    update: async (
      _r: unknown,
      ctx: TenantContext,
      projectId: string,
      id: string,
      patch: Record<string, unknown>,
    ) => {
      const row = store.find(
        (r) => r.id === id && r.organizationId === ctx.organizationId && r.projectId === projectId,
      );
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, projectId: string, id: string) => {
      const index = store.findIndex(
        (r) => r.id === id && r.organizationId === ctx.organizationId && r.projectId === projectId,
      );
      if (index < 0) return 0;
      store.splice(index, 1);
      return 1;
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
    controller: new PersonAllocationsController(
      database,
      allocations,
      projects,
      memberships,
      audit,
    ),
    store,
    audited,
    auditInputs,
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

describe('53-08 status, hours and confirm', () => {
  const client: Principal = { ...owner, kind: 'client', role: 'client_viewer' };

  it('stores tentative with hours and a note; an unknown status is a 400 with no write', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, PROJECT, {
        membershipId: MEMBERSHIP,
        percent: 50,
        status: 'maybe',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    await expect(
      controller.create(context, owner, PROJECT, {
        membershipId: MEMBERSHIP,
        percent: 50,
        hoursPerWeek: 169,
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
    expect(store).toHaveLength(0);
    const created = await controller.create(context, owner, PROJECT, {
      membershipId: MEMBERSHIP,
      percent: 50,
      status: 'tentative',
      hoursPerWeek: 12.5,
      note: 'pending SOW',
    });
    expect(created).toEqual(
      expect.objectContaining({ status: 'tentative', hoursPerWeek: 12.5, note: 'pending SOW' }),
    );
  });

  it('confirms once (audited), then a second confirm is a 409', async () => {
    const { controller, audited } = build();
    const created = await controller.create(context, owner, PROJECT, {
      membershipId: MEMBERSHIP,
      percent: 50,
      status: 'tentative',
    });
    const confirmed = await controller.confirm(context, owner, PROJECT, created.id);
    expect(confirmed.status).toBe('confirmed');
    expect(audited).toEqual(['person_allocation.confirmed']);
    await expect(controller.confirm(context, owner, PROJECT, created.id)).rejects.toEqual(
      expect.objectContaining({ status: 409, auditCode: 'allocation_already_confirmed' }),
    );
    await expect(controller.confirm(context, owner, PROJECT, 'nope')).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });

  it('a client principal is a 403 on confirm, and the route needs project.manage', async () => {
    const { controller } = build();
    await expect(controller.confirm(context, client, PROJECT, 'any')).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    const cap = Reflect.getMetadata(
      REQUIRED_CAPABILITY,
      PersonAllocationsController.prototype.confirm as object,
    );
    expect(cap).toBe('project.manage');
  });
});

describe('53-08 (R21-b) edit and remove an allocation', () => {
  const client: Principal = { ...owner, kind: 'client', role: 'client_viewer' };
  const foreign = {
    id: 'allocation-foreign',
    organizationId: 'organization-other',
    projectId: PROJECT,
    membershipId: MEMBERSHIP,
    percent: 40,
    startDate: null,
    endDate: null,
    createdAt: new Date(Date.UTC(2026, 0, 1)),
    status: 'confirmed',
    hoursPerWeek: null,
    note: null,
  } as PersonAllocationRow;

  async function seeded() {
    const built = build([foreign]);
    const created = await built.controller.create(context, owner, PROJECT, {
      membershipId: MEMBERSHIP,
      percent: 50,
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      status: 'tentative',
    });
    return { ...built, id: created.id };
  }

  it('PATCH status is a 409 use_confirm; an inverted range is a 400 invalid_range; empty is a 400', async () => {
    const { controller, id, audited } = await seeded();
    await expect(
      controller.update(context, owner, PROJECT, id, { status: 'confirmed' }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, auditCode: 'use_confirm' }));
    await expect(
      controller.update(context, owner, PROJECT, id, { endDate: '2026-02-01' }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, auditCode: 'invalid_range' }));
    await expect(controller.update(context, owner, PROJECT, id, {})).rejects.toEqual(
      expect.objectContaining({ status: 400 }),
    );
    expect(audited).toEqual([]);
    const updated = await controller.update(context, owner, PROJECT, id, {
      percent: 80,
      note: 'more',
    });
    expect(updated).toEqual(expect.objectContaining({ percent: 80, note: 'more' }));
    expect(audited).toEqual(['person_allocation.updated']);
  });

  it('PATCH/DELETE a cross-tenant id is a 404 with no audit row', async () => {
    const { controller, audited, store } = await seeded();
    await expect(
      controller.update(context, owner, PROJECT, foreign.id, { percent: 10 }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    await expect(controller.remove(context, owner, PROJECT, foreign.id)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(audited).toEqual([]);
    expect(store.find((row) => row.id === foreign.id)?.percent).toBe(40);
  });

  it('DELETE removes the row and the audit before carries percent and status', async () => {
    const { controller, id, store, auditInputs } = await seeded();
    await controller.remove(context, owner, PROJECT, id);
    expect(store.find((row) => row.id === id)).toBeUndefined();
    expect(auditInputs[0]?.action).toBe('person_allocation.deleted');
    expect(auditInputs[0]?.changes).toEqual(
      expect.arrayContaining([
        { field: 'percent', before: 50, after: null },
        { field: 'status', before: 'tentative', after: null },
      ]),
    );
  });

  it('a client principal is a 403 on both, and both routes need project.manage', async () => {
    const { controller, id } = await seeded();
    await expect(controller.update(context, client, PROJECT, id, { percent: 5 })).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    await expect(controller.remove(context, client, PROJECT, id)).rejects.toEqual(
      expect.objectContaining({ status: 403 }),
    );
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(PersonAllocationsController.prototype.update)).toBe('project.manage');
    expect(cap(PersonAllocationsController.prototype.remove)).toBe('project.manage');
  });
});
