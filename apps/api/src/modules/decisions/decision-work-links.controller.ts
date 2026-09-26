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
import { DECISION_WORK_LINKS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  DecisionWorkLinkView,
  DecisionWorkLinksService,
} from './decision-work-links.service.js';

/**
 * DEC / module 12 (x149). The edges from a decision to the work it drives: link, list, unlink.
 *
 * Nested under `…/decisions/:decisionId/work-links`, so the decision is named in the path and the
 * service resolves it tenant-scoped (and its project, for the relation gate) before it authorizes or
 * writes (Known-trap). Gated on `meeting.write` for the writes — the decision register's write
 * capability — and `work.read` for the list. Like every tenant-scoped controller here, it never reads
 * `organizationId` from the body, a header, or its own `:orgSlug` segment: it receives the
 * `TenantContext` `TenantContextGuard` built and passes it on.
 */

interface CreateWorkLinkBody {
  readonly workItemId?: unknown;
}

@Controller('v1/organizations/:orgSlug/decisions/:decisionId/work-links')
export class DecisionWorkLinksController {
  constructor(
    @Inject(DECISION_WORK_LINKS_SERVICE) private readonly links: DecisionWorkLinksService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly workLinks: readonly DecisionWorkLinkView[] }> {
    if (typeof decisionId !== 'string' || decisionId === '') {
      throw new ApiError(400, 'validation_failed', 'decisionId is required', [
        { field: 'decisionId', message: 'must be a non-empty string' },
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
        decisionId,
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    };
  }

  @Post()
  @RequireCapability('meeting.write')
  @HttpCode(201)
  async link(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
    @Body() body: CreateWorkLinkBody,
  ): Promise<DecisionWorkLinkView> {
    if (typeof decisionId !== 'string' || decisionId === '') {
      throw new ApiError(400, 'validation_failed', 'decisionId is required', [
        { field: 'decisionId', message: 'must be a non-empty string' },
      ]);
    }
    const workItemId = typeof body?.workItemId === 'string' ? body.workItemId.trim() : '';
    if (workItemId === '') {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
        { field: 'workItemId', message: 'must be a non-empty string' },
      ]);
    }

    return this.links.link(context, principal, { decisionId, workItemId });
  }

  @Delete(':linkId')
  @RequireCapability('meeting.write')
  @HttpCode(204)
  async unlink(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('decisionId') decisionId: string,
    @Param('linkId') linkId: string,
  ): Promise<void> {
    if (typeof decisionId !== 'string' || decisionId === '') {
      throw new ApiError(400, 'validation_failed', 'decisionId is required', [
        { field: 'decisionId', message: 'must be a non-empty string' },
      ]);
    }
    if (typeof linkId !== 'string' || linkId === '') {
      throw new ApiError(400, 'validation_failed', 'linkId is required', [
        { field: 'linkId', message: 'must be a non-empty string' },
      ]);
    }
    await this.links.unlink(context, principal, decisionId, linkId);
  }
}
