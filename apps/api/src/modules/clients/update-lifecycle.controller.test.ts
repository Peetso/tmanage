import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { PortalService } from './portal.service.js';
import { UpdateLifecycleController } from './update-lifecycle.controller.js';
import type { ProjectsRepository } from '../projects/projects.repository.js';
import { ProjectUpdatesRepository } from './project-updates.repository.js';
import type {
  EditProjectUpdateInput,
  ListProjectUpdatesOptions,
  SetProjectUpdatePublishedInput,
} from './project-updates.repository.js';
import type { WorkItemsRepository } from '../work/work-items.repository.js';
import type { ClientProjectionsRepository } from '../approvals/client-projections.repository.js';
import type { FileAssetsRepository } from '../files/file-assets.repository.js';
import type { ProjectRow, ProjectUpdateRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * x201 — the portal update edit/unpublish lifecycle, over fakes with the **real** `authorize()`.
 *
 * The fakes stand in only for the database, the projects repository and the updates store; the
 * policy is real, so these cases prove the actual security decisions the brief names: an edit
 * persists title/body (and nothing else), an unpublish drops the row from the client projection,
 * a cross-tenant / cross-project id is a 404 with no write, and a client principal — who never
 * holds `project.manage` — cannot edit. The client → 403 route-ceiling is pinned by the
 * capability-metadata block below (the guard the chain exercises live). No DB in this suite.
 */

const ORG = 'org-under-test';
const CLIENT_ORG = 'client-org-under-test';
const INTERNAL_USER = 'user-internal-1';
const PROJECT = 'project-visible';
const OTHER_PROJECT = 'project-other';

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

function clientPrincipal(readableProjectId: string): Principal {
  return {
    userId: 'client-user-1',
    organizationId: ORG,
    kind: 'client',
    role: 'client_viewer',
    membershipId: 'membership-client-1',
    membershipStatus: 'active',
    clientOrganizationId: CLIENT_ORG,
    projectIds: [readableProjectId],
    hasOrgWideScope: false,
  };
}

const context = { organizationId: ORG, userId: INTERNAL_USER } as unknown as TenantContext;
const clientContext = { organizationId: ORG, userId: 'client-user-1' } as unknown as TenantContext;

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

/** A stateful updates store honouring the tenant/project/published gates the real repo does. */
function fakeUpdates(seed: readonly ProjectUpdateRow[] = []): {
  repo: ProjectUpdatesRepository;
  rows: ProjectUpdateRow[];
} {
  const rows: ProjectUpdateRow[] = [...seed];
  const repo = Object.assign(new ProjectUpdatesRepository(), {
    findById: (_r: never, _c: TenantContext, id: string) =>
      Promise.resolve(rows.find((row) => row.id === id) ?? null),
    list: (_r: never, _c: TenantContext, options: ListProjectUpdatesOptions) =>
      Promise.resolve(
        rows.filter(
          (row) => row.projectId === options.projectId && (!options.publishedOnly || row.published),
        ),
      ),
    updateContent: (_r: never, _c: TenantContext, input: EditProjectUpdateInput) => {
      const row = rows.find(
        (candidate) => candidate.id === input.updateId && candidate.projectId === input.projectId,
      );
      if (!row) return Promise.resolve(null);
      if (input.title !== undefined) row.title = input.title;
      if (input.body !== undefined) row.body = input.body;
      row.updatedAt = new Date('2026-10-02T00:00:00.000Z');
      return Promise.resolve(row);
    },
    setPublished: (_r: never, _c: TenantContext, input: SetProjectUpdatePublishedInput) => {
      const row = rows.find(
        (candidate) => candidate.id === input.updateId && candidate.projectId === input.projectId,
      );
      if (!row) return Promise.resolve(null);
      row.published = input.published;
      row.updatedAt = new Date('2026-10-02T00:00:00.000Z');
      return Promise.resolve(row);
    },
  }) as unknown as ProjectUpdatesRepository;
  return { repo, rows };
}

function updateRow(overrides: Partial<ProjectUpdateRow> & { id: string }): ProjectUpdateRow {
  return {
    organizationId: ORG,
    projectId: PROJECT,
    title: 'Original title',
    body: 'Original body',
    published: true,
    createdByUserId: INTERNAL_USER,
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
    ...overrides,
  } as ProjectUpdateRow;
}

function serviceFor(
  existingProjects: readonly string[],
  updates: ReturnType<typeof fakeUpdates>,
): PortalService {
  return new PortalService(
    fakeDatabase(),
    fakeProjects(existingProjects),
    {} as unknown as WorkItemsRepository,
    {} as unknown as ClientProjectionsRepository,
    {} as unknown as FileAssetsRepository,
    updates.repo,
  );
}

describe('PortalService update lifecycle (x201)', () => {
  it('edits title and body, advances updatedAt, and touches nothing else', async () => {
    const store = fakeUpdates([updateRow({ id: 'u-1' })]);
    const service = serviceFor([PROJECT], store);

    const edited = await service.editUpdate(context, internalManager(), {
      projectId: PROJECT,
      updateId: 'u-1',
      title: 'Edited title',
      body: 'Edited body',
    });

    expect(edited).toMatchObject({
      id: 'u-1',
      title: 'Edited title',
      body: 'Edited body',
      published: true,
    });
    // The edit persisted to the row and advanced updatedAt past createdAt.
    expect(store.rows[0]?.title).toBe('Edited title');
    expect(new Date(edited.updatedAt).getTime()).toBeGreaterThan(
      new Date(edited.createdAt).getTime(),
    );
    // Authorship is never rewritten by an edit.
    expect(store.rows[0]?.createdByUserId).toBe(INTERNAL_USER);
  });

  it('unpublish drops the update from the client projection', async () => {
    const store = fakeUpdates([updateRow({ id: 'u-1', published: true })]);
    const service = serviceFor([PROJECT], store);

    // Published: the client can see it.
    const before = await service.updatesFor(clientContext, clientPrincipal(PROJECT), PROJECT);
    expect(before.map((u) => u.id)).toEqual(['u-1']);

    await service.unpublishUpdate(context, internalManager(), {
      projectId: PROJECT,
      updateId: 'u-1',
    });

    // Unpublished: the client read (published-only query predicate) no longer returns it.
    const after = await service.updatesFor(clientContext, clientPrincipal(PROJECT), PROJECT);
    expect(after).toEqual([]);
    expect(store.rows[0]?.published).toBe(false);
  });

  it('answers 404 and writes nothing for an unknown or cross-project update id', async () => {
    // An update that belongs to OTHER_PROJECT; the route names PROJECT.
    const store = fakeUpdates([updateRow({ id: 'u-other', projectId: OTHER_PROJECT })]);
    const service = serviceFor([PROJECT, OTHER_PROJECT], store);

    await expect(
      service.editUpdate(context, internalManager(), {
        projectId: PROJECT,
        updateId: 'u-other',
        title: 'X',
      }),
    ).rejects.toMatchObject({ status: 404 });
    // Unknown id entirely.
    await expect(
      service.unpublishUpdate(context, internalManager(), {
        projectId: PROJECT,
        updateId: 'u-nope',
      }),
    ).rejects.toMatchObject({ status: 404 });

    // Nothing changed on the untouched row.
    expect(store.rows[0]).toMatchObject({ title: 'Original title', published: true });
  });

  it('answers 404 and writes nothing when the caller cannot manage the project (client audience)', async () => {
    const store = fakeUpdates([updateRow({ id: 'u-1' })]);
    const service = serviceFor([PROJECT], store);

    // A client principal never holds project.manage; the project resolves, authorize denies.
    await expect(
      service.editUpdate(context, clientPrincipal(PROJECT), {
        projectId: PROJECT,
        updateId: 'u-1',
        body: 'client edit attempt',
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(store.rows[0]?.body).toBe('Original body');
  });
});

/**
 * The route-ceiling that produces the client → 403. A client role never holds `project.manage`,
 * so `CapabilityGuard` refuses both lifecycle routes with 403 before the handler runs — the guard
 * reads exactly the `@RequireCapability` metadata asserted here. The live round-trip is the chain's.
 */
describe('update lifecycle route capabilities', () => {
  const capabilityOf = (proto: object, key: string): unknown =>
    Reflect.getMetadata(REQUIRED_CAPABILITY, (proto as Record<string, unknown>)[key] as object);

  it('guards edit and unpublish with project.manage', () => {
    expect(capabilityOf(UpdateLifecycleController.prototype, 'edit')).toBe('project.manage');
    expect(capabilityOf(UpdateLifecycleController.prototype, 'unpublish')).toBe('project.manage');
  });
});
