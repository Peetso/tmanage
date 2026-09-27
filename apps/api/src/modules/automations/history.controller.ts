import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { authorize } from '@tmanage/domain';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { TENANT_DATABASE, WORKFLOW_RUN_HISTORY_REPOSITORY } from '../../common/http/tokens.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { WorkflowRunDetail, WorkflowRunRow } from '../../common/database/schema.js';
import type { WorkflowRunHistoryRepository } from './history.repository.js';

/**
 * Automations & integrations (module 17, x164). Two read-only endpoints: list the organization's
 * workflow runs and read one run's detail. This is the *history* half of the module — x163 writes a
 * `workflow_runs` row when a template is run; this reads that append-only record back (audit rank #2,
 * "Automations Missing — run history").
 *
 * ## The capability
 *
 * Reading automation history is an org-admin concern, so both routes reuse `org.manage` — no
 * `automation.*` capability exists and this slice adds none. `CapabilityGuard` asks the coarse ceiling
 * question; this controller adds the authoritative org-scoped `authorize()` (`projectId: null`,
 * deny-by-default) a suspended membership fails, exactly as the sibling automations reads do.
 *
 * ## The Known-trap order — resolve BEFORE authorize on `:runId`
 *
 * The run id is a path parameter, so on the detail route it is **resolved within the acting tenant
 * before any authorization decision**. `findById` is tenant-scoped, so a run id belonging to another
 * studio (or one that does not exist) resolves to `null` and the request is a 404 — the existence of
 * another tenant's run is never revealed as a 403. Only once a run in *this* tenant is in hand does the
 * org-scoped `org.manage` decision run (403 on denial). The list route is org-scoped by the repository,
 * which makes a cross-tenant read impossible; its `status` filter is validated against a fixed
 * allowlist (off-list → 400) before the repository is touched, so a filter value never becomes an
 * unbounded predicate.
 *
 * This slice is read-only: it writes nothing and needs no privilege beyond the database-wide SELECT.
 */

/**
 * The fixed allowlist of run statuses. Mirrors what x163's run path records (`succeeded` | `failed`);
 * a `status` filter outside this set is a 400 (`workflow_run_status_off_list`), never a query
 * predicate. Kept in the application (not a DB `ENUM`) so the set can grow without a schema change.
 */
export const WORKFLOW_RUN_STATUSES = ['succeeded', 'failed'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

const MAX_PAGE_SIZE = 200;

/**
 * What a caller is allowed to see of one run in the *list*. `detail` is deliberately absent — the list
 * is bounded and a run's full detail is read one at a time from the detail route. `organizationId` is
 * absent too.
 */
export interface WorkflowRunHistoryView {
  readonly id: string;
  readonly templateId: string;
  readonly status: string;
  /** An ISO-8601 instant. */
  readonly startedAt: string;
  /** An ISO-8601 instant. */
  readonly finishedAt: string;
}

/**
 * What a caller is allowed to see of one run in *detail*: the list projection plus the run's
 * `detail_json`. `organizationId` is deliberately absent.
 */
export interface WorkflowRunDetailView {
  readonly id: string;
  readonly templateId: string;
  readonly status: string;
  readonly detail: WorkflowRunDetail;
  /** An ISO-8601 instant. */
  readonly startedAt: string;
  /** An ISO-8601 instant. */
  readonly finishedAt: string;
}

/** An explicit list projection, not a serialised row: a column added later is invisible until named. */
function toListView(row: WorkflowRunRow): WorkflowRunHistoryView {
  return {
    id: row.id,
    templateId: row.templateId,
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  };
}

/** An explicit detail projection, not a serialised row. */
function toDetailView(row: WorkflowRunRow): WorkflowRunDetailView {
  return {
    id: row.id,
    templateId: row.templateId,
    status: row.status,
    detail: row.detailJson,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
  };
}

@Controller('v1/organizations/:orgSlug/automations/runs')
export class WorkflowRunHistoryController {
  constructor(
    @Inject(TENANT_DATABASE) private readonly database: TenantDatabase,
    @Inject(WORKFLOW_RUN_HISTORY_REPOSITORY)
    private readonly history: WorkflowRunHistoryRepository,
  ) {}

  /**
   * List the acting tenant's runs across all templates, newest first, for an org admin. `org.manage`,
   * relation-gated org-scoped (`projectId: null`). The list is tenant-scoped by the repository, so a
   * cross-tenant read is impossible. An off-list `status` filter is a 400 decided before the repository
   * is touched; `limit` is bounded to `MAX_PAGE_SIZE`.
   */
  @Get()
  @RequireCapability('org.manage')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<{ readonly runs: readonly WorkflowRunHistoryView[] }> {
    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_run_read_denied',
      );
    }

    const statusFilter = validateStatusFilter(status);

    const parsedLimit = limit === undefined ? undefined : Number(limit);
    if (
      parsedLimit !== undefined &&
      (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_PAGE_SIZE)
    ) {
      throw new ApiError(400, 'validation_failed', 'The request query is invalid', [
        { field: 'limit', message: `must be an integer between 1 and ${MAX_PAGE_SIZE}` },
      ]);
    }

    const rows = await this.database.read(context, (runner) =>
      this.history.list(runner, context, {
        ...(statusFilter !== undefined ? { status: statusFilter } : {}),
        ...(parsedLimit !== undefined ? { limit: parsedLimit } : {}),
      }),
    );
    return { runs: rows.map(toListView) };
  }

  /**
   * Read one run's detail. `org.manage`, resolve-before-authorize: a cross-tenant or unknown run id is
   * a 404; a caller without `org.manage` is a 403. Read-only — nothing is written on any path.
   */
  @Get(':runId')
  @RequireCapability('org.manage')
  async detail(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('runId') runId: string,
  ): Promise<WorkflowRunDetailView> {
    // Resolve BEFORE authorize: tenant-scoped, so a cross-tenant/unknown id is a 404, not a 403.
    const run = await this.database.read(context, (runner) =>
      this.history.findById(runner, context, runId),
    );
    if (!run) {
      throw new ApiError(404, 'not_found', MESSAGES.notFound, undefined, 'workflow_run_not_found');
    }

    if (!this.mayManageOrg(principal, context)) {
      throw new ApiError(
        403,
        'forbidden',
        MESSAGES.forbidden,
        undefined,
        'workflow_run_detail_denied',
      );
    }

    return toDetailView(run);
  }

  /** Org-scoped deny-by-default decision the route guard cannot make (membership status, etc.). */
  private mayManageOrg(principal: Principal, context: TenantContext): boolean {
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

function validateStatusFilter(raw: string | undefined): WorkflowRunStatus | undefined {
  if (raw === undefined) return undefined;
  if (!isRunStatus(raw)) {
    throw new ApiError(
      400,
      'validation_failed',
      'The request query is invalid',
      [{ field: 'status', message: `must be one of ${WORKFLOW_RUN_STATUSES.join(', ')}` }],
      'workflow_run_status_off_list',
    );
  }
  return raw;
}

function isRunStatus(value: unknown): value is WorkflowRunStatus {
  return typeof value === 'string' && (WORKFLOW_RUN_STATUSES as readonly string[]).includes(value);
}
