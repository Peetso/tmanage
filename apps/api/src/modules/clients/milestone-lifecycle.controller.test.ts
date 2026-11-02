import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import {
  MilestoneLifecycleController,
  MilestoneLifecycleService,
} from './milestone-lifecycle.controller.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type {
  ProjectMilestonesRepository,
  UpdateProjectMilestonePatch,
} from './project-milestones.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectMilestoneRow, ProjectRow } from '../../common/database/schema.js';

/**
 * SEC / Portal milestone lifecycle (x202) — edit and complete over fakes with **real**
 * `authorize()`. The fakes stand in only for the database and the two repositories; the policy is
 * real, so these cases prove the actual decisions: an internal manager edits and completes, a
 * cross-tenant milestone id is a 404 with no write, and a client (no `project.manage`) is refused.
 * No DB here — the chain owns the round-trip.
 */

const ORG = 'org-under-test';
const INTERNAL_USER = 'user-internal-1';
const PROJECT = 'project-visible';
const MILESTONE = 'milestone-1';

function internalManager(): Principal {
  return {
    userId: INTERNAL_USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: 'membership-internal-1',
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

function clientPrincipal(): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-client-1',
    membershipStatus: 'active',
    clientOrganizationId: 'client-org',
    projectIds: [PROJECT],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: INTERNAL_USER } as unknown as TenantContext;

function fakeDatabase(): TenantDatabase {
  const runner = {} as never;
  return {
    read: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> => work(runner),
    transaction: <T>(_c: TenantContext, work: (db: never) => Promise<T>): Promise<T> =>
      work(runner),
  } as unknown as TenantDatabase;
}

function fakeProjects(existing: readonly string[]): ProjectsRepository {
  return {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(existing.includes(id) ? ({ id } as unknown as ProjectRow) : null),
  } as unknown as ProjectsRepository;
}

/** A stateful store seeded with one milestone; `update` applies the patch and bumps `updatedAt`. */
function fakeMilestones(seed?: Partial<ProjectMilestoneRow>): {
  repo: ProjectMilestonesRepository;
  updates: UpdateProjectMilestonePatch[];
  row: ProjectMilestoneRow;
} {
  const updates: UpdateProjectMilestonePatch[] = [];
  const row = {
    id: MILESTONE,
    organizationId: ORG,
    projectId: PROJECT,
    title: 'Design sign-off',
    dueOn: '2026-10-15',
    status: 'planned',
    published: true,
    createdByUserId: INTERNAL_USER,
    createdAt: new Date('2026-09-20T00:00:00.000Z'),
    updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    ...seed,
  } as ProjectMilestoneRow;
  const repo = {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(id === row.id ? row : null),
    update: (_r: never, _c: TenantContext, id: string, patch: UpdateProjectMilestonePatch) => {
      if (id !== row.id) return Promise.resolve(null);
      updates.push(patch);
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.dueOn !== undefined) row.dueOn = patch.dueOn;
      if (patch.status !== undefined) row.status = patch.status;
      row.updatedAt = new Date('2026-09-27T12:00:00.000Z');
      return Promise.resolve(row);
    },
  } as unknown as ProjectMilestonesRepository;
  return { repo, updates, row };
}

function serviceFor(
  existingProjects: readonly string[],
  store: ReturnType<typeof fakeMilestones>,
): MilestoneLifecycleService {
  return new MilestoneLifecycleService(fakeDatabase(), fakeProjects(existingProjects), store.repo);
}

