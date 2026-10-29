import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put } from '@nestjs/common';
import type { Principal } from '@tmanage/domain';
import { Ctx, CurrentPrincipal, RequireCapability } from '../../common/http/decorators.js';
import { ApiError, MESSAGES } from '../../common/http/errors.js';
import { INSIGHT_CUSTOM_REPORTS_SERVICE } from '../../common/http/tokens.js';
import {
  INSIGHT_CUSTOM_REPORT_LAYOUTS,
  INSIGHT_CUSTOM_REPORT_METRICS,
} from '../../common/database/schema.js';
import type {
  InsightCustomReportLayout,
  InsightCustomReportMetric,
  InsightCustomReportMetricKeys,
  InsightCustomReportRow,
} from '../../common/database/schema.js';
import type { TenantContext } from '../../common/database/tenant-context.js';
import type { InsightCustomReportsService } from './custom-reports.service.js';

/**
 * INS custom reports (x320) — a member composes, names, reads back and edits a custom insight report
 * (module 15 Insights & reporting, custom reports; screen: 22-SCREEN §Insights).
 *
 * ## Own reports only, and the capability reused rather than invented
 *
 * Every route is behind **`work.read`** — the internal-read capability the sibling insights reads
 * reuse (x210/x230), reused rather than a new capability so this slice stays off `capabilities.ts` and
 * the role grid (pass 26 forbids editing the ceiling). A caller without `work.read` (a client
 * principal) is refused by the global `CapabilityGuard` with a 403 before any handler runs, so nothing
 * is written. No route reads an `organizationId` or an owner from anywhere: the tenant and the acting
 * user are the `TenantContextGuard`'s, and a report is always the acting user's own. A report is
 * private to its creator, so an id that names another user's report (or none) is a 404 on read,
 * replace and delete — its existence is not the caller's to learn.
 *
 * ## Validation is here (400), not in the store
 *
 * `name` must be a non-empty string (≤300), `metricKeys` a non-empty ordered array of keys all on the
 * `INSIGHT_CUSTOM_REPORT_METRICS` allowlist, and `layout` one of the `INSIGHT_CUSTOM_REPORT_LAYOUTS`
 * vocabulary. An empty name, an empty selection, any off-allowlist metric key, or an unknown layout is
 * a 400 and nothing is written — composition over already-built metrics, so an unknown key is refused
 * before any read.
 *
 * ## Rendering is composition, read-only
 *
 * The by-id read resolves the report (tenant + owner) then renders each selected metric via the
 * existing insights read services (`InsightsService.orgWorkload`) — no new metric is computed.
 */

/** A custom report as the screen reads it — paired Exact with the web `InsightCustomReportView`. */
export interface InsightCustomReportView {
  readonly id: string;
  readonly ownerUserId: string;
  readonly name: string;
  readonly metricKeys: readonly InsightCustomReportMetric[];
  readonly layout: InsightCustomReportLayout;
  readonly createdAt: string;
}

/**
 * A report with its metrics rendered against the current figures — the by-id read. Paired Exact with
 * the web `InsightCustomReportRenderedView`. `metrics` is the report's ordered selection resolved to
 * live values (an inline element shape, not a standalone exported projection).
 */
export interface InsightCustomReportRenderedView {
  readonly report: InsightCustomReportView;
  readonly metrics: readonly {
    readonly metric: InsightCustomReportMetric;
    readonly value: number;
  }[];
}

/**
 * The list response wrapper — the caller's own reports. Deliberately not an exported `*View`: the web
 * client unwraps it to the array, so the one paired projection is `InsightCustomReportView`.
 */
type InsightCustomReportsResponse = { readonly reports: readonly InsightCustomReportView[] };

function isMetric(value: unknown): value is InsightCustomReportMetric {
  return (
    typeof value === 'string' &&
    (INSIGHT_CUSTOM_REPORT_METRICS as readonly string[]).includes(value)
  );
}

function isLayout(value: unknown): value is InsightCustomReportLayout {
  return (
    typeof value === 'string' &&
    (INSIGHT_CUSTOM_REPORT_LAYOUTS as readonly string[]).includes(value)
  );
}

