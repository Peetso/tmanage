import type { Principal } from '@tmanage/domain';
import type {
  InsightCustomReportMetric,
  InsightCustomReportRow,
} from '../../common/database/schema.js';
import type { TenantContext, TenantDatabase } from '../../common/database/tenant-context.js';
import type { InsightsService } from './insights.service.js';
import { InsightCustomReportsRepository } from './custom-reports.repository.js';
import type { InsightCustomReportInsert } from './custom-reports.repository.js';

/** The fields a create/replace carries, re-exported from the repository for the controller's use. */
export type InsightCustomReportInput = InsightCustomReportInsert;

/** One rendered metric — a metric key resolved to its current org-wide value. */
export interface RenderedMetric {
  readonly metric: InsightCustomReportMetric;
  readonly value: number;
}

/**
 * INS custom reports (x320) — the create/list/get/replace/delete orchestration for a member's own
 * composed insight reports over the tenant transaction wrapper, plus the live render of a report's
 * selected metrics.
 *
 * Every operation is scoped by `(organization_id, owner_user_id = context.userId)` in the repository:
 * a report is private to its creator, so a caller can only ever create, list, read, replace or remove
 * their own reports. `owner_user_id` is `context.userId`, resolved once per request by the tenant
 * guard and never a body value. Rendering is composition over already-built metrics: it reuses
 * {@link InsightsService.orgWorkload} — the same code the live workload screen runs — and maps each
 * selected metric key to its current figure. No new metric is computed here.
 */
export class InsightCustomReportsService {
  constructor(
    private readonly database: TenantDatabase,
    private readonly insights: InsightsService,
    private readonly reports: InsightCustomReportsRepository = new InsightCustomReportsRepository(),
  ) {}

  /** Create a report owned by the acting user and return the stored row. */
  async create(
    context: TenantContext,
    input: InsightCustomReportInput,
  ): Promise<InsightCustomReportRow> {
    return this.database.transaction(context, async (tx) => {
      const id = await this.reports.create(tx, context, input);
      const row = await this.reports.findOwn(tx, context, id);
      // The row was just inserted in this same transaction, so its absence is impossible; the check
      // keeps the return type honest rather than asserting non-null.
      if (!row) {
        throw new Error('insight_custom_reports: inserted row not found in its own transaction');
      }
      return row;
    });
  }

  /** The acting user's reports in this studio. */
  async listOwn(context: TenantContext): Promise<InsightCustomReportRow[]> {
    return this.database.read(context, (runner) => this.reports.listOwn(runner, context));
  }

  /** One report by id, scoped to the acting user — `null` when not found (→ 404). */
  async findOwn(context: TenantContext, id: string): Promise<InsightCustomReportRow | null> {
    return this.database.read(context, (runner) => this.reports.findOwn(runner, context, id));
  }

  /**
   * Replace a report's editable fields by id, scoped to the acting user, and return the stored row.
   * `null` when the id names no report of the caller's (→ 404). Idempotent: replacing with the same
   * values yields the same row.
   */
  async replaceOwn(
    context: TenantContext,
    id: string,
    input: InsightCustomReportInput,
  ): Promise<InsightCustomReportRow | null> {
    return this.database.transaction(context, async (tx) => {
      const updated = await this.reports.replaceOwn(tx, context, id, input);
      if (!updated) return null;
      return this.reports.findOwn(tx, context, id);
    });
  }

  /** Delete a report by id, scoped to the acting user. `false` when nothing was removed (→ 404). */
  async deleteOwn(context: TenantContext, id: string): Promise<boolean> {
    return this.database.transaction(context, (tx) => this.reports.deleteOwn(tx, context, id));
  }

  /**
   * Render a report's selected metrics against the current figures. Reuses
   * {@link InsightsService.orgWorkload} once (the same code the live screen runs) and maps each metric
   * key in the report's stored order to its current value, so the render is exactly what the live
   * screen would show. Read-only: nothing is written.
   */
  async render(
    context: TenantContext,
    principal: Principal,
    report: InsightCustomReportRow,
  ): Promise<readonly RenderedMetric[]> {
    const workload = await this.insights.orgWorkload(context, principal);
    const current: Record<InsightCustomReportMetric, number> = {
      open_items: workload.totals.openItemCount,
      scheduled_items: workload.totals.scheduledItemCount,
      active_projects: workload.totals.projectCount,
      active_assignees: workload.totals.assigneeCount,
    };
    return report.metricKeys.map((metric) => ({ metric, value: current[metric] }));
  }
}
