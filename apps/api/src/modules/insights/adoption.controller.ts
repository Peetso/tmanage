import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { InsightsAdoptionRepository } from './adoption.repository.js';

/**
 * INS-06's HTTP surface — the org-wide adoption read (audit: "Insights Partial; INS-06 deferred").
 *
 * A separate controller and module from x89/x123's `InsightsController`, disjoint by file so the
 * insights slices land in parallel without a shared append point. It exposes one route,
 * `GET /v1/organizations/:orgSlug/insights/adoption`, behind `work.read` — the internal-read
 * capability the delivery-flow and workload reads already reuse, so INS-06 needs no new capability
 * and no `capabilities.ts` / role-grid edit (ADM-03 stays blocked).
 *
 * ## Org-level, and gated as one
 *
 * Unlike INS-05's per-project roll-up, adoption is a single org-level aggregate — a member count is
 * not decomposable per project. So the read is authorized **once at org level** (a `work.read`
 * `authorize()` with `projectId: null`), and a principal the check refuses gets a 403 rather than a
 * silently empty roll-up. `work.read` is internal-only (`capabilities.ts`), so a client principal is
 * refused here exactly as the route's `CapabilityGuard` refuses one — this is the relation half of
 * the same capability, the belt-and-braces the sibling reads apply.
 *
 * The window (`?days=`, default 30) is clamped to `[1, 90]`; a value outside that — an over-wide
 * window a caller might use to turn one read into an unbounded scan — is a 400, the FAST-PROTOCOL
 * Known-trap for this slice. The counts are computed from tenant-scoped reads, re-filtered to the
 * context's organization belt-and-braces before counting, so a cross-tenant row never contributes
 * and the read never returns another tenant's numbers.
 */

/** The adoption window's default and hard ceiling, in days. A wider window is a 400, not a clamp. */
const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 90;

/**
 * INS-06's read shape — the org-wide adoption roll-up.
 *
 * `activeMembers` is the studio's current active memberships; `membersWithWork` is the distinct
 * people who created any work in the window; `meetingsHeld` is the meetings held in it. `windowDays`
 * echoes the clamped window the counts were computed over, so a consumer never has to guess it.
 * Computed, never stored: no column, no write, no schedule. Paired in
 * `e2e/contracts/api-web-shapes.ts` with the web shape the adoption screen consumes (CONTRACT-001).
 */
export interface InsightsAdoptionView {
  readonly windowDays: number;
  readonly activeMembers: number;
  readonly membersWithWork: number;
  readonly meetingsHeld: number;
  readonly computedAt: string;
}

/**
 * Parse and validate the `?days=` window. Missing is the default 30; anything present must be an
 * integer in `[1, 90]` or the read is a 400 — an over-wide or nonsensical window is rejected, never
 * silently clamped, so a caller cannot quietly widen the scan the count runs over.
 */
function parseWindowDays(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WINDOW_DAYS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_WINDOW_DAYS) {
    throw new ApiError(400, 'validation_failed', 'The adoption window is invalid', [
      { field: 'days', message: `must be a whole number of days between 1 and ${MAX_WINDOW_DAYS}` },
    ]);
  }
  return value;
}

/** Distinct non-null count of a list of ids — the aggregation the roll-up is. */
function distinctCount(ids: readonly (string | null)[]): number {
  const seen = new Set<string>();
  for (const id of ids) if (id !== null) seen.add(id);
  return seen.size;
}

@Controller('v1/organizations/:orgSlug/insights')
export class InsightsAdoptionController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    private readonly adoption: InsightsAdoptionRepository,
  ) {}

  /**
   * The org-wide adoption roll-up: active members, members who created work in the window, and
   * meetings held in it. Tenant-scoped by `orgSlug`; authorized once at org level (a `work.read`
   * refusal is a 403, not an empty roll-up); the window is clamped to `[1, 90]` (a wider one is a
   * 400). A pure read — no write, no new column.
   */
  @Get('adoption')
  @RequireCapability('work.read')
  async adoptionMetrics(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('days') days?: string,
  ): Promise<InsightsAdoptionView> {
    const windowDays = parseWindowDays(days);

    // Org-level relation check: the route's role ceiling gate mirrored as the belt-and-braces the
    // sibling reads apply. `work.read` is internal-only, so a client is refused here — a 403, not a
    // silently empty aggregate over an org-level internal read.
    if (!this.mayReadOrgAdoption(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'insights_adoption_denied',
      );
    }

    const now = new Date();
    const rolled = await this.database.read(context, async (runner) => {
      // Sequential, not `Promise.all`: one connection is bound to this unit of work and mysql2 does
      // not multiplex a connection across concurrent queries.
      const members = await this.adoption.listActiveMembers(runner, context);
      const owners = await this.adoption.listRecentWorkOwners(runner, context, windowDays);
      const meetings = await this.adoption.listMeetingsHeld(runner, context, windowDays);
      return { members, owners, meetings };
    });

    const org = context.organizationId;
    // Belt-and-braces tenant filter before counting (Known-trap: scope before the count).
    const activeMembers = distinctCount(
      rolled.members.filter((row) => row.organizationId === org).map((row) => row.userId),
    );
    const membersWithWork = distinctCount(
      rolled.owners.filter((row) => row.organizationId === org).map((row) => row.ownerUserId),
    );
    const meetingsHeld = rolled.meetings.filter((row) => row.organizationId === org).length;

    return {
      windowDays,
      activeMembers,
      membersWithWork,
      meetingsHeld,
      computedAt: now.toISOString(),
    };
  }

  /**
   * Whether this principal may read the org's adoption roll-up, judged by `work.read` against the
   * organization itself (`projectId: null`, internal audience) — the org-level relation half of the
   * capability the controller gated on the role. An internal role that holds `work.read` is allowed;
   * a client is refused because `work.read` is internal-only, and a cross-tenant principal by the
   * tenant check inside `authorize`.
   */
  private mayReadOrgAdoption(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'work.read',
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
 * INS-06's wiring — a self-contained module registered from `app.module.ts` (the shared append
 * point) rather than folded into x89/x123's `InsightsModule`, so the insights slices stay
 * file-disjoint. The repository is a stateless collection of tenant-scoped reads, constructed here;
 * the controller injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class InsightsAdoptionModule {
  static register(): DynamicModule {
    return {
      module: InsightsAdoptionModule,
      providers: [
        { provide: InsightsAdoptionRepository, useFactory: () => new InsightsAdoptionRepository() },
      ],
      controllers: [InsightsAdoptionController],
    };
  }
}
