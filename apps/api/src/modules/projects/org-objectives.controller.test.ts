import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { OrgObjectivesController } from './org-objectives.controller.js';
import { OrgObjectivesService } from './org-objectives.service.js';
import type { OrgObjectivesRepository } from './org-objectives.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { OrgObjectiveRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x136). The org-objectives controller over the module's fakes with the **real**
 * `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven separately
 * in the chain's DB suite (no DB test in-slice, per pass-20 rules); here the subject is the
 * controller + service logic:
 *
 * - the create → list → transition round-trip;
 * - the guarded state machine — a transition is legal only from `open`, and an illegal one is a 409
 *   with no write;
 * - the Known-trap — an unknown / cross-tenant `objectiveId` (patch) is a 404 with no write;
 * - the org-level authorization — writes need `project.manage`, the list needs `work.read`; a role
 *   without `project.manage` gets a 403 on a write (no project to hide behind, so a 403, not a 404),
 *   and the route ceilings the `CapabilityGuard` enforces are the same.
 *
 * The fake `list` deliberately does apply only the tenant scope the real SQL applies, so ordering is
 * the service's own to get right.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const USER = 'user-0000-0000-0000-0000-000000000001';

function principal(role: Principal['role'], orgWide = false): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role,
    membershipId: 'membership-0000-0000-000000000001',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: orgWide,
  };
}

/** An org-wide owner: holds every capability, and org objectives are org-scoped. */
const owner = principal('owner', true);
/** A member: holds `work.read` but not `project.manage`, so it may list but not write. */
const member = principal('member');

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(seed: readonly OrgObjectiveRow[] = []): {
  controller: OrgObjectivesController;
  store: OrgObjectiveRow[];
} {
  const store: OrgObjectiveRow[] = [...seed];
  let seq = store.length;
  const database = {
    read: async (_context: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_context: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (_runner: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    findById: async (_runner: unknown, ctx: TenantContext, objectiveId: string) =>
      store.find((row) => row.id === objectiveId && row.organizationId === ctx.organizationId) ??
      null,
    updateStatus: async (
      _runner: unknown,
      ctx: TenantContext,
      objectiveId: string,
      status: OrgObjectiveRow['status'],
    ) => {
      const row = store.find(
        (candidate) =>
          candidate.id === objectiveId && candidate.organizationId === ctx.organizationId,
      );
      if (!row) throw new Error(`objective ${objectiveId} not found`);
      row.status = status;
      return row;
    },
    create: async (
      _runner: unknown,
      ctx: TenantContext,
      input: {
        readonly name: string;
        readonly description?: string | null;
        readonly target?: string | null;
        readonly status: OrgObjectiveRow['status'];
        readonly createdBy: string;
      },
    ) => {
      const row = {
        id: `objective-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        name: input.name,
        description: input.description ?? null,
        target: input.target ?? null,
        status: input.status,
        createdBy: input.createdBy,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as OrgObjectiveRow;
      store.push(row);
      return row;
    },
  } as unknown as OrgObjectivesRepository;

  const service = new OrgObjectivesService(database, repository);
  return { controller: new OrgObjectivesController(service), store };
}

describe('OrgObjectivesController create → list → transition', () => {
  it('creates an objective open, lists it, and transitions it to met', async () => {
    const { controller } = build();

    const created = await controller.create(context, owner, {
      name: 'Grow ARR 40%',
      description: 'Company-wide revenue objective for the year.',
      target: '+40% ARR',
    });
    expect(created.status).toBe('open');
    expect((created as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();
    expect((created as unknown as Record<string, unknown>)['projectId']).toBeUndefined();

    const listed = await controller.list(context, owner);
    expect(listed.objectives.map((o) => o.id)).toEqual([created.id]);

    const met = await controller.patch(context, owner, created.id, { status: 'met' });
    expect(met.status).toBe('met');
  });

  it('lists the organization’s objectives in creation order', async () => {
    const { controller } = build();
    const first = await controller.create(context, owner, { name: 'First' });
    const second = await controller.create(context, owner, { name: 'Second' });
    const listed = await controller.list(context, owner);
    expect(listed.objectives.map((o) => o.id)).toEqual([first.id, second.id]);
  });
});

describe('the guarded transition', () => {
  it('rejects transitioning an already-closed objective with a 409 and no write', async () => {
    const { controller, store } = build();
    const created = await controller.create(context, owner, { name: 'Ship' });
    await controller.patch(context, owner, created.id, { status: 'met' });

    await expect(
      controller.patch(context, owner, created.id, { status: 'missed' }),
    ).rejects.toEqual(expect.objectContaining({ status: 409, code: 'conflict' }));
    // No write: the status is still the first, legal transition's result.
    expect(store.find((row) => row.id === created.id)?.status).toBe('met');
  });

  it('rejects a body status that is not met or missed with a 422', async () => {
    const { controller } = build();
    const created = await controller.create(context, owner, { name: 'Ship' });
    await expect(
      controller.patch(context, owner, created.id, { status: 'open' as unknown as 'met' }),
    ).rejects.toEqual(expect.objectContaining({ status: 422 }));
  });
});

describe('the Known-trap: an unknown or cross-tenant id is a 404, no write', () => {
  it('patch against an unknown objective is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.patch(context, owner, 'objective-0000-0000-0000-0000000000ff', { status: 'met' }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('a cross-tenant objective is invisible to a patch (resolved tenant-scoped first)', async () => {
    const foreign = {
      id: 'objective-0000-0000-0000-0000000000aa',
      organizationId: OTHER_ORG,
      name: 'Someone else’s',
      description: null,
      target: null,
      status: 'open',
      createdBy: USER,
      createdAt: new Date(),
    } as OrgObjectiveRow;
    const { controller } = build([foreign]);
    await expect(controller.patch(context, owner, foreign.id, { status: 'met' })).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
  });
});

describe('org-level authorization (real authorize)', () => {
  it('a role without project.manage gets a 403 on a write and nothing is written', async () => {
    const { controller, store } = build();
    await expect(controller.create(context, member, { name: 'Not mine' })).rejects.toEqual(
      expect.objectContaining({ status: 403, code: 'forbidden' }),
    );
    expect(store).toHaveLength(0);
  });

  it('a role with work.read but not project.manage may still list', async () => {
    const { controller } = build();
    await controller.create(context, owner, { name: 'Visible' });
    const listed = await controller.list(context, member);
    expect(listed.objectives).toHaveLength(1);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to write and work.read to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(OrgObjectivesController.prototype.create)).toBe('project.manage');
    expect(cap(OrgObjectivesController.prototype.patch)).toBe('project.manage');
    expect(cap(OrgObjectivesController.prototype.list)).toBe('work.read');
  });
});
