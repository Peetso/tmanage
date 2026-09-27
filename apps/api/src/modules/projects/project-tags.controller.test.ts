import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectTagsController } from './project-tags.controller.js';
import { ProjectTagsService } from './project-tags.service.js';
import type { ProjectTagsRepository } from './project-tags.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectTagRow } from '../../common/database/schema.js';

/**
 * x267. The project-tags controller over the module's fakes with the **real** `authorize()`
 * evaluator. The migration and the tenant-scoped SQL round-trip are proven separately in the DB
 * suite the chain owns; here the subject is the controller + service logic:
 *
 * - the define → assign → list → remove round-trip, with a duplicate name a 409 and tagging
 *   idempotent;
 * - the Known-trap / required refusal — assigning a tag to a project in **another tenant** is a 404
 *   with no insert, never a foreign-key 500, and a caller not related to the project gets the same
 *   404 rather than a 403 that would confirm it exists;
 * - the route ceilings — the writes require `project.manage`, the reads `work.read`.
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const UNKNOWN_PROJECT = 'project-0000-0000-0000-0000-0000000000ff';
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

/** An org-wide owner: passes the relation gate for any project of the tenant. */
const owner = principal('owner', [], true);
/** A manager related to no project and not org-wide: holds the ceiling, fails the relation gate. */
const managerElsewhere = principal('manager', []);

const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

/**
 * A fake repository over an in-memory store of `project_tags` rows, honouring the definition /
 * assignment split by nullability. `knownProjectIds` is the set the fake `ProjectsRepository`
 * resolves inside `ORG`; a project outside it (or a foreign tenant) does not resolve — the trap.
 */
function build(knownProjectIds: readonly string[] = [PROJECT]): {
  controller: ProjectTagsController;
  store: ProjectTagRow[];
} {
  const store: ProjectTagRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const repository = {
    listDefinitions: async (_r: unknown, ctx: TenantContext) =>
      store
        .filter((row) => row.organizationId === ctx.organizationId && row.projectId === null)
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
    findDefinition: async (_r: unknown, ctx: TenantContext, tagId: string) =>
      store.find(
        (row) =>
          row.id === tagId && row.organizationId === ctx.organizationId && row.projectId === null,
      ) ?? null,
    findDefinitionByName: async (_r: unknown, ctx: TenantContext, name: string) =>
      store.find(
        (row) =>
          row.name === name && row.organizationId === ctx.organizationId && row.projectId === null,
      ) ?? null,
    createDefinition: async (_r: unknown, ctx: TenantContext, name: string) => {
      const row = {
        id: `tag-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: null,
        tagId: null,
        name,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectTagRow;
      store.push(row);
      return row;
    },
    listAssignments: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      store.filter(
        (row) => row.organizationId === ctx.organizationId && row.projectId === projectId,
      ),
    findAssignment: async (_r: unknown, ctx: TenantContext, projectId: string, tagId: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.projectId === projectId &&
          row.tagId === tagId,
      ) ?? null,
    createAssignment: async (_r: unknown, ctx: TenantContext, projectId: string, tagId: string) => {
      const row = {
        id: `asg-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId,
        tagId,
        name: null,
        createdAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectTagRow;
      store.push(row);
      return row;
    },
    deleteAssignment: async (_r: unknown, ctx: TenantContext, projectId: string, tagId: string) => {
      const index = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.projectId === projectId &&
          row.tagId === tagId,
      );
      if (index === -1) return false;
      store.splice(index, 1);
      return true;
    },
  } as unknown as ProjectTagsRepository;

  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const service = new ProjectTagsService(database, repository, projects);
  return { controller: new ProjectTagsController(service), store };
}

describe('ProjectTagsController define → assign → list → remove', () => {
  it('defines a tag, assigns it to a project, lists it, and removes it', async () => {
    const { controller } = build();
    const tag = await controller.define(context, { name: 'Priority' });
    expect(tag.name).toBe('Priority');
    expect((tag as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const assigned = await controller.assign(context, owner, PROJECT, tag.id);
    expect(assigned.projectId).toBe(PROJECT);
    expect(assigned.tagId).toBe(tag.id);
    expect(assigned.name).toBe('Priority');

    const listed = await controller.listForProject(context, owner, PROJECT);
    expect(listed.tags.map((t) => t.tagId)).toEqual([tag.id]);

    await controller.remove(context, owner, PROJECT, tag.id);
    const afterRemove = await controller.listForProject(context, owner, PROJECT);
    expect(afterRemove.tags).toHaveLength(0);
  });

  it('rejects a duplicate tag name with a 409', async () => {
    const { controller } = build();
    await controller.define(context, { name: 'Dup' });
    await expect(controller.define(context, { name: 'Dup' })).rejects.toEqual(
      expect.objectContaining({ status: 409, code: 'conflict' }),
    );
  });

  it('is idempotent: assigning an already-present tag returns the existing row, not a duplicate', async () => {
    const { controller, store } = build();
    const tag = await controller.define(context, { name: 'Once' });
    const first = await controller.assign(context, owner, PROJECT, tag.id);
    const second = await controller.assign(context, owner, PROJECT, tag.id);
    expect(second.id).toBe(first.id);
    expect(store.filter((row) => row.projectId === PROJECT)).toHaveLength(1);
  });
});

describe('the required refusal: cross-tenant / unrelated project is a 404 with no insert', () => {
  it('assigning to a project in another tenant is a 404 and writes nothing', async () => {
    // The project is unknown inside ORG (it belongs to another tenant), so it does not resolve.
    const { controller, store } = build();
    const tag = await controller.define(context, { name: 'Leak?' });
    const before = store.length;
    await expect(controller.assign(context, owner, UNKNOWN_PROJECT, tag.id)).rejects.toEqual(
      expect.objectContaining({ status: 404, code: 'not_found' }),
    );
    expect(store).toHaveLength(before);
  });

  it('an unknown tag on a real project is a 404 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.assign(context, owner, PROJECT, 'tag-0000-0000-0000-0000000000ff'),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });

  it('a manager not related to the project gets 404, never a 403 that confirms it exists', async () => {
    const { controller, store } = build();
    const tag = await controller.define(context, { name: 'NotMine' });
    await expect(controller.assign(context, managerElsewhere, PROJECT, tag.id)).rejects.toEqual(
      expect.objectContaining({ status: 404 }),
    );
    expect(store.filter((row) => row.projectId === PROJECT)).toHaveLength(0);
  });
});

describe('the route ceilings the CapabilityGuard enforces', () => {
  it('requires project.manage to write and work.read to read', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectTagsController.prototype.define)).toBe('project.manage');
    expect(cap(ProjectTagsController.prototype.assign)).toBe('project.manage');
    expect(cap(ProjectTagsController.prototype.remove)).toBe('project.manage');
    expect(cap(ProjectTagsController.prototype.list)).toBe('work.read');
    expect(cap(ProjectTagsController.prototype.listForProject)).toBe('work.read');
  });
});
