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
import { OBJECTIVE_WORK_LINKS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ObjectiveWorkLinkView,
  ObjectiveWorkLinksService,
} from './objective-work-links.service.js';

/**
 * PROJ / module 8 (x138). The edges from a project objective to the work that advances it: link, list,
 * unlink.
 *
 * Nested under `…/objectives/:objectiveId/work-links`, so the objective is named in the path and the
 * service resolves it tenant-scoped (and its project, for the relation gate) before it authorizes or
 * writes (Known-trap). Gated on `project.manage` for the writes and `work.read` for the list. Like
 * every tenant-scoped controller here, it never reads `organizationId` from the body, a header, or its
 * own `:orgSlug` segment: it receives the `TenantContext` `TenantContextGuard` built and passes it on.
 */

interface CreateWorkLinkBody {
  readonly workItemId?: unknown;
}

@Controller('v1/organizations/:orgSlug/objectives/:objectiveId/work-links')
export class ObjectiveWorkLinksController {
  constructor(
    @Inject(OBJECTIVE_WORK_LINKS_SERVICE) private readonly links: ObjectiveWorkLinksService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('objectiveId') objectiveId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly workLinks: readonly ObjectiveWorkLinkView[] }> {
    if (typeof objectiveId !== 'string' || objectiveId === '') {
      throw new ApiError(400, 'validation_failed', 'objectiveId is required', [
        { field: 'objectiveId', message: 'must be a non-empty string' },
      ]);
    }

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    return {
      workLinks: await this.links.list(context, principal, {
        objectiveId,
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('project.manage')
  @HttpCode(201)
  async link(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('objectiveId') objectiveId: string,
    @Body() body: CreateWorkLinkBody,
  ): Promise<ObjectiveWorkLinkView> {
    if (typeof objectiveId !== 'string' || objectiveId === '') {
      throw new ApiError(400, 'validation_failed', 'objectiveId is required', [
        { field: 'objectiveId', message: 'must be a non-empty string' },
      ]);
    }
    const workItemId = typeof body?.workItemId === 'string' ? body.workItemId.trim() : '';
    if (workItemId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'workItemId', message: 'must be a non-empty string' },
      ]);
    }

    return this.links.link(context, principal, { objectiveId, workItemId });
  }

  @Delete(':linkId')
  @RequireCapability('project.manage')
  @HttpCode(204)
  async unlink(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('objectiveId') objectiveId: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    if (typeof objectiveId !== 'string' || objectiveId === '') {
      throw new ApiError(400, 'validation_failed', 'objectiveId is required', [
        { field: 'objectiveId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof linkId !== 'string' || linkId === '') {
      throw new ApiError(400, 'validation_failed', 'linkId is required', [
        { field: 'linkId', message: 'must be a non-empty string' },
      ]);
    }
    await this.links.unlink(context, principal, objectiveId, linkId);
  }
}
