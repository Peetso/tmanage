import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { WorkItemsController } from './work-items.controller.js';
import { WorkItemsService } from './work-items.service.js';
import type { WorkItemsRepository } from './work-items.repository.js';
import type { WorkGraphRepository } from './work-graph.repository.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import type { ProjectClientsRepository } from '../clients/project-clients.repository.js';
import type { ProjectMembershipsRepository } from '../projects/project-memberships.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkItemRow } from '../../common/database/schema.js';

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

  const graph = {
    isActiveInternalMember: async () => true,
  } as unknown as WorkGraphRepository;

  const memberships = {
    findByProjectAndUser: async (_r: unknown, _c: unknown, projectId: string, userId: string) =>
      onProject.has(`${projectId}:${userId}`) ? { id: 'pm-1' } : null,
  } as unknown as ProjectMembershipsRepository;

  const service = new WorkItemsService(
    database,
    workItems,
    undefined,
    projectsRepository,
    undefined,
    graph,
    { list: async () => [] } as unknown as ProjectClientsRepository,
    memberships,
  );
  return { controller: new WorkItemsController(service), updates, onProject };
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
