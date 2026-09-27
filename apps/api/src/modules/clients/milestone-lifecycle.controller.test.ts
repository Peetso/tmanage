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
