import { Controller, Get, Inject, Module, Query } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { authorize, isClientRequestState } from '@tmanage/domain';
import type { ClientRequestState, Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import { MAX_AGING_LIMIT, RequestAgingRepository } from './request-aging.repository.js';
import type { OpenRequestRow } from './request-aging.repository.js';

/**
 * Request aging — module 11's read surface (x154), the studio's overdue-to-triage / long-uncommitted
 * view (audit: "Requests Partial; aging/SLA view not built"). A second controller on the
 * client-requests base path rather than an edit to {@link ClientRequestsController}: the aging read
 * is a roll-up, not a queue row, and keeping it in its own file keeps this slice disjoint from the
 * list/triage controller the chain already ships.
 *
 * One route, `GET /v1/organizations/:orgSlug/client-requests/aging`, behind `client_request.triage`
 * — the same internal-only capability REQ-001's inbox reads under, reused, so aging needs no new
 * capability and no `capabilities.ts` / role-grid edit (ADM-03 stays blocked). It reads only the
 * requests still open, buckets them by age since submission against fixed thresholds, and returns the
 * counts plus a bounded, oldest-first page. Read-only: no write, no new column, no migration.
 *
 * ## Authorization is applied twice, the way the sibling reads apply it
 *
 * 1. **Org-level gate.** A `client_request.triage` `authorize()` with `projectId: null` refuses a
 *    principal who does not hold the capability at all — a client (it is internal-only) or a
 *    cross-tenant principal — with a 403 rather than a silently empty roll-up, the same shape INS-06
 *    uses for its org-level read.
 * 2. **Per-row relation filter.** `client_request.triage` is relation-gated, so a project-scoped
 *    manager may triage only their own projects' requests. Each row is re-checked with the real
 *    `authorize()` (the same `mayTriage` the list serves), and a request in a project the caller does
 *    not own contributes nothing — the aging queue can never widen the relation check the queue makes.
 *
 * The tenant filter is in SQL and re-checked belt-and-braces here (scope before the count — the
 * FAST-PROTOCOL Known-trap for this slice), so a request from another tenant is never bucketed.
 */

/** The fixed SLA thresholds, in whole days. Configurable thresholds are deferred to NS-13 (x153 org settings). */
const AGING_THRESHOLD_DAYS = 3;
const OVERDUE_THRESHOLD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Which age bucket an open request falls into. */
export type RequestAgingBucket = 'fresh' | 'aging' | 'overdue';

/** One open request, aged. Not a `*View` (so the contract check pairs only the roll-up), but paired structurally. */
export interface RequestAgingItem {
  readonly id: string;
  readonly title: string;
  readonly state: ClientRequestState;
  readonly projectId: string;
  readonly clientOrganizationId: string;
  /** When the client submitted it — the anchor age is measured from (ISO 8601). */
  readonly createdAt: string;
  /** Whole days since submission, floored — the value the bucket is chosen from. */
  readonly ageDays: number;
  /** `fresh` under the aging threshold, `aging` under the overdue threshold, else `overdue`. */
  readonly bucket: RequestAgingBucket;
  /** Whether the studio has committed a date or an explicit unscheduled state yet. */
  readonly committed: boolean;
}

/** The counts across the open set — one per bucket, plus the uncommitted tally and the total. */
export interface RequestAgingCounts {
  readonly fresh: number;
  readonly aging: number;
  readonly overdue: number;
  readonly uncommitted: number;
  readonly total: number;
}

/**
 * REQ-001's aging read shape — the overdue-to-triage / long-uncommitted roll-up.
 *
 * `thresholds` echoes the fixed day boundaries the buckets were chosen against so a consumer never
 * guesses them; `counts` is the tally across the open set; `requests` is the bounded, oldest-first
 * page of the aged rows. Computed, never stored: no column, no write, no schedule. Paired in
 * `e2e/contracts/api-web-shapes.ts` with the web shape the aging screen consumes (CONTRACT-001).
 */
export interface RequestAgingView {
  readonly thresholds: { readonly agingDays: number; readonly overdueDays: number };
  readonly counts: RequestAgingCounts;
  readonly requests: readonly RequestAgingItem[];
  readonly computedAt: string;
}

/**
 * Parse and validate the `?limit=` bound. Missing is the repository's default; a present value must
 * be a positive integer no greater than the ceiling — anything else is a 400, never a silent clamp,
 * so a caller who asks for 0 or an over-wide page is told rather than quietly given one.
 */
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_AGING_LIMIT) {
    throw new ApiError(400, 'validation_failed', 'The aging page size is invalid', [
      { field: 'limit', message: `must be a whole number between 1 and ${MAX_AGING_LIMIT}` },
    ]);
  }
  return value;
}

