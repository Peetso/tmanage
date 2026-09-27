import { Controller, Delete, Get, HttpCode, Inject, Module, Param, Put } from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { ProjectFavoritesService } from './project-favorites.service.js';
import type { ProjectFavoriteView } from './project-favorites.service.js';

/**
 * PROJ project favorites (x268). Star a project, unstar it, read the caller's favorite status of one
 * project, and list the caller's favorites for the compact project switcher. Like every tenant-scoped
 * controller here it never reads `organizationId` (or the acting membership) from the body, a header,
 * or its `:orgSlug` segment: it receives the `TenantContext` that `TenantContextGuard` built from a
 * membership row and passes it on. Every route is `work.read` — a member favorites a project they may
 * read (own-principal).
 *
 * The per-project toggle lives under `projects/:projectId/favorite`; the caller's list lives at
 * `projects/favorites`. The two never collide: `projects/favorites` is a static one-segment route and
 * `projects/:projectId/favorite` is a two-segment parametric route, and Fastify's router matches the
 * static segment ahead of any `:projectId` sibling. Both controllers live in their own module
 * (registered in `app.module.ts`) so the slice touches no file another projects slice appends to.
 */

const PROJECT_FAVORITES_SERVICE = Symbol.for('tmanage.ProjectFavoritesService');

@Controller('v1/organizations/:orgSlug/projects/:projectId/favorite')
export class ProjectFavoriteController {
  constructor(
    @Inject(PROJECT_FAVORITES_SERVICE) private readonly favorites: ProjectFavoritesService,
  ) {}

  /** Whether the caller has favorited this project. `work.read`; the project is resolved readable first. */
  @Get()
  @RequireCapability('work.read')
  async status(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly favorited: boolean }> {
    requireProjectId(projectId);
    return this.favorites.status(context, principal, projectId);
  }

  /** Favorite this project for the caller. Idempotent: a repeated PUT returns the same view (200). */
  @Put()
  @RequireCapability('work.read')
  async add(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectFavoriteView> {
    requireProjectId(projectId);
    return this.favorites.add(context, principal, projectId);
  }

  /** Unfavorite this project for the caller. Idempotent: no favorite is still 204. */
  @Delete()
  @RequireCapability('work.read')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<void> {
    requireProjectId(projectId);
    await this.favorites.remove(context, principal, projectId);
  }
}

@Controller('v1/organizations/:orgSlug/projects/favorites')
export class MyFavoritesController {
  constructor(
    @Inject(PROJECT_FAVORITES_SERVICE) private readonly favorites: ProjectFavoritesService,
  ) {}

  /** List the caller's favorites, newest first, projected to projects the caller can still read. */
  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ readonly favorites: readonly ProjectFavoriteView[] }> {
    return { favorites: await this.favorites.list(context, principal) };
  }
}

/** A path `projectId` is always required and always a non-empty string. */
function requireProjectId(projectId: unknown): asserts projectId is string {
  if (typeof projectId !== 'string' || projectId === '') {
    throw new ApiError(400, 'validation_failed', 'projectId is required', [
      { field: 'projectId', message: 'must be a non-empty string' },
    ]);
  }
}

/**
 * PROJ project favorites (x268). The module that wires both controllers and their shared service.
 * Registered in `app.module.ts` rather than folded into `ProjectsModule`, so this slice touches no
 * file another projects slice in the same pass appends to.
 */
@Module({})
export class ProjectFavoritesModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: PROJECT_FAVORITES_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) => new ProjectFavoritesService(database),
    };

    return {
      module: ProjectFavoritesModule,
      providers: [service],
      controllers: [ProjectFavoriteController, MyFavoritesController],
    };
  }
}
