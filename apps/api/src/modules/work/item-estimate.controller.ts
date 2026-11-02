import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { WORK_ITEM_ESTIMATE_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_ESTIMATE_MINUTES,
  type WorkItemEstimateService,
  type WorkItemEstimateView,
} from './item-estimate.service.js';

/**
 * x258's HTTP surface — a work item's effort estimate (Work module).
 *
 * A sub-resource of the work item, like the time logs and checklist: the parent id is in the path,
 * and the service resolves it tenant-scoped before it authorizes or writes. This controller reads no
 * `organizationId` from anywhere — `TenantContextGuard` built the `TenantContext` from a membership
 * row, and there is no field on the body below for a caller to supply one.
 *
 * The capability gate is coarse (`work.read` to read, `work.update` to set); the row-level decision —
 * may this principal act on *this* item — is the service's. There is exactly one estimate per item,
 * so the write is an idempotent `PUT`, not a `POST` that would append.
 */

interface SetEstimateBody {
  readonly minutes?: unknown;
  /** 53-08 (0309): the manual remaining override; `null` clears it, absent leaves it. */
  readonly remainingMinutes?: unknown;
}

@Controller('v1/organizations/:orgSlug/work-items/:workItemId/estimate')
export class WorkItemEstimateController {
  constructor(
    @Inject(WORK_ITEM_ESTIMATE_SERVICE) private readonly estimates: WorkItemEstimateService,
  ) {}

  @Get()
  @RequireCapability('work.read')
  async get(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
  ): Promise<WorkItemEstimateView> {
    return this.estimates.get(context, principal, workItemId);
  }

  @Put()
  @RequireCapability('work.update')
  async set(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('workItemId') workItemId: string,
    @Body() body: SetEstimateBody,
  ): Promise<WorkItemEstimateView> {
    const minutes = requiredMinutes(body?.minutes);
    const remaining = optionalRemaining(body?.remainingMinutes);
    return this.estimates.set(context, principal, workItemId, minutes, remaining);
  }
}

function requiredMinutes(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0 || raw > MAX_ESTIMATE_MINUTES) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      {
        field: 'minutes',
        message: `must be a whole number of minutes, 1 to ${MAX_ESTIMATE_MINUTES}`,
      },
    ]);
  }
  return raw;
}

/** 53-08: absent → leave the override; `null` → clear it; else an integer 0 … the cap. */
function optionalRemaining(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_ESTIMATE_MINUTES) {
    throw new ApiError(400, 'validation_failed', 'The request body is invalid', [
      {
        field: 'remainingMinutes',
        message: `must be a whole number of minutes, 0 to ${MAX_ESTIMATE_MINUTES}, or null`,
      },
    ]);
  }
  return raw;
}
