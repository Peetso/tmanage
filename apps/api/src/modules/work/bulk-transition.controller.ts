import { Body, Controller, HttpCode, Inject, Post } from '@nestjs/common';
import { WORK_ITEM_STATES } from '@tmanage/domain';
import type { Principal, WorkItemState } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { BULK_TRANSITION_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_BULK_TRANSITION,
  type BulkTransitionService,
  type BulkTransitionView,
} from './bulk-transition.service.js';

interface BulkTransitionBody {
  readonly ids?: unknown;
  readonly targetStatus?: unknown;
}

/**
 * x206 — the bulk status transition's HTTP surface.
 *
 * A route of its own rather than a flag on the single transition, because the request is
 * different in kind: a set of ids and one target, answered with a per-id outcome instead of
 * one moved row. It shares the single route's tenant prefix and its capability —
 * `work.transition` — so a caller who cannot transition one item cannot transition many, and
 * the guard refuses the whole request with 403 before any id is read.
 *
 * `bulk-transition` is a static segment under `work-items`; it does not collide with the
 * single route's `:workItemId/transitions`, which is two dynamic-then-static segments.
 */
@Controller('v1/organizations/:orgSlug/work-items')
export class BulkTransitionController {
  constructor(@Inject(BULK_TRANSITION_SERVICE) private readonly bulk: BulkTransitionService) {}

  @Post('bulk-transition')
  @RequireCapability('work.transition')
  @HttpCode(200)
  async bulkTransition(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: BulkTransitionBody,
  ): Promise<BulkTransitionView> {
    const details: { field: string; message: string }[] = [];

    const rawIds = Array.isArray(body?.ids) ? body.ids : undefined;
    if (!rawIds) {
      details.push({ field: 'ids', message: 'must be an array of work item ids' });
    }

    // Trim, drop blanks, and de-duplicate. A repeated id in the request is one item, not two,
    // and reporting it twice would let the caller's own duplicate inflate `appliedCount`.
    const ids: string[] = [];
    if (rawIds) {
      const seen = new Set<string>();
      for (const value of rawIds) {
        if (typeof value !== 'string' || value.trim() === '') {
          details.push({ field: 'ids', message: 'each id must be a non-empty string' });
          break;
        }
        const id = value.trim();
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
    }

    if (rawIds && ids.length === 0 && details.length === 0) {
      details.push({ field: 'ids', message: 'must name at least one work item' });
    }
    // The bound is on the distinct count actually to be processed, so a request that is only
    // large because it repeats ids is not rejected for a size it does not have.
    if (ids.length > MAX_BULK_TRANSITION) {
      details.push({
        field: 'ids',
        message: `must name ${MAX_BULK_TRANSITION} work items or fewer`,
      });
    }

    const targetStatus =
      typeof body?.targetStatus === 'string' && isWorkItemState(body.targetStatus)
        ? body.targetStatus
        : undefined;
    if (targetStatus === undefined) {
      details.push({ field: 'targetStatus', message: 'must be a work item state' });
    }

    if (details.length > 0 || targetStatus === undefined) {
      throw new ApiError(400, 'validation_failed', 'The request body is invalid', details);
    }

    return this.bulk.apply(context, principal, ids, targetStatus);
  }
}

function isWorkItemState(value: string): value is WorkItemState {
  return (WORK_ITEM_STATES as readonly string[]).includes(value);
}