/** Parse and validate a create/replace body into the stored input, or throw a 400 with per-field details. */
function parseBody(body: unknown): {
  name: string;
  metricKeys: InsightCustomReportMetricKeys;
  layout: InsightCustomReportLayout;
} {
  const details: { field: string; message: string }[] = [];
  const value = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const rawName = value['name'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (name === '') details.push({ field: 'name', message: 'must be a non-empty string' });
  if (name.length > 300) details.push({ field: 'name', message: 'must be at most 300 characters' });

  const rawKeys = value['metricKeys'];
  const metricKeys: InsightCustomReportMetric[] = [];
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    details.push({ field: 'metricKeys', message: 'must be a non-empty array of metric keys' });
  } else {
    for (const [index, key] of rawKeys.entries()) {
      if (!isMetric(key)) {
        details.push({
          field: `metricKeys.${index}`,
          message: `must be one of ${INSIGHT_CUSTOM_REPORT_METRICS.join(', ')}`,
        });
      } else {
        metricKeys.push(key);
      }
    }
  }

  const layout = value['layout'];
  if (!isLayout(layout)) {
    details.push({
      field: 'layout',
      message: `must be one of ${INSIGHT_CUSTOM_REPORT_LAYOUTS.join(', ')}`,
    });
  }

  if (details.length > 0 || !isLayout(layout)) {
    throw new ApiError(400, 'validation_failed', 'The custom report is invalid', details);
  }

  return { name, metricKeys, layout };
}

function viewOf(row: InsightCustomReportRow): InsightCustomReportView {
  return {
    id: row.id,
    ownerUserId: row.ownerUserId,
    name: row.name,
    metricKeys: row.metricKeys,
    layout: row.layout,
    createdAt: row.createdAt.toISOString(),
  };
}

@Controller('v1/organizations/:orgSlug/insights/custom-reports')
export class InsightCustomReportsController {
  constructor(
    @Inject(INSIGHT_CUSTOM_REPORTS_SERVICE)
    private readonly reports: InsightCustomReportsService,
  ) {}

  /** List the acting user's custom reports (200). */
  @Get()
  @RequireCapability('report.view')
  async list(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
  ): Promise<InsightCustomReportsResponse> {
    const rows = await this.reports.listOwn(context);
    return { reports: rows.map(viewOf) };
  }

  /** Create a custom report owned by the acting user (201). Bad name/keys/layout → 400, no write. */
  @Post()
  @RequireCapability('report.view')
  @HttpCode(201)
  async create(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Body() body: unknown,
  ): Promise<InsightCustomReportView> {
    const input = parseBody(body);
    const row = await this.reports.create(context, input);
    return viewOf(row);
  }

  /**
   * Read one report by id with its metrics rendered against the current figures (200). Own-scoped: an
   * id that names another user's report (or none) is a 404 — a private report's existence is not the
   * caller's to learn.
   */
  @Get(':reportId')
  @RequireCapability('report.view')
  async getById(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() principal: Principal,
    @Param('reportId') reportId: string,
  ): Promise<InsightCustomReportRenderedView> {
    const row = await this.reports.findOwn(context, reportId);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    const metrics = await this.reports.render(context, principal, row);
    return { report: viewOf(row), metrics };
  }

  /**
   * Replace a report's editable fields by id (200), idempotent. Own-scoped: an id that names another
   * user's report (or none) is a 404, and a bad body is a 400 with no write.
   */
  @Put(':reportId')
  @RequireCapability('report.view')
  async replace(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('reportId') reportId: string,
    @Body() body: unknown,
  ): Promise<InsightCustomReportView> {
    const input = parseBody(body);
    const row = await this.reports.replaceOwn(context, reportId, input);
    if (!row) throw new ApiError(404, 'not_found', MESSAGES.notFound);
    return viewOf(row);
  }

  /**
   * Delete a report by id (204). Own-scoped: an id that names another user's report (or none) removes
   * nothing and answers 404 — a private report's existence is not the caller's to learn.
   */
  @Delete(':reportId')
  @RequireCapability('report.view')
  @HttpCode(204)
  async remove(
    @Ctx() context: TenantContext,
    @CurrentPrincipal() _principal: Principal,
    @Param('reportId') reportId: string,
  ): Promise<void> {
    const removed = await this.reports.deleteOwn(context, reportId);
    if (!removed) throw new ApiError(404, 'not_found', MESSAGES.notFound);
  }
}