describe('MilestoneLifecycleService (x202)', () => {
  it('edits title and due date and returns the updated instant', async () => {
    const store = fakeMilestones();
    const service = serviceFor([PROJECT], store);

    const edited = await service.edit(context, internalManager(), {
      projectId: PROJECT,
      milestoneId: MILESTONE,
      patch: { title: 'Design sign-off (final)', dueOn: '2026-10-20' },
    });

    expect(edited.title).toBe('Design sign-off (final)');
    expect(edited.dueOn).toBe('2026-10-20');
    expect(edited.updatedAt).toBe('2026-09-27T12:00:00.000Z');
  });

  it('completes a milestone by setting status=met with a completion instant', async () => {
    const store = fakeMilestones();
    const service = serviceFor([PROJECT], store);

    const done = await service.complete(context, internalManager(), PROJECT, MILESTONE);

    expect(store.updates.at(-1)).toEqual({ status: 'met' });
    expect(done.status).toBe('met');
    expect(done.updatedAt).toBe('2026-09-27T12:00:00.000Z');
  });

  it('answers 404 and writes nothing for a cross-tenant / unknown milestone id', async () => {
    const store = fakeMilestones();
    const service = serviceFor([PROJECT], store);

    await expect(
      service.complete(context, internalManager(), PROJECT, 'milestone-elsewhere'),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.updates).toHaveLength(0);
  });

  it('answers 404 and writes nothing when a client (no project.manage) tries to edit', async () => {
    const store = fakeMilestones();
    const service = serviceFor([PROJECT], store);

    await expect(
      service.edit(context, clientPrincipal(), {
        projectId: PROJECT,
        milestoneId: MILESTONE,
        patch: { title: 'hijack' },
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.updates).toHaveLength(0);
  });
});

/** The route ceiling: both writes require `project.manage`, so the guard refuses a client with 403. */
describe('milestone lifecycle route capabilities', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards edit and complete with project.manage', () => {
    expect(capabilityOf(MilestoneLifecycleController.prototype, 'edit')).toBe('project.manage');
    expect(capabilityOf(MilestoneLifecycleController.prototype, 'complete')).toBe('project.manage');
  });
});

/** A9 — the Milestones list, Edit milestone (owner, delivered, client timeline) and Delete. */
describe('A9 milestone plan, details and delete', () => {
  function a9Service(links: number, ownerActive = true) {
    const store = fakeMilestones({ description: null, ownerUserId: null });
    const deleted: string[] = [];
    const repo = Object.assign(store.repo, {
      list: () => Promise.resolve([store.row]),
      countLinks: () => Promise.resolve(links),
      delete: (_r: never, _c: TenantContext, id: string) => {
        deleted.push(id);
        return Promise.resolve();
      },
    });
    const members = {
      findByUserId: (_r: never, _c: TenantContext, userId: string) =>
        Promise.resolve(
          ownerActive && userId === 'user-mona'
            ? { userId, status: 'active', role: 'member' }
            : null,
        ),
    };
    const shares = { list: () => Promise.resolve([{ clientOrganizationId: 'client-atlas' }]) };
    const clientOrganizations = {
      findById: () => Promise.resolve({ id: 'client-atlas', name: 'Atlas Hospitality' }),
    };
    const service = new MilestoneLifecycleService(
      fakeDatabase(),
      fakeProjects([PROJECT]),
      repo,
      members as never,
      shares as never,
      clientOrganizations as never,
    );
    return { service, store, deleted };
  }

  it('reads the plan with the client name and each milestone’s details', async () => {
    const { service } = a9Service(0);
    const plan = await service.plan(context, internalManager(), PROJECT);
    expect(plan.clientName).toBe('Atlas Hospitality');
    expect(plan.milestones[0]).toMatchObject({
      id: MILESTONE,
      description: null,
      ownerUserId: null,
      published: true,
    });
  });

  it('accepts description, owner and the client-timeline flag through PATCH', async () => {
    const { service, store } = a9Service(0);
    const controller = new MilestoneLifecycleController(service);
    await controller.edit(context, internalManager(), PROJECT, MILESTONE, {
      description: 'Approved homepage, menu and booking page designs',
      ownerUserId: 'user-mona',
      published: false,
    });
    expect(store.updates.at(-1)).toEqual({
      description: 'Approved homepage, menu and booking page designs',
      ownerUserId: 'user-mona',
      published: false,
    });
  });

  it('refuses an owner who is not an active member, writing nothing', async () => {
    const { service, store } = a9Service(0, false);
    const controller = new MilestoneLifecycleController(service);
    await expect(
      controller.edit(context, internalManager(), PROJECT, MILESTONE, { ownerUserId: 'user-mona' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.updates).toHaveLength(0);
  });

  it('deletes an unlinked milestone', async () => {
    const { service, deleted } = a9Service(0);
    await service.remove(context, internalManager(), PROJECT, MILESTONE);
    expect(deleted).toEqual([MILESTONE]);
  });

  it('refuses to delete a milestone that is still linked (409), deleting nothing', async () => {
    const { service, deleted } = a9Service(2);
    await expect(
      service.remove(context, internalManager(), PROJECT, MILESTONE),
    ).rejects.toMatchObject({ status: 409 });
    expect(deleted).toHaveLength(0);
  });

  it('guards plan and delete with project.manage', () => {
    const proto = MilestoneLifecycleController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto['plan'] as object)).toBe(
      'project.manage',
    );
    expect(Reflect.getMetadata(REQUIRED_CAPABILITY, proto['remove'] as object)).toBe(
      'project.manage',
    );
  });
});

