import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import type { DynamicModule, Provider } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INSIGHTS_SNAPSHOTS_SERVICE, TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { WorkItemsRepository } from '../work/work-items.repository.js';
import { WorkloadRepository } from '../work-views/workload.repository.js';
import { ProjectsRepository } from '../projects/projects.repository.js';
import { DeliveryFlowRepository } from './delivery-flow.repository.js';
import { ApprovalCycleRepository, InsightsApprovalsReader } from './approval-cycle.repository.js';
import { InsightsService } from './insights.service.js';
import { InsightSnapshotsService, parseSnapshotKind } from './snapshots.service.js';
import type { SnapshotView } from './snapshots.service.js';

/**
 * x211's HTTP surface — Insight snapshots (module 15, Insights & reporting).
 *
 * A separate controller and module from x89/x123's `InsightsController`, disjoint by file so the
 * insights slices land in parallel without a shared append point (the posture INS-06's
 * `InsightsAdoptionController` documents). It exposes three routes under
 * `/v1/organizations/:orgSlug/insights/snapshots`, all behind `work.read` — the internal-read
 * capability the delivery-flow, workload and adoption reads already reuse, so this slice needs no new
 * capability and no `capabilities.ts` / role-grid edit.
 *
 * ## Org-level, and gated as one
 *
 * A snapshot captures an org-level roll-up, so — like INS-06 — the read/write is authorized once at
 * org level (a `work.read` `authorize()` with `projectId: null`) and a principal the check refuses
 * gets a 403 rather than a silently empty or silently stored result. `work.read` is internal-only, so
 * a client principal is refused here exactly as the route's `CapabilityGuard` refuses one — the
 * relation half of the same capability, belt-and-braces to the guard.
 *
 * The `kind` is a closed vocabulary: an unknown kind on capture or list is a 400, never a stored row
 * or a silently empty list. A snapshot fetched by id that does not belong to the tenant is a 404. The
 * list is a clamped page, so one request is never an unbounded scan.
 */
@Controller('v1/organizations/:orgSlug/insights/snapshots')
export class InsightSnapshotsController {
  constructor(
    @Inject(INSIGHTS_SNAPSHOTS_SERVICE) private readonly snapshots: InsightSnapshotsService,
  ) {}

  /**
   * Capture the current metrics for a report kind into a stored snapshot. Org-level `work.read`
   * (refusal is a 403), tenant-scoped by `orgSlug`; unknown kind → 400.
   */
  @Post()
  @RequireCapability('report.view')
  @HttpCode(201)
  async capture(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Body() body: { kind?: string } | undefined,
  ): Promise<SnapshotView> {
    this.requireOrgInsights(principal, context);
    const kind = parseSnapshotKind(body?.kind);
    return this.snapshots.capture(context, principal, kind);
  }

  /**
   * List the tenant's snapshots of one kind, newest first, in a clamped page. Org-level `work.read`
   * (refusal is a 403), tenant-scoped by `orgSlug`; unknown or missing kind → 400.
   */
  @Get()
  @RequireCapability('report.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
  ): Promise<readonly SnapshotView[]> {
    this.requireOrgInsights(principal, context);
    const parsedKind = parseSnapshotKind(kind);
    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (parsedLimit !== undefined && !Number.isSafeInteger(parsedLimit)) {
      throw new ApiError(400, 'validation_failed', 'limit must be an integer', [
        { field: 'limit', message: 'must be an integer' },
      ]);
    }
    return this.snapshots.list(context, principal, parsedKind, {
      ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
    });
  }

  /**
   * Fetch one snapshot by id — the compare surface's read. Org-level `work.read` (refusal is a 403),
   * tenant-scoped by `orgSlug`; a snapshot from another tenant (or none) → 404.
   */
  @Get(':snapshotId')
  @RequireCapability('report.view')
  async getById(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('snapshotId') snapshotId: string,
  ): Promise<SnapshotView> {
    this.requireOrgInsights(principal, context);
    return this.snapshots.getById(context, principal, snapshotId);
  }

  /**
   * The org-level relation half of the route's `work.read` gate, mirrored as the belt-and-braces the
   * sibling insights reads apply. An internal role that holds `work.read` passes; a client is refused
   * (internal-only capability) and a cross-tenant principal by the tenant check inside `authorize` —
   * a 403, never a silently empty or silently stored result over an org-level internal read.
   */
  private requireOrgInsights(principal: Principal, context: TenantContext): void {
    if (!this.snapshots.mayReadOrgInsights(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'insight_snapshots_denied',
      );
    }
  }
}

/**
 * x211's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into x89/x123's `InsightsModule`, so the insights slices stay file-disjoint. The
 * snapshot service reuses `InsightsService` (constructed here from its stateless repositories, the
 * same construction `InsightsModule.register` uses) to compute the metrics it captures, and the
 * `@Global` `TENANT_DATABASE` for its tenant-scoped writes and reads.
 */
@Module({})
export class InsightSnapshotsModule {
  static register(): DynamicModule {
    const service: Provider = {
      provide: INSIGHTS_SNAPSHOTS_SERVICE,
      inject: [TENANT_DATABASE],
      useFactory: (database: TenantDatabase) =>
        new InsightSnapshotsService(
          database,
          new InsightsService(
            database,
            new DeliveryFlowRepository(new WorkItemsRepository()),
            new ApprovalCycleRepository(new InsightsApprovalsReader()),
            new WorkloadRepository(new WorkItemsRepository()),
            new ProjectsRepository(),
          ),
        ),
    };

    return {
      module: InsightSnapshotsModule,
      providers: [service],
      controllers: [InsightSnapshotsController],
    };
  }
}
