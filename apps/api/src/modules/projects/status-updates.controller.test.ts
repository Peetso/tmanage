import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { REQUIRED_CAPABILITY } from '../../common/http/decorators.js';
import { ProjectStatusUpdatesController } from './status-updates.controller.js';
import { ProjectStatusUpdatesService } from './status-updates.service.js';
import type { ProjectStatusUpdatesRepository } from './status-updates.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { ProjectStatusUpdateRow } from '../../common/database/schema.js';

/**
 * PROJ / module 8 (x235). The internal status-update controller over the module's fakes with the
 * **real** `authorize()` evaluator. The migration and the tenant-scoped SQL round-trip are proven in
 * the DB suites (out of this build's scope); here the subject is the controller + service logic: the
 * post → list round-trip; the Known-trap (unknown/cross-tenant `projectId` ⇒ 404, never a foreign-key
 * 500); the enum validation (unknown band ⇒ 400); the relation gate (a non-member earns not-found);
 * and the `project.manage` ceiling the `CapabilityGuard` enforces on every route.
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

const owner = principal('owner', [], true);
const managerElsewhere = principal('manager', []);
const context = { organizationId: ORG, userId: USER } as unknown as TenantContext;

function build(knownProjectIds: readonly string[] = [PROJECT]): {
  controller: ProjectStatusUpdatesController;
  store: ProjectStatusUpdateRow[];
} {
  const store: ProjectStatusUpdateRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;
  const repository = {
    list: async (_r: unknown, ctx: TenantContext, options: { readonly projectId: string }) =>
      store
        .filter(
          (row) => row.projectId === options.projectId && row.organizationId === ctx.organizationId,
        )
        .sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime()),
    create: async (
      _r: unknown,
      ctx: TenantContext,
      input: {
        readonly projectId: string;
        readonly statusBand: ProjectStatusUpdateRow['statusBand'];
        readonly body: string;
        readonly postedBy: string;
      },
    ) => {
      const row = {
        id: `update-0000-0000-0000-0000-00000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        statusBand: input.statusBand,
        body: input.body,
        postedBy: input.postedBy,
        postedAt: new Date(Date.UTC(2026, 0, seq)),
      } as ProjectStatusUpdateRow;
      store.push(row);
      return row;
    },
  } as unknown as ProjectStatusUpdatesRepository;
  const projects = {
    findById: async (_r: unknown, ctx: TenantContext, projectId: string) =>
      knownProjectIds.includes(projectId) && ctx.organizationId === ORG
        ? ({ id: projectId } as unknown)
        : null,
  } as unknown as ProjectsRepository;

  const service = new ProjectStatusUpdatesService(database, repository, projects);
  return { controller: new ProjectStatusUpdatesController(service), store };
}

describe('ProjectStatusUpdatesController post → list', () => {
  it('posts an update, then lists it (organizationId never echoed)', async () => {
    const { controller } = build();
    const posted = await controller.create(context, owner, PROJECT, {
      statusBand: 'at_risk',
      body: 'Vendor slipped a week; recovering.',
    });
    expect(posted.statusBand).toBe('at_risk');
    expect((posted as unknown as Record<string, unknown>)['organizationId']).toBeUndefined();

    const page = await controller.list(context, owner, PROJECT);
    expect(page.updates.map((u) => u.id)).toEqual([posted.id]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('validation and the Known-trap', () => {
  it('rejects an unknown status band with a 400 and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, PROJECT, {
        statusBand: 'exploding' as unknown as 'at_risk',
        body: 'x',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 400, code: 'validation_failed' }));
    expect(store).toHaveLength(0);
  });

  it('rejects an empty body with a 400', async () => {
    const { controller } = build();
    await expect(
      controller.create(context, owner, PROJECT, { statusBand: 'on_track', body: '   ' }),
    ).rejects.toEqual(expect.objectContaining({ status: 400 }));
  });

  it('a post against an unknown/cross-tenant project is a 404, not a 500, and writes nothing', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, owner, UNKNOWN_PROJECT, {
        statusBand: 'on_track',
        body: 'orphan',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404, code: 'not_found' }));
    expect(store).toHaveLength(0);
  });
});

describe('the relation gate (real authorize)', () => {
  it('a manager not related to the project gets not-found, never a 403 that confirms it exists', async () => {
    const { controller, store } = build();
    await expect(
      controller.create(context, managerElsewhere, PROJECT, {
        statusBand: 'on_track',
        body: 'nope',
      }),
    ).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(store).toHaveLength(0);
  });
});

describe('the route ceiling the CapabilityGuard enforces', () => {
  it('requires project.manage to post and to list', () => {
    const cap = (method: unknown) => Reflect.getMetadata(REQUIRED_CAPABILITY, method as object);
    expect(cap(ProjectStatusUpdatesController.prototype.create)).toBe('project.manage');
    expect(cap(ProjectStatusUpdatesController.prototype.list)).toBe('project.manage');
  });
});
