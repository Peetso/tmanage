import { describe, expect, it } from 'vitest';
import type { Principal } from '@tmanage/domain';
import { ApiError } from '../../common/http/errors.js';
import {
  MyFavoritesController,
  ProjectFavoriteController,
} from './project-favorites.controller.js';
import { ProjectFavoritesService } from './project-favorites.service.js';
import type {
  FavoriteProjectRow,
  ProjectFavoritesRepository,
} from './project-favorites.repository.js';
import type { ProjectsRepository } from './projects.repository.js';
import type { ProjectFavoriteRow, ProjectRow } from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';

/**
 * PROJ project favorites (x268) controller/service proofs over the module's fakes, with the **real**
 * `authorize`. The migration and the tenant-scoped SQL round-trip are proven in the DB suite (the
 * chain owns it); here the subject is the logic: star/unstar self and list own, a duplicate PUT is
 * idempotent, the Known-trap cross-tenant 404 (no write — the required refusal proof), and the
 * authorize refusal (a non-member is not-found, never forbidden — the reason the service masks it).
 */

const ORG = 'organization-0000-0000-0000-000000000001';
const OTHER_ORG = 'organization-0000-0000-0000-000000000002';
const PROJECT = 'project-0000-0000-0000-0000-000000000001';
const USER = 'user-0000-0000-0000-0000-000000000001';
const MEMBERSHIP = 'membership-0000-0000-000000000001';

function owner(): Principal {
  return {
    userId: USER,
    organizationId: ORG,
    kind: 'internal',
    role: 'owner',
    membershipId: MEMBERSHIP,
    membershipStatus: 'active',
    clientOrganizationId: null,
    projectIds: [],
    hasOrgWideScope: true,
  };
}

const context = {
  organizationId: ORG,
  userId: USER,
  membershipId: MEMBERSHIP,
} as unknown as TenantContext;

/** A controller pair whose project lookup is scoped to `projectOrg`; favorites live in an in-memory store. */
function controllersWith(projectOrg = ORG): {
  fav: ProjectFavoriteController;
  mine: MyFavoritesController;
  store: ProjectFavoriteRow[];
} {
  const store: ProjectFavoriteRow[] = [];
  let seq = 0;
  const database = {
    read: async (_c: unknown, work: (db: unknown) => Promise<unknown>) => work({}),
    transaction: async (_c: unknown, work: (tx: unknown) => Promise<unknown>) => work({}),
  } as unknown as TenantDatabase;

  const projectsRepo = {
    findById: async (_r: unknown, ctx: TenantContext, id: string) =>
      id === PROJECT && projectOrg === ctx.organizationId
        ? ({
            id: PROJECT,
            organizationId: ctx.organizationId,
            name: 'Rebrand',
            status: 'active',
          } as ProjectRow)
        : null,
  } as unknown as ProjectsRepository;

  const favorites = {
    find: async (_r: unknown, ctx: TenantContext, projectId: string, membershipId: string) =>
      store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.projectId === projectId &&
          row.membershipId === membershipId,
      ) ?? null,
    add: async (
      _r: unknown,
      ctx: TenantContext,
      input: { projectId: string; membershipId: string },
    ) => {
      const existing = store.find(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.projectId === input.projectId &&
          row.membershipId === input.membershipId,
      );
      if (existing) {
        return existing;
      }
      const row = {
        id: `favorite-0000-0000-0000-0000000000${++seq}`,
        organizationId: ctx.organizationId,
        projectId: input.projectId,
        membershipId: input.membershipId,
        createdAt: new Date(),
      } as ProjectFavoriteRow;
      store.push(row);
      return row;
    },
    remove: async (_r: unknown, ctx: TenantContext, projectId: string, membershipId: string) => {
      const index = store.findIndex(
        (row) =>
          row.organizationId === ctx.organizationId &&
          row.projectId === projectId &&
          row.membershipId === membershipId,
      );
      if (index >= 0) {
        store.splice(index, 1);
      }
    },
    listForMember: async (
      _r: unknown,
      ctx: TenantContext,
      membershipId: string,
    ): Promise<readonly FavoriteProjectRow[]> =>
      store
        .filter(
          (row) => row.organizationId === ctx.organizationId && row.membershipId === membershipId,
        )
        .sort((a, b) => b.id.localeCompare(a.id))
        .map((row) => ({
          id: row.id,
          projectId: row.projectId,
          name: 'Rebrand',
          status: 'active',
          createdAt: row.createdAt,
        })),
  } as unknown as ProjectFavoritesRepository;

  const service = new ProjectFavoritesService(database, projectsRepo, favorites);
  return {
    fav: new ProjectFavoriteController(service),
    mine: new MyFavoritesController(service),
    store,
  };
}

describe('ProjectFavorites', () => {
  it('stars self idempotently, reports status, lists own, and never echoes the tenant id', async () => {
    const { fav, mine, store } = controllersWith();
    const caller = owner();

    const first = await fav.add(context, caller, PROJECT);
    const again = await fav.add(context, caller, PROJECT);
    expect(again.id).toBe(first.id);
    expect(store).toHaveLength(1);
    expect(first).not.toHaveProperty('organizationId');
    expect(first).not.toHaveProperty('membershipId');

    expect(await fav.status(context, caller, PROJECT)).toEqual({ favorited: true });

    const listed = await mine.list(context, caller);
    expect(listed.favorites.map((f) => f.projectId)).toEqual([PROJECT]);
    expect(listed.favorites[0]?.name).toBe('Rebrand');
  });

  it('unstars self idempotently', async () => {
    const { fav, store } = controllersWith();
    const caller = owner();
    await fav.add(context, caller, PROJECT);
    await fav.remove(context, caller, PROJECT);
    expect(store).toHaveLength(0);
    // A second unstar is still success (no row → no-op), not a 404.
    await fav.remove(context, caller, PROJECT);
    expect(await fav.status(context, caller, PROJECT)).toEqual({ favorited: false });
  });

  it('does not list another membership’s favorites', async () => {
    const { fav, mine } = controllersWith();
    await fav.add(context, owner(), PROJECT);
    const otherContext = {
      organizationId: ORG,
      userId: 'user-0000-0000-0000-0000-000000000002',
      membershipId: 'membership-0000-0000-000000000002',
    } as unknown as TenantContext;
    const otherCaller: Principal = {
      ...owner(),
      membershipId: 'membership-0000-0000-000000000002',
    };
    const listed = await mine.list(otherContext, otherCaller);
    expect(listed.favorites).toHaveLength(0);
  });

  it('reads a cross-tenant project id as not-found (404) and writes nothing', async () => {
    // The refusal proof the brief requires: favoriting a project in another tenant is a 404, no insert.
    const { fav, store } = controllersWith(OTHER_ORG);
    const error = await fav.add(context, owner(), PROJECT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });

  it('denies a non-member without project scope (masked 404) and writes nothing', async () => {
    // The project lives in a project the caller does not belong to and they have no org-wide scope, so
    // the real `authorize` denies `work.read`. The service masks the denial as not-found, never 403: a
    // 403 would confirm the project exists, which a non-member must not be able to probe.
    const { fav, store } = controllersWith();
    const stranger: Principal = {
      ...owner(),
      role: 'member',
      hasOrgWideScope: false,
      projectIds: [],
    };
    const error = await fav.add(context, stranger, PROJECT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(404);
    expect(store).toHaveLength(0);
  });
});
