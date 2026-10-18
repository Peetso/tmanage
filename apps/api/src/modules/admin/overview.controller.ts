import { Controller, Get, Inject, Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { AdminOverviewRepository, OVERVIEW_AUDIT_WINDOW_DAYS } from './overview.repository.js';

/**
 * The admin-overview HTTP surface — Administration module 18 (x175, audit rank #9 "Admin Partial").
 *
 * One route, `GET /v1/organizations/:orgSlug/admin/overview`, behind `org.manage` — the same
 * org-administration capability x115's audit viewer, x116's members admin and x153's settings sit
 * behind, so this needs no new capability and no `capabilities.ts` / role-grid edit (ADM-03 stays
 * blocked). It is a separate controller and module, disjoint by file from those slices, so the
 * administration slices land in parallel without a shared append point.
 *
 * ## Org-level, and gated as one
 *
 * The overview is a single org-level aggregate — a member count is not decomposable per project — so
 * the read is authorized **once at org level** (an `org.manage` `authorize()` with `projectId: null`,
 * internal audience). A principal the check refuses gets a 403 rather than a silently empty roll-up;
 * `org.manage` is internal-only, so a client principal is refused here exactly as the route's
 * `CapabilityGuard` refuses one — the relation half of the same capability, the belt-and-braces the
 * sibling reads apply. The route decorator is the coarse HTTP gate; this authorize is the
 * tenant-checked decision the controller test exercises directly.
 *
 * The five metrics are computed from tenant-scoped reads, re-filtered to the context's organization
 * belt-and-braces before counting (Known-trap: scope before the count), so a cross-tenant row never
 * contributes and the read never returns another tenant's numbers. Nothing here writes.
 */

/**
 * The admin-overview roll-up shape — CONTRACT-001, paired `Exact` in `e2e/contracts/api-web-shapes.ts`
 * with `AdminOverviewView` in `apps/web/src/lib/api/admin-overview.ts`.
 *
 * `activeMembers` is the studio's current active memberships; `seatsUsed` is every membership holding
 * a seat (active, invited or suspended — not the terminal offboarded); `storageBytesUsed` is the
 * organization's storage counter; `auditEventsWindow` is the audit events recorded in the last
 * `auditWindowDays` days; `openOffboardings` is the memberships whose offboarding is in progress
 * (suspended — access withdrawn, not yet finalised). Computed, never stored: no column, no write.
 */
export interface AdminOverviewView {
  readonly activeMembers: number;
  readonly seatsUsed: number;
  readonly storageBytesUsed: number;
  readonly auditWindowDays: number;
  readonly auditEventsWindow: number;
  readonly openOffboardings: number;
  readonly computedAt: string;
}

@Controller('v1/organizations/:orgSlug/admin')
export class AdminOverviewController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(AdminOverviewRepository) private readonly overview: AdminOverviewRepository,
  ) {}

  /**
   * The org health roll-up: active members, seats used, storage bytes used, audit-event count over the
   * fixed 30-day window, and offboardings in progress. Tenant-scoped by `orgSlug`; authorized once at
   * org level (an `org.manage` refusal is a 403, not an empty roll-up). A pure read — no write, no new
   * column, no migration.
   */
  @Get('overview')
  @RequireCapability('org.manage')
  async overviewMetrics(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AdminOverviewView> {
    // Org-level relation check: the route's role ceiling gate mirrored as the belt-and-braces the
    // sibling reads apply. `org.manage` is internal-only, so a client is refused here — a 403, not a
    // silently empty aggregate over an org-level internal read.
    if (!this.mayReadOverview(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'admin_overview_denied');
    }

    const now = new Date();
    const rolled = await this.database.read(context, async (runner) => {
      // Sequential, not `Promise.all`: one connection is bound to this unit of work and mysql2 does
      // not multiplex a connection across concurrent queries.
      const seatMemberships = await this.overview.listSeatMemberships(runner, context);
      const storage = await this.overview.listStorageCounter(runner, context);
      const auditWindow = await this.overview.listRecentAuditEvents(runner, context);
      return { seatMemberships, storage, auditWindow };
    });

    const org = context.organizationId;
    // Belt-and-braces tenant filter before counting (Known-trap: scope before the count).
    const seats = rolled.seatMemberships.filter((row) => row.organizationId === org);
    const activeMembers = seats.filter((row) => row.status === 'active').length;
    const seatsUsed = seats.length;
    const openOffboardings = seats.filter((row) => row.status === 'suspended').length;
    const storageBytesUsed = rolled.storage
      .filter((row) => row.organizationId === org)
      .reduce((total, row) => total + Number(row.usedBytes), 0);
    const auditEventsWindow = rolled.auditWindow.filter((row) => row.organizationId === org).length;

    return {
      activeMembers,
      seatsUsed,
      storageBytesUsed,
      auditWindowDays: OVERVIEW_AUDIT_WINDOW_DAYS,
      auditEventsWindow,
      openOffboardings,
      computedAt: now.toISOString(),
    };
  }

  /**
   * Whether this principal may read the org's admin overview, judged by `org.manage` against the
   * organization itself (`projectId: null`, internal audience) — the org-level relation half of the
   * capability the route gated on the role. An internal role that holds `org.manage` (owner) is
   * allowed; a client is refused because `org.manage` is internal-only, and a cross-tenant principal
   * by the tenant check inside `authorize`.
   */
  private mayReadOverview(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'org.manage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * x175's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into another administration controller, so the administration slices stay
 * file-disjoint. The service is a stateless collection of tenant-scoped reads, constructed here; the
 * controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class AdminOverviewModule {
  static register(): DynamicModule {
    return {
      module: AdminOverviewModule,
      providers: [
        { provide: AdminOverviewRepository, useFactory: () => new AdminOverviewRepository() },
      ],
      controllers: [AdminOverviewController],
    };
  }
}