/** Which bucket an age in whole days falls into, against the fixed thresholds. */
function bucketFor(ageDays: number): RequestAgingBucket {
  if (ageDays >= OVERDUE_THRESHOLD_DAYS) return 'overdue';
  if (ageDays >= AGING_THRESHOLD_DAYS) return 'aging';
  return 'fresh';
}

@Controller('v1/organizations/:orgSlug/client-requests/aging')
export class RequestAgingController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    private readonly aging: RequestAgingRepository,
  ) {}

  /**
   * The aging roll-up: open requests bucketed by age since submission (fresh/aging/overdue against
   * fixed thresholds), oldest first, bounded. Tenant-scoped by `orgSlug`; a principal without
   * `client_request.triage` is a 403; a request in a project a scoped manager does not own is dropped;
   * a cross-tenant row never contributes. A pure read.
   */
  @Get()
  @RequireCapability('client_request.triage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('limit') limit?: string,
  ): Promise<RequestAgingView> {
    const parsedLimit = parseLimit(limit);

    // Org-level relation check: refuse a principal who cannot triage at all (a client — the
    // capability is internal-only — or a cross-tenant principal) with a 403 rather than an empty
    // roll-up, mirroring the sibling org-level reads.
    if (!this.mayTriageOrg(principal, context)) {
      throw new ApiError(403, 'forbidden', MESSAGES.forbidden, undefined, 'request_aging_denied');
    }

    const now = Date.now();
    const rows = await this.database.read(context, (runner) =>
      this.aging.listOpen(runner, context, {
        ...(parsedLimit === undefined ? {} : { limit: parsedLimit }),
      }),
    );

    const org = context.organizationId;
    const items: RequestAgingItem[] = [];
    for (const row of rows) {
      // Belt-and-braces tenant filter (scope before the count) and the per-row relation check: a
      // request in a project this caller does not own is not theirs to triage, so it is not aged.
      if (row.organizationId !== org) continue;
      if (!this.mayTriageRow(principal, row)) continue;

      const ageDays = Math.max(0, Math.floor((now - row.createdAt.getTime()) / DAY_MS));
      const state = isClientRequestState(row.state)
        ? row.state
        : ('submitted' as ClientRequestState);
      items.push({
        id: row.id,
        title: row.title,
        state,
        projectId: row.projectId,
        clientOrganizationId: row.clientOrganizationId,
        createdAt: row.createdAt.toISOString(),
        ageDays,
        bucket: bucketFor(ageDays),
        committed: row.commitment !== null,
      });
    }

    const counts: RequestAgingCounts = {
      fresh: items.filter((item) => item.bucket === 'fresh').length,
      aging: items.filter((item) => item.bucket === 'aging').length,
      overdue: items.filter((item) => item.bucket === 'overdue').length,
      uncommitted: items.filter((item) => !item.committed).length,
      total: items.length,
    };

    return {
      thresholds: { agingDays: AGING_THRESHOLD_DAYS, overdueDays: OVERDUE_THRESHOLD_DAYS },
      counts,
      requests: items,
      computedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Whether this principal may triage at all in this organization, judged by `client_request.triage`
   * against the org itself (`projectId: null`) — the org-level relation half of the route's ceiling.
   * An internal role that holds the capability is allowed; a client is refused (internal-only), and a
   * cross-tenant principal by the tenant check inside `authorize`.
   */
  private mayTriageOrg(principal: Principal, context: TenantContext): boolean {
    return authorize({
      principal,
      capability: 'client_request.triage',
      resource: {
        organizationId: context.organizationId,
        projectId: null,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }

  /**
   * Whether this principal may triage this particular request — the per-row relation check the list
   * serves as `mayTriage`. For an internal principal this is the project relation (org-wide scope or
   * the project in `projectIds`); a client never reaches here (refused org-level above).
   */
  private mayTriageRow(principal: Principal, row: OpenRequestRow): boolean {
    return authorize({
      principal,
      capability: 'client_request.triage',
      resource: {
        organizationId: row.organizationId,
        projectId: row.projectId,
        clientOrganizationId: row.clientOrganizationId,
        audience: 'internal',
        lifecycle: 'active',
      },
    }).allowed;
  }
}

/**
 * x154's wiring — a self-contained module registered from `app.module.ts` (the shared append point)
 * rather than folded into {@link RequestsModule}, so the requests slices stay file-disjoint. The
 * repository is a stateless collection of tenant-scoped reads, constructed here; the controller
 * injects it and the `@Global` `TENANT_DATABASE`.
 */
@Module({})
export class RequestAgingModule {
  static register(): DynamicModule {
    return {
      module: RequestAgingModule,
      providers: [
        { provide: RequestAgingRepository, useFactory: () => new RequestAgingRepository() },
      ],
      controllers: [RequestAgingController],
    };
  }
}
