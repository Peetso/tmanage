import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INSIGHT_SAVED_VIEWS_SERVICE } from '../../common/http/tokens.js';
import { INSIGHT_REPORT_KINDS } from '../../common/database/schema.js';
import type {
  InsightReportKind,
  InsightSavedViewRow,
  InsightViewFilters,
} from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightSavedViewsService } from './saved-views.service.js';

/**
 * INS saved views (x210) — a member names, saves and re-opens an insights report configuration
 * (module 15 Insights & reporting).
 *
 * ## Own views only, and the capability reused rather than invented
 *
 * All three routes are behind **`work.read`** — the internal-read capability the sibling insights
 * reads use, reused rather than a new `insights.write` so this slice stays off `capabilities.ts` and
 * the role grid (`12-PERMISSION-MATRIX` names no such capability, and pass 22 forbids editing the
 * ceiling). A caller without `work.read` (a client principal) is refused by the global
 * `CapabilityGuard` with a 403 before any handler runs. None of the routes reads an `organizationId`
 * or an owner from anywhere: the tenant and the acting user are the `TenantContextGuard`'s, and a
 * view is always the acting user's own. A view is private to its creator this slice, so a delete that
 * names another user's view (or none) is a 404 — its existence is not the caller's to learn (the
 * Known-trap on the id route).
 *
 * ## Validation is here (400), not in the store
 *
 * `report_kind` is validated against the closed `INSIGHT_REPORT_KINDS` vocabulary and `name`/`filters`
 * against their shapes: an unknown kind, an empty name or a non-string filter value is a 400 and
 * nothing is written — the same division `a11y.controller.ts` uses. `filters` is stored whole and
 * echoed back, not interpreted here.
 */

/** A saved insights view as the screen reads it — paired Exact with the web `InsightSavedViewView`. */
export interface InsightSavedViewView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly reportKind: InsightReportKind;
  readonly filters: InsightViewFilters;
  readonly createdAt: string;
}

/**
 * The list/mutation response wrapper — the caller's own views. Deliberately **not** an exported
 * `*View` interface: the contracts gate enumerates every exported response projection under the API
 * modules, and the wrapper is not a standalone paired shape — the web client unwraps it to the array,
 * so the one paired projection is `InsightSavedViewView`. Written as an inline type on each route.
 */
type InsightSavedViewsResponse = { readonly savedViews: readonly InsightSavedViewView[] };

function isReportKind(value: unknown): value is InsightReportKind {
  return typeof value === 'string' && (INSIGHT_REPORT_KINDS as readonly string[]).includes(value);
}

/** Parse and validate a create body into the stored input, or throw a 400 with per-field details. */
function parseCreate(body: unknown): {
  name: string;
  reportKind: InsightReportKind;
  filters: InsightViewFilters;
} {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const rawName = value['name'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name === '') details.push({ field: 'name', message: 'must be a non-empty string' });
  if (name.length > 300) details.push({ field: 'name', message: 'must be at most 300 characters' });

  const reportKind = value['reportKind'];
  if (!isReportKind(reportKind)) {
    details.push({
      field: 'reportKind',
      message: `must be one of ${INSIGHT_REPORT_KINDS.join(', ')}`,
    });
  }

  const rawFilters = value['filters'];
  const filters: Record<string, string> = {};
  if (typeof rawFilters !== 'object' || rawFilters === null || Array.isArray(rawFilters)) {
    details.push({ field: 'filters', message: 'must be an object of string values' });
  } else {
    for (const [key, filterValue] of Object.entries(rawFilters)) {
      if (typeof filterValue !== 'string') {
        details.push({ field: `filters.${key}`, message: 'must be a string' });
      } else {
        filters[key] = filterValue;
      }
    }
  }

  if (details.length > 0 || !isReportKind(reportKind)) {
    throw new ApiError(400, 'validation_failed', 'The saved view is invalid', details);
  }

  return { name, reportKind, filters };
}

function viewOf(row: InsightSavedViewRow): InsightSavedViewView {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    reportKind: row.reportKind,
    filters: row.filters,
    createdAt: row.createdAt.toISOString(),
  };
}

@Controller('v1/organizations/:orgSlug/insights/saved-views')
export class InsightSavedViewsController {
  constructor(
    @Inject(INSIGHT_SAVED_VIEWS_SERVICE)
    private readonly savedViews: InsightSavedViewsService,
  ) {}

  /** List the acting user's saved insights views (200). */
  @Get()
  @RequireCapability('report.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<InsightSavedViewsResponse> {
    const rows = await this.savedViews.listOwn(context);
    return { savedViews: rows.map(viewOf) };
  }

  /** Create a saved view owned by the acting user (201). Unknown report kind → 400. */
  @Post()
  @RequireCapability('report.view')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Body() body: unknown,
  ): Promise<InsightSavedViewView> {
    const input = parseCreate(body);
    const row = await this.savedViews.create(context, input);
    return viewOf(row);
  }

  /**
   * Delete a saved view by id (200). Own-scoped: an id that names another user's view (or no view)
   * removes nothing and answers 404 — a private view's existence is not the caller's to learn.
   */
  @Delete(':viewId')
  @RequireCapability('report.view')
  @HttpCode(200)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('viewId') viewId: string,
  ): Promise<InsightSavedViewsResponse> {
    const removed = await this.savedViews.deleteOwn(context, viewId);
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const rows = await this.savedViews.listOwn(context);
    return { savedViews: rows.map(viewOf) };
  }
}
