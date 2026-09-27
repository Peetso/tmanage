import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_ACTIVITY_LOG_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_ACTIVITY_PAGE,
  type WorkActivityEntryView,
  type WorkActivityLogService,
} from './activity-log.service.js';

/**
 * x291's HTTP surface — a work item's merged activity timeline (Work module 7).
 *
 * A sub-resource of the work item, the way `:workItemId/comments` and `:workItemId/watchers` are:
 * the parent id is in the path, and the service resolves it tenant-scoped before it authorizes or
 * reads a single source row. This controller reads no `organizationId` from anywhere —
 * `TenantContextGuard` built the `TenantContext` from a membership row.
 *
 * The gate is `work.read`: a member who may read the item may read its history. The route is
 * read-only — there is no write path here, and no new capability. `limit` is bounded at the
 * boundary (a value outside `[1, MAX_ACTIVITY_PAGE]`, or a non-integer, is a 400 rather than a
 * silent clamp), and the service clamps defensively as well.
 */
@Controller('v1/organizations/:orgSlug/work-items/:workItemId/activity')
export class WorkActivityLogController {
  constructor(
    @Inject(WORK_ACTIVITY_LOG_SERVICE) private readonly activity: WorkActivityLogService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly activity: readonly WorkActivityEntryView[] }> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (
      parsedLimit !== undefined &&
      (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_ACTIVITY_PAGE)
    ) {
      throw new ApiError(400, 'validation_failed', 'The query is invalid', [
        { field: 'limit', message: `must be an integer between 1 and ${MAX_ACTIVITY_PAGE}` },
      ]);
    }

    return {
      activity: await this.activity.list(context, principal, workItemId, {
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    };
  }
}
