import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_DEPENDENCIES_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ProjectDependenciesService,
  ProjectDependencyGraph,
  ProjectDependencyView,
} from './dependencies.service.js';

/**
 * PROJ / cross-project dependencies (x309). The directed edges between whole projects: record that
 * one project blocks another, list a project's dependency graph, and remove an edge.
 *
 * Nested under `…/projects/:projectId/dependencies`, so the project is named in the path and the
 * service resolves it (for the relation gate) tenant-scoped before it authorizes or writes
 * (Known-trap). Every route is gated on `project.manage`. Like every tenant-scoped controller here,
 * it never reads `organizationId` from the body, a header, or its own `:orgSlug` segment: it
 * receives the `TenantContext` `TenantContextGuard` built and passes it on.
 */

interface CreateProjectDependencyBody {
  readonly blockedProjectId?: unknown;
  readonly note?: unknown;
}

function requireId(value: string, field: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new ApiError(400, 'validation_failed', `${field} is required`, [
      { field, message: 'must be a non-empty string' },
    ]);
  }
}

@Controller('v1/organizations/:orgSlug/projects/:projectId/dependencies')
export class ProjectDependenciesController {
  constructor(
    @Inject(PROJECT_DEPENDENCIES_SERVICE)
    private readonly dependencies: ProjectDependenciesService,
  ) {}

  @Get()
  @RequireCapability('project.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Query('limit') limit?: string,
  ): Promise<ProjectDependencyGraph> {
    requireId(projectId, 'projectId');

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return this.dependencies.list(context, principal, {
      projectId,
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
    });
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Body() body: CreateProjectDependencyBody,
  ): Promise<ProjectDependencyView> {
    requireId(projectId, 'projectId');
    const blockedProjectId =
      typeof body?.blockedProjectId === 'string' ? body.blockedProjectId.trim() : '';
    if (blockedProjectId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'blockedProjectId', message: 'must be a non-empty string' },
      ]);
    }
    if (body?.note !== undefined && body.note !== null && typeof body.note !== 'string') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'note', message: 'must be a string' },
      ]);
    }

    return this.dependencies.create(context, principal, {
      blockerProjectId: projectId,
      blockedProjectId,
      note: typeof body?.note === 'string' ? body.note : null,
    });
  }

  @Delete(':blockedProjectId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('blockedProjectId') blockedProjectId: string,
  ): Promise<void> {
    requireId(projectId, 'projectId');
    requireId(blockedProjectId, 'blockedProjectId');
    await this.dependencies.remove(context, principal, projectId, blockedProjectId);
  }
}
