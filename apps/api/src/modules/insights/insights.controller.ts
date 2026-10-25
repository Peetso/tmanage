import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError } from '../../common/http/errors.js';
import { INSIGHTS_SERVICE } from '../../common/http/tokens.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type {
  ApprovalCycleView,
  DeliveryFlowView,
  InsightsPortfolioView,
  InsightsService,
  InsightsWorkloadView,
} from './insights.service.js';

/**
 * Parse the optional `?limit=` query into a number for the service to clamp. A missing or
 * unparseable value is `undefined` (the service's default), never a thrown 400 — the bound is a
 * convenience, not a required argument, and the service is the one place the `[1, 50]` clamp lives.
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/** The most project ids one `?projectIds=` filter carries — the portfolio's own hard page max. */
const MAX_PROJECT_IDS = 50;

/**
 * Parse A13's `?projectIds=a,b,c` ("Projects in this report") into a de-duplicated id list. Blank
 * entries are ignored and the list is capped; an id the caller cannot read is not an error here —
 * the service drops it silently, so the filter can only narrow, never widen, the roll-up.
 */
export function parseProjectIds(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0 && id.length <= 64);
  return [...new Set(ids)].slice(0, MAX_PROJECT_IDS);
}

/**
 * INS-01's HTTP surface — the insights module's first read.
 *
 * `work.read` on the route, the internal-read capability x86's project-health roll-up reuses (see
 * the service's note). A caller without it is refused by the global `CapabilityGuard` exactly as
 * the sibling `work-items` reads are — this is not a second copy of that check, it is the same
 * guard reading the same capability off this route's metadata.
 *
 * The module is read-only this slice, so there is no `POST`/`PATCH` here. A dedicated
 * `/insights` web surface is the follow-up (recorded in implementation-status); nothing consumes
 * this endpoint yet, which is why its view is exempt in `scripts/contracts-check.mjs`.
 */
@Controller('v1/organizations/:orgSlug/insights')
export class InsightsController {
  constructor(@Inject(INSIGHTS_SERVICE) private readonly insights: InsightsService) {}

  /**
   * The portfolio roll-up — INS-01's headline figures for each project the caller may read, the
   * org-level index that replaces the per-project screens' deferred stub. Behind `work.read`, the
   * same internal-read capability the delivery-flow read uses. Tenant-scoped by `orgSlug`; the
   * route takes no project id, so an inaccessible or cross-tenant project is silently excluded by
   * the service rather than 404'd — the Known-trap surfaced as inclusion. Bounded page
   * (default 20 / max 50), keyset by project id via `after`.
   */
  @Get('portfolio')
  @RequireCapability('work.read')
  async portfolio(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('after') after?: string,
    @Query('limit') limit?: string,
    @Query('projectIds') projectIds?: string,
  ): Promise<InsightsPortfolioView> {
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }

    const parsedIds = parseProjectIds(projectIds);
    return this.insights.portfolio(context, principal, {
      ...(after ? { after } : {}),
      ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      ...(parsedIds.length > 0 ? { projectIds: parsedIds } : {}),
    });
  }

  /**
   * A project's delivery flow — work-item counts by workflow status. Tenant-scoped by `orgSlug`
   * (the `TenantContextGuard`), authorized per item by the service.
   */
  @Get('projects/:projectId/delivery-flow')
  @RequireCapability('work.read')
  async deliveryFlow(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<DeliveryFlowView> {
    return this.insights.projectDeliveryFlow(context, principal, projectId);
  }

  /**
   * A project's approval cycle — approval counts by terminal outcome and, for the decided ones,
   * the requested→decided durations. F39: this is internal analytics (it counts staff-only reviews
   * of versions never published to the client), so the route sits behind `work.read` like its
   * siblings — internal-only, so every client principal is refused by the `CapabilityGuard`. The
   * service still re-checks `approval.read` per approval. Tenant-scoped by `orgSlug`.
   */
  @Get('projects/:projectId/approval-cycle')
  @RequireCapability('work.read')
  async approvalCycle(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('projectId') projectId: string,
  ): Promise<ApprovalCycleView> {
    return this.insights.projectApprovalCycle(context, principal, projectId);
  }

  /**
   * INS-05 — the org-wide workload/capacity portfolio roll-up: per-project and aggregate open-work
   * counts across the projects the caller may read. Behind `work.read`, the same internal-read
   * capability the delivery-flow read uses (reused, not a new capability). Tenant-scoped by
   * `orgSlug`; every project is resolved tenant-scoped and authorized per project by the service, so
   * a non-org-wide caller sees only their projects and a cross-tenant project never contributes. The
   * optional `?limit=` bounds how many projects are rolled up (clamped to `[1, 50]`, default 20).
   */
  @Get('workload')
  @RequireCapability('work.read')
  async workload(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<InsightsWorkloadView> {
    const parsed = parseLimit(limit);
    return this.insights.orgWorkload(context, principal, {
      ...(parsed === undefined ? {} : { limit: parsed }),
    });
  }
}
