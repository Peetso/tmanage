import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import {
  MAX_FORECAST_WEEKS,
  MIN_FORECAST_WEEKS,
  WorkloadForecastService,
} from './workload-forecast.service.js';
import type { WorkloadForecastView } from './workload-forecast.service.js';

/**
 * x134's HTTP surface — the Insights workload-forecast read.
 *
 * A second controller on the insights base path rather than an edit to {@link InsightsController}:
 * the sibling insights slices (x133 adoption, x135 export) each own their own new file, so this
 * route stays file-disjoint from them and from INS-05's `workload`. Behind `work.read`, the same
 * internal-read capability INS-01/05 use (reused, no capability-table or role-grid edit, no
 * migration). Tenant-scoped by `orgSlug` via the `TenantContextGuard`; the projection and the
 * per-project/per-row authorization are the service's.
 *
 * The `CapabilityGuard` refuses a caller without `work.read` with the ordinary 403 before this
 * handler runs — the same guard that refuses the sibling `work-items` reads, not a second copy of
 * the check.
 */
@Controller('v1/organizations/:orgSlug/insights')
export class WorkloadForecastController {
  constructor(
    @Inject(WorkloadForecastService) private readonly forecast: WorkloadForecastService,
  ) {}

  /**
   * The org-wide workload forecast — committed open work projected into the upcoming `?weeks` weeks
   * (1..12, default 4) against a constant per-member capacity. `weeks` present but out of range is a
   * 400 (the Known trap): the horizon is a real bound, not a convenience to clamp silently, so a
   * caller who asks for 0 or 13 is told, rather than quietly given 1 or 12.
   */
  @Get('workload-forecast')
  @RequireCapability('work.read')
  async workloadForecast(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('weeks') weeks?: string,
  ): Promise<WorkloadForecastView> {
    const parsed = parseWeeks(weeks);
    return this.forecast.forecast(context, principal, { weeks: parsed });
  }
}

/**
 * Parse and validate the `?weeks` horizon. A missing value is the service's default (`undefined`
 * here, which the service resolves to 4). A present value must be an integer in `[1, 12]` — anything
 * else (non-numeric, fractional, or out of range) is a 400, never a clamp.
 */
function parseWeeks(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WEEKS_SENTINEL;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_FORECAST_WEEKS || value > MAX_FORECAST_WEEKS) {
    throw new ApiError(
      400,
      'validation_failed',
      `weeks must be an integer in [${MIN_FORECAST_WEEKS}, ${MAX_FORECAST_WEEKS}]`,
      [
        {
          field: 'weeks',
          message: `must be an integer in [${MIN_FORECAST_WEEKS}, ${MAX_FORECAST_WEEKS}]`,
        },
      ],
    );
  }
  return value;
}

/**
 * The value passed for an absent `?weeks`. The service's `clampWeeks` maps a non-finite value to its
 * default, so `NaN` here means "no horizon supplied, use the default 4" without the controller
 * needing to know the default.
 */
const DEFAULT_WEEKS_SENTINEL = Number.NaN;