/** 53-07 — dated moves with a client-safe reason, the version check, and publish = copy. */
describe('53-07 milestone timeline edits and publish', () => {
  function timelineService(published: boolean) {
    const store = fakeMilestones({
      version: 3,
      committedOn: '2026-12-01',
      forecastOn: '2026-12-20',
      clientTitle: null,
      ownerUserId: 'user-owner-secret',
      description: 'internal notes',
    } as Partial<ProjectMilestoneRow>);
    const copies: Record<string, unknown>[] = [];
    const audits: { action: string; changes?: unknown }[] = [];
    const events: unknown[] = [];
    const repo = Object.assign(store.repo, {
      findByIdForUpdate: () => Promise.resolve(store.row),
      findProjection: () =>
        Promise.resolve(published ? { clientTitle: 'Launch', phaseName: null } : null),
      countProjections: () => Promise.resolve(0),
      phaseNameOf: () => Promise.resolve('Build'),
      upsertProjection: (_r: never, _c: TenantContext, input: Record<string, unknown>) => {
        copies.push(input);
        return Promise.resolve({ ...input, publishedAt: new Date('2026-11-02T00:00:00.000Z') });
      },
    });
    const audit = { record: (_t: never, _c: never, input: never) => audits.push(input) };
    const outbox = { append: (_t: never, _c: never, input: never) => events.push(input) };
    const service = new MilestoneLifecycleService(
      fakeDatabase(),
      fakeProjects([PROJECT]),
      repo,
      undefined,
      undefined,
      undefined,
      audit as never,
      outbox as never,
    );
    return { service, store, copies, audits, events };
  }

  it('refuses a dragged committed date on a published milestone without a reason (422)', async () => {
    const { service, store } = timelineService(true);
    const controller = new MilestoneLifecycleController(service);
    await expect(
      controller.edit(context, internalManager(), PROJECT, MILESTONE, {
        committedOn: '2026-12-15',
      }),
    ).rejects.toMatchObject({ status: 422, auditCode: 'reason_required' });
    expect(store.updates).toHaveLength(0);
  });

  it('answers 409 version_conflict on a stale expectedVersion, writing nothing', async () => {
    const { service, store } = timelineService(false);
    const controller = new MilestoneLifecycleController(service);
    await expect(
      controller.edit(context, internalManager(), PROJECT, MILESTONE, {
        committedOn: '2026-12-15',
        expectedVersion: 2,
      }),
    ).rejects.toMatchObject({ status: 409, auditCode: 'version_conflict' });
    expect(store.updates).toHaveLength(0);
  });

  it('records the move with before/after and the reason in the audit row, never on the milestone', async () => {
    const { service, store, audits } = timelineService(true);
    const controller = new MilestoneLifecycleController(service);
    await controller.edit(context, internalManager(), PROJECT, MILESTONE, {
      committedOn: '2026-12-15',
      expectedVersion: 3,
      clientSafeReason: 'Waiting on the venue photos',
    });
    expect(store.updates.at(-1)).toEqual({ committedOn: '2026-12-15' });
    expect(audits[0]).toMatchObject({
      action: 'milestone.date_changed',
      changes: [
        { field: 'committed_on', before: '2026-12-01' },
        { field: 'client_safe_reason', after: 'Waiting on the venue photos' },
      ],
    });
  });

  it('publishes a copy of only the allowlisted columns, audited and emitted', async () => {
    const { service, copies, audits, events } = timelineService(false);
    const publication = await service.publish(context, internalManager(), PROJECT, MILESTONE);
    expect(Object.keys(copies[0] ?? {}).sort()).toEqual(
      ['clientTitle', 'committedOn', 'milestoneId', 'phaseName', 'projectId', 'status'].sort(),
    );
    expect(copies[0]).toMatchObject({ clientTitle: 'Design sign-off', phaseName: 'Build' });
    expect(JSON.stringify(publication)).not.toMatch(/user-owner-secret|internal notes|2026-12-20/);
    expect(audits.map((entry) => entry.action)).toEqual(['milestone.published']);
    expect(events).toHaveLength(1);
  });
});
