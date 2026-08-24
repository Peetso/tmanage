import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { ProjectView, ProjectsService } from './projects.service.js';

/**
 * The first tenant-scoped endpoints, and the thing that proves the pipeline runs in order.
 *
 * Note what this controller does **not** do. It does not read `organizationId` from anywhere —
 * not the body, not a header, not even the `:orgSlug` in its own path. It receives a
 * `TenantContext` that `TenantContextGuard` built from a membership row, and passes it on.
 * `25-AUTH-AND-TENANT-ISOLATION` §2 requires exactly that, and the shape of `CreateProjectBody`
 * is what makes it structural: there is no field for a tenant, so there is nothing for a
 * caller to supply and nothing for a handler to prefer over the context.
 *
 * The `:orgSlug` segment is in the path because it is the claim under test — the guard needs
 * something to resolve — and it is never used again after that resolution.
 */

interface CreateProjectBody {
  readonly workspaceId?: unknown;
  readonly name?: unknown;
}

@Controller('v1/organizations/:orgSlug/projects')
export class ProjectsController {
  constructor(@Inject(PROJECTS_SERVICE) private readonly projects: ProjectsService) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly projects: readonly ProjectView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      projects: await this.projects.list(context, principal, {
        ...(after ? { after } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Get(':projectId')
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ProjectView> {
    return this.projects.get(context, principal, projectId);
  }

  @Post()
  @RequireCapability('project.create')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @Body() body: CreateProjectBody,
  ): Promise<ProjectView> {
    const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined;
    const name = typeof body?.name === 'string' ? body.name.trim() : undefined;

    const details = [
      ...(workspaceId ? [] : [{ field: 'workspaceId', message: 'must be a string' }]),
      ...(name ? [] : [{ field: 'name', message: 'must be a non-empty string' }]),
    ];
    if (!workspaceId || !name) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    // The workspace is not checked against the tenant here, and that is not an omission:
    // `fk_projects_workspace_tenant` is a composite foreign key including `organization_id`,
    // so the database refuses a workspace from another organization. See
    // `ProjectsRepository.create`.
    return this.projects.create(context, { workspaceId, name });
  }
}
