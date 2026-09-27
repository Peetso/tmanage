import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { PROJECT_TAGS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ProjectTagAssignmentView,
  ProjectTagView,
  ProjectTagsService,
} from './project-tags.service.js';

/**
 * x267's HTTP surface — project tags / labels (Projects / portfolio module).
 *
 * Two shapes of resource on one controller, the `WorkLabelsController` (x233) pattern. Tag
 * *definitions* are org-scoped (`…/projects/tags`); a tag *assignment* is a sub-resource of a project
 * (`…/projects/:projectId/tags`), with the project id in the path so the service resolves it
 * tenant-scoped before it authorizes or writes (Known-trap). The route capability is coarse
 * (`work.read` to list, `project.manage` to define / assign / remove) — a role without the ceiling is
 * a 403 the `CapabilityGuard` produces before this handler runs; the row-level, relation-scoped
 * decision (and the 404 for a cross-tenant or unrelated project) is the service's. Like every
 * tenant-scoped controller here, it never reads `organizationId` from the body, a header, or its own
 * `:orgSlug` segment: it passes on the `TenantContext` that `TenantContextGuard` built.
 */

interface DefineTagBody {
  readonly name?: unknown;
}

@Controller('v1/organizations/:orgSlug')
export class ProjectTagsController {
  constructor(@Inject(PROJECT_TAGS_SERVICE) private readonly tags: ProjectTagsService) {}

  @Get('projects/tags')
  @RequireCapability('work.read')
  async list(@Ctx() context: TenantContext): Promise<{ readonly tags: readonly ProjectTagView[] }> {
    return { tags: await this.tags.listDefinitions(context) };
  }

  @Post('projects/tags')
  @RequireCapability('project.manage')
  @HttpCode(201)
  async define(
    @Ctx() context: TenantContext,
    @Body() body: DefineTagBody,
  ): Promise<ProjectTagView> {
    return this.tags.define(context, body?.name as string);
  }

  @Get('projects/:projectId/tags')
  @RequireCapability('work.read')
  async listForProject(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<{ readonly tags: readonly ProjectTagAssignmentView[] }> {
    return {
      tags: await this.tags.listForProject(context, principal, requiredId(projectId, 'projectId')),
    };
  }

  @Put('projects/:projectId/tags/:tagId')
  @RequireCapability('project.manage')
  async assign(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('tagId') tagId: string,
  ): Promise<ProjectTagAssignmentView> {
    return this.tags.assign(
      context,
      principal,
      requiredId(projectId, 'projectId'),
      requiredId(tagId, 'tagId'),
    );
  }

  @Delete('projects/:projectId/tags/:tagId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
    @Param('tagId') tagId: string,
  ): Promise<void> {
    await this.tags.remove(
      context,
      principal,
      requiredId(projectId, 'projectId'),
      requiredId(tagId, 'tagId'),
    );
  }
}

function requiredId(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      { field, message: 'must be a non-empty string' },
    ]);
  }
  return raw.trim();
}
