import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemsController } from './work-items.controller.js';
import { WorkItemsService } from './work-items.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { WorkGraphRepository } from './work-graph.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import type { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import type { ObjectiveWorkLinksRepository } from '../projects/objective-work-links.repository.js';
import type { WorkItemFilesRepository } from './item-files.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';
import type { WorkItemClientAudienceRepository } from './work-item-client-audience.repository.js';
import type { WorkItemAssigneesRepository } from './work-item-assignees.repository.js';

/**
 * A6 — the work item's description and the move to another project, proved database-free over
 * the real controller, the real service and the real `authorize`, with in-memory repositories.
 * The migration and the SQL round-trip are the chain's DB suite; this file proves what the
 * route accepts, what the service decides and what it hands the repository.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const TARGET = 'project-0000-0000-0000-0000-000000000002';
const FOREIGN = 'project-0000-0000-0000-0000-0000000000ff';
const OWNER = 'user-0000-0000-0000-0000-000000000001';
const MONA = 'user-0000-0000-0000-0000-000000000002';

const context = { organizationId: ORG, userId: OWNER, correlationId: 'c-1' } as TenantContext;

const principal: Principal = {
  userId: OWNER,
  organizationId: ORG,
  kind: 'internal',
  role: 'owner',
  membershipId: 'membership-0000-0000-000000000001',
  membershipStatus: 'active',
  clientOrganizationId: null,
  projectIds: [PROJECT, TARGET],
  hasOrgWideScope: true,
};

function harness() {
  const rows: WorkItemRow[] = [];
  const projects = [
    { id: PROJECT, organizationId: ORG, archivedAt: null },
    { id: TARGET, organizationId: ORG, archivedAt: null },
    { id: FOREIGN, organizationId: OTHER_ORG, archivedAt: null },
  ];
  const onProject = new Set([`${PROJECT}:${MONA}`]);
  const updates: Record<string, unknown>[] = [];
  let seq = 0;

  const database = {
    read: async (_c: unknown, work: (r: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (t: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const find = (ctx: TenantContext, id: string) =>
    rows.find((row) => row.id === id && row.organizationId === ctx.organizationId) ?? null;

  const workItems = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) => find(ctx, id),
    findManyByIds: async () => rows,
    create: async (_r: unknown, ctx: TenantContext, input: Record<string, unknown>) => {
      const now = new Date('2026-10-23T09:00:00.000Z');
      const row = {
        id: `wi-${(seq += 1)}`,
        organizationId: ctx.organizationId,
        projectId: input['projectId'],
        type: input['type'] ?? 'task',
        title: input['title'],
        description: input['description'] ?? null,
        state: 'backlog',
        ownerUserId: input['ownerUserId'] ?? null,
        audience: input['audience'] ?? 'internal',
        startAt: null,
        dueAt: null,
        completedAt: null,
        version: 1,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      } as WorkItemRow;
      rows.push(row);
      return row;
    },
    update: async (
      _r: unknown,
      ctx: TenantContext,
      id: string,
      _v: number,
      input: Record<string, unknown>,
    ) => {
      updates.push(input);
      const row = find(ctx, id) as WorkItemRow;
      Object.assign(row, input, { version: row.version + 1 });
      return row;
    },
  } as unknown as WorkItemsRepository;

  const projectsRepository = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      projects.find((p) => p.id === id && p.organizationId === ctx.organizationId) ?? null,
  } as unknown as ProjectsRepository;

  // 53-04: the edges the cycle guard walks (seeded by the dependency test).
  const edges: { workItemId: string; dependsOnWorkItemId: string }[] = [];
  const graph = {
    isActiveInternalMember: async () => true,
    lockProjects: async () => undefined,
    listActiveEdgesFrom: async () => edges,
  } as unknown as WorkGraphRepository;

  const memberships = {
    findByProjectAndUser: async (_r: unknown, _c: unknown, projectId: string, userId: string) =>
      onProject.has(`${projectId}:${userId}`) ? { id: 'pm-1' } : null,
  } as unknown as ProjectMembershipsRepository;

  // F24 / F50: what the move transaction asks the edge repositories to remove.
  const edgeCleanups: string[] = [];
  const objectiveLinks = {
    deleteForWorkItem: async (_r: unknown, _c: unknown, workItemId: string) => {
      edgeCleanups.push(`objective-links:${workItemId}`);
      return 1;
    },
  } as unknown as ObjectiveWorkLinksRepository;
  const itemFiles = {
    detachOutsideProject: async (
      _r: unknown,
      _c: unknown,
      workItemId: string,
      projectId: string,
    ) => {
      edgeCleanups.push(`files-outside:${workItemId}:${projectId}`);
      return 1;
    },
  } as unknown as WorkItemFilesRepository;

  const service = new WorkItemsService(
    database,
    workItems,
    undefined,
    projectsRepository,
    undefined,
    graph,
    { list: async () => [] } as unknown as ProjectClientsRepository,
    memberships,
    objectiveLinks,
    itemFiles,
    // C25: a move clears the item's client list; nothing is stored here.
    {
      list: async () => [],
      replace: async () => undefined,
    } as unknown as WorkItemClientAudienceRepository,
    // C26: an owner change keeps the doer rows in step; nothing is stored here.
    {
      syncLead: async () => undefined,
      list: async () => [],
      watcherUserIds: async () => [],
    } as unknown as WorkItemAssigneesRepository,
  );
  return {
    controller: new WorkItemsController(service),
    updates,
    onProject,
    edgeCleanups,
    rows,
    edges,
  };
}

describe('A6 work item description and move', () => {
  it('round-trips the description through create, PATCH and GET', async () => {
    const { controller } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Homepage hero copy',
      description: '  Write the hero headline.  ',
    });
    expect(created.description).toBe('Write the hero headline.');

    const edited = await controller.update(context, principal, created.id, {
      version: created.version,
      description: 'Keep it under 12 words.',
    });
    expect(edited.description).toBe('Keep it under 12 words.');
    expect((await controller.get(context, principal, created.id)).description).toBe(
      'Keep it under 12 words.',
    );

    const cleared = await controller.update(context, principal, created.id, {
      version: edited.version,
      description: '   ',
    });
    expect(cleared.description).toBeNull();
  });

  it('refuses an over-long description with 400', async () => {
    const { controller } = harness();
    await expect(
      controller.create(context, principal, {
        projectId: PROJECT,
        title: 'Too long',
        description: 'x'.repeat(5001),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('answers 404 for a move into another tenant’s project and writes nothing', async () => {
    const { controller, updates } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Footer links',
    });
    await expect(
      controller.update(context, principal, created.id, {
        version: created.version,
        projectId: FOREIGN,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(updates).toEqual([]);
  });

  it('moves within the organization and clears an owner who is not on the target', async () => {
    const { controller, updates } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Navigation redesign',
      ownerUserId: MONA,
    });
    const moved = await controller.update(context, principal, created.id, {
      version: created.version,
      projectId: TARGET,
    });
    expect(moved.projectId).toBe(TARGET);
    expect(moved.ownerUserId).toBeNull();
    expect(updates[0]).toEqual({ projectId: TARGET, ownerUserId: null });
  });

  it('keeps an owner who is on the target project', async () => {
    const { controller, onProject } = harness();
    onProject.add(`${TARGET}:${MONA}`);
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Pricing page layout',
      ownerUserId: MONA,
    });
    const moved = await controller.update(context, principal, created.id, {
      version: created.version,
      projectId: TARGET,
    });
    expect(moved.ownerUserId).toBe(MONA);
  });
});

describe('F24 + F50: a move removes the edges scoped to the source project', () => {
  it('deletes objective links and detaches out-of-project files in the move', async () => {
    const { controller, edgeCleanups } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Linked to an objective',
    });
    await controller.update(context, principal, created.id, {
      version: created.version,
      projectId: TARGET,
    });
    expect(edgeCleanups).toEqual([
      `objective-links:${created.id}`,
      `files-outside:${created.id}:${TARGET}`,
    ]);
  });

  it('an edit that is not a move removes nothing', async () => {
    const { controller, edgeCleanups } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Stays put',
    });
    await controller.update(context, principal, created.id, {
      version: created.version,
      title: 'Still stays put',
      projectId: PROJECT,
    });
    expect(edgeCleanups).toEqual([]);
  });
});

describe('F26: widening to a client audience needs deliverable.publish', () => {
  function onProject(role: Principal['role']): Principal {
    return {
      ...principal,
      userId: MONA,
      role,
      membershipId: 'membership-0000-0000-000000000002',
      projectIds: [PROJECT],
      hasOrgWideScope: false,
    };
  }

  for (const role of ['guest', 'member', 'moderator'] as const) {
    it(`a ${role} cannot PATCH an internal item to client_visible (403, nothing written)`, async () => {
      const { controller, updates, rows } = harness();
      const created = await controller.create(context, principal, {
        projectId: PROJECT,
        title: 'INTERNAL-ONLY',
      });
      await expect(
        controller.update(context, onProject(role), created.id, {
          version: created.version,
          audience: 'client_visible',
        }),
      ).rejects.toMatchObject({ status: 403 });
      expect(updates).toEqual([]);
      expect(rows[0]?.audience).toBe('internal');
    });
  }

  it('a member cannot create an item straight into client_visible (403, nothing written)', async () => {
    const { controller, rows } = harness();
    await expect(
      controller.create(context, onProject('member'), {
        projectId: PROJECT,
        title: 'INTERNAL-ONLY',
        audience: 'client_visible',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(rows).toEqual([]);
  });

  it('a member may still edit fields and narrow nothing without publish', async () => {
    const { controller } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Internal draft',
    });
    const edited = await controller.update(context, onProject('member'), created.id, {
      version: created.version,
      title: 'Internal draft v2',
    });
    expect(edited.audience).toBe('internal');
  });

  it('a manager on the project may widen to client_visible', async () => {
    const { controller } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Ready for the client',
    });
    const widened = await controller.update(context, onProject('manager'), created.id, {
      version: created.version,
      audience: 'client_visible',
    });
    expect(widened.audience).toBe('client_visible');
  });
});

describe('53-04 typed dependencies', () => {
  it('refuses a bad kind with 400 and a loop with 409 naming it', async () => {
    const { controller, edges } = harness();
    const a = await controller.create(context, principal, { projectId: PROJECT, title: 'Alpha' });
    const b = await controller.create(context, principal, { projectId: TARGET, title: 'Beta' });
    const add = (kind: string) =>
      controller.addDependency(context, principal, a.id, { dependsOnWorkItemId: b.id, kind });
    await expect(add('XX')).rejects.toMatchObject({ status: 400 });
    edges.push({ workItemId: b.id, dependsOnWorkItemId: a.id });
    await expect(add('SS')).rejects.toMatchObject({
      status: 409,
      details: [{ message: 'dependency_cycle: Alpha → Beta' }],
    });
  });
});

describe('FIX3 item C: the hand-made order (rank) for Board and List drags', () => {
  it('stores a dragged rank, answers it on the view and clears it with null', async () => {
    const { controller, updates } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Moodboard',
    });
    expect(created.rank).toBeNull();
    const ranked = await controller.update(context, principal, created.id, {
      version: created.version,
      rank: 1_762_000_000_500.5,
    });
    expect(updates[0]).toEqual({ boardRank: 1_762_000_000_500.5 });
    expect(ranked.rank).toBe(1_762_000_000_500.5);
    const cleared = await controller.update(context, principal, created.id, {
      version: ranked.version,
      rank: null,
    });
    expect(cleared.rank).toBeNull();
  });

  it('refuses a rank that is not a finite number with 400 and writes nothing', async () => {
    const { controller, updates } = harness();
    const created = await controller.create(context, principal, {
      projectId: PROJECT,
      title: 'Sitemap',
    });
    for (const rank of ['1', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      await expect(
        controller.update(context, principal, created.id, { version: created.version, rank }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(updates).toEqual([]);
  });
});
